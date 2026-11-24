import type { Readable, Writable } from "node:stream";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { createMcpServer } from "../mcp/server";

export interface StdioEraOptions {
  /** Test seam: in-memory streams in place of the process's stdin and stdout. */
  io?: { stdin: Readable; stdout: Writable };
  /** Fires at most once per connection, when the client's handshake (or first modern request) lands. */
  onHandshake?: () => void;
  /** Fires at most once, when the input stream ends. Never fires for our own close(). */
  onEof?: () => void;
  /** Receives transport and protocol errors the SDK reports. */
  onError?: (error: Error) => void;
}

/**
 * Serve MCP over stdio, both protocol revisions. The SDK's `serveStdio` reads the client's opening
 * message and builds a server instance for the era it names: a 2025 `initialize` or a claim-less
 * request gets the "legacy" instance, a 2026-07-28 envelope gets "modern". A client that probes
 * with a modern `server/discover` and then opens with a legacy `initialize` gets both in turn: the
 * modern instance is closed and a legacy one is built. After that the era does not change.
 *
 * Disconnect is read from the input stream itself, not from an instance's `onclose`: that
 * discarded probe instance also closes, and that must not look like a disconnect.
 */
export function serveStdioEras(
  build: (era: "legacy" | "modern") => ReturnType<typeof createMcpServer>,
  opts: StdioEraOptions = {},
): { close(): Promise<void> } {
  let handshaken = false;
  const handshake = () => {
    if (handshaken) return;
    handshaken = true;
    opts.onHandshake?.();
  };
  const factory = ({ era }: { era: "legacy" | "modern" }) => {
    const server = build(era);
    if (era === "legacy") server.oninitialized = handshake;
    // A modern client sends no `initialize`; its first request is the handshake.
    else setImmediate(handshake);
    return server;
  };

  const stdin = opts.io?.stdin ?? process.stdin;
  let closing = false;
  let eofFired = false;
  const onEnd = () => {
    if (eofFired || closing) return;
    eofFired = true;
    opts.onEof?.();
  };
  stdin.on("end", onEnd);
  stdin.on("close", onEnd);

  const handle = serveStdio(factory, {
    transport: new StdioServerTransport(opts.io?.stdin, opts.io?.stdout),
    onerror: opts.onError,
  });
  return {
    close: async () => {
      closing = true;
      stdin.off("end", onEnd);
      stdin.off("close", onEnd);
      await handle.close();
    },
  };
}
