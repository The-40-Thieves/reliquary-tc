// GH #1457: the runtime's own shutdown closes the stdio session that `sessions.autoOpen` opened.
// The real buildServerRuntime runs its stdio transport over in-memory streams (serveStdioEras is
// swapped for one wired to them), so one tools/call opens the implicit row through the production
// composition, and close() must end it rather than leave it to the window sweep. The second test
// proves the same production wiring passes the protocol era through: a modern client gets the
// SEP-2549 cache hints on tools/list.
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { openDatabase } from "../src/db/open";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { stallTimeout } from "./stall-timeouts";
import { awaitStdioReply, collectStdioReplies } from "./stdio-reply-reader";
import { makeTempDir, rmTemp } from "./tmp";

const io = vi.hoisted(() => ({
  stdin: undefined as PassThrough | undefined,
  stdout: undefined as PassThrough | undefined,
}));

vi.mock("../src/transports/stdio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transports/stdio")>();
  return {
    ...actual,
    serveStdioEras: (build: Parameters<typeof actual.serveStdioEras>[0], opts = {}) => {
      if (!io.stdin || !io.stdout) throw new Error("test stdio streams are not set");
      return actual.serveStdioEras(build, { ...opts, io: { stdin: io.stdin, stdout: io.stdout } });
    },
  };
});

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "runtime-close-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmTemp(d);
});

/** The production runtime over the in-memory stdio streams, with a request helper on them. */
async function startRuntime(autoOpen: boolean) {
  const vaultDir = makeTempDir("obtc-runtime-close-vault-");
  const cacheDir = makeTempDir("obtc-runtime-close-cache-");
  tmpRoots.push(vaultDir, cacheDir);
  const config = configFromVaultPath(vaultDir);
  config.cacheDir = cacheDir;
  config.sessions = { ...config.sessions, autoOpen, windowSeconds: 1800 };

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  io.stdin = stdin;
  io.stdout = stdout;
  const replies = collectStdioReplies(stdout);
  const send = (msg: object) => stdin.write(`${JSON.stringify(msg)}\n`);
  const request = (id: number, method: string, params: object) => {
    send({ jsonrpc: "2.0", id, method, params });
    return awaitStdioReply(replies, id, method);
  };

  const runtime = await buildServerRuntime(config, undefined);
  await runtime.start();
  return { runtime, cacheDir, send, request };
}

describe("ServerRuntime.close() ends the stdio session sessions.autoOpen opened", () => {
  it(
    "closes the implicit row the first tools/call opened, instead of leaving it to the sweep",
    async () => {
      const { runtime, cacheDir, send, request } = await startRuntime(true);
      await request(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "runtime-close-test", version: "1" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const called = await request(2, "tools/call", { name: "server_health", arguments: {} });
      expect(called.error).toBeUndefined();

      await runtime.close("test");

      const db = await openDatabase(join(cacheDir, "cache.db"));
      try {
        const all = db
          .prepare("SELECT caller, principal, ended_at FROM workspace_sessions")
          .all() as { caller: string | null; principal: string | null; ended_at: number | null }[];
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ caller: null, principal: "stdio" });
        expect(all[0]?.ended_at).not.toBeNull();
      } finally {
        db.close?.();
      }
    },
    stallTimeout(60_000),
  );

  it(
    "a modern client's tools/list over the production runtime carries ttlMs and cacheScope",
    async () => {
      const { runtime, request } = await startRuntime(false);
      try {
        const discovered = await request(1, "server/discover", { _meta: MODERN_META });
        expect(discovered.error).toBeUndefined();
        const list = await request(2, "tools/list", { _meta: MODERN_META });
        expect(list.error).toBeUndefined();
        expect(typeof list.result.ttlMs).toBe("number");
        expect(["public", "private"]).toContain(list.result.cacheScope);
      } finally {
        await runtime.close("test");
      }
    },
    stallTimeout(60_000),
  );
});
