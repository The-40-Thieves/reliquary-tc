// The stdio transport of the server runtime (config.transports.stdio). Serves both protocol
// revisions over the process's stdio, hands the client's handshake to the boot warmups, and treats
// the end of stdin as a disconnect. Kept beside server-runtime.ts so that file stays under the line
// ceiling; it must not import from server-runtime.ts.

import type { ServerConfig } from "@the-40-thieves/reliquary-tc-shared";
import type { createMcpServer } from "../mcp/server";
import { serveStdioEras } from "../transports/stdio";
import { logShutdownError } from "./shutdown-phase";

export interface StdioServing {
  /** Resolves on the client's handshake (legacy `initialized`, or a modern first request). */
  initialized: Promise<void>;
  close(): Promise<void>;
}

export interface StdioWiringDeps {
  config: ServerConfig;
  buildStdioServer: (era: "legacy" | "modern") => ReturnType<typeof createMcpServer>;
  /** The runtime's own bounded shutdown; every signal and the stdin end go through it. */
  close: (reason: string) => Promise<void>;
}

/** Opens the stdio transport. The caller checks `config.transports.stdio` first. */
export function startStdioServing(deps: StdioWiringDeps): StdioServing {
  let resolveInitialized: () => void = () => {};
  const initialized = new Promise<void>((resolve) => {
    resolveInitialized = resolve;
  });
  const handle = serveStdioEras(deps.buildStdioServer, {
    onHandshake: resolveInitialized,
    onEof: () => onStdinEnd(deps),
  });
  return { initialized, close: () => handle.close() };
}

/**
 * GH #995: a stdio client disconnecting closes stdin. This routes that through the SAME bounded
 * close() every signal uses. Fix (headless HTTP deploy crash-loop): the same EOF fires when stdin is
 * simply absent (`docker run -d`, a compose service without `stdin_open: true`, a systemd unit). When
 * HTTP is also enabled, closing the whole process would take its listener down too, so the process
 * keeps serving HTTP. process.exit is reserved for stdio being the SOLE transport. stdio and HTTP
 * each get their own McpServer instance (see wireTransports/createMcpServer in transport-wiring.ts),
 * so this cannot tear down an HTTP session.
 */
function onStdinEnd(deps: StdioWiringDeps): void {
  if (deps.config.transports.http.enabled) {
    process.stderr.write(
      "reliquary-tc: stdin closed (stdio transport EOF) — HTTP transport still serving; " +
        "continuing HTTP-only (set transports.stdio: false to silence this for headless " +
        "deploys)\n",
    );
    return;
  }
  void deps
    .close("transport:stdio-eof") // F3: close() can REJECT — mirrors shutdown.ts's guard
    .catch(logShutdownError)
    .finally(() => process.exit(0));
}
