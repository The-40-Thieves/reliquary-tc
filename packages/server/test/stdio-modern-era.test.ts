// Stdio serves both protocol revisions from one entry (serveStdioEras, transports/stdio.ts). The
// client's opening message picks the era, and each era gets its own server from the builder below,
// which mirrors the production call in runtime/server-runtime.ts. These assertions are the contract:
// do not weaken them to match an observed value.

import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { serveStdioEras } from "../src/transports/stdio";
import { stallTimeout } from "./stall-timeouts";
import { stdioTestBuilder } from "./stdio-test-server";
import { makeTempDir, rmTemp } from "./tmp";

const LEGACY = "2025-11-25";
const MODERN = "2026-07-28";
const WAIT_MS = 4_000;
const SUBSCRIBED_URI = "reliquary-tc://v1/a.md";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "stdio-modern-era-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

type Msg = Record<string, any>;

interface Harness {
  stdin: PassThrough;
  stdout: PassThrough;
  msgs: Msg[];
  builds: string[];
  counts: { handshake: number; eof: number };
  errors: string[];
  handle: { close(): Promise<void> };
  send(message: object): void;
  request(id: number, method: string, params?: object): Promise<Msg>;
  waitMsg(pred: (m: Msg) => boolean, what: string): Promise<Msg>;
}

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmTemp(d);
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function harness(opts: { confirmTool?: string } = {}): Harness {
  const root = makeTempDir("stdio-modern-era-");
  tmpRoots.push(root);
  const builds: string[] = [];
  const build = stdioTestBuilder({
    tool: "probe",
    result: { ok: true },
    vaultRoot: root,
    confirmTool: opts.confirmTool,
  });
  const counts = { handshake: 0, eof: 0 };
  const errors: string[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const msgs: Msg[] = [];
  // readline re-emits stdout's errors on the Interface, which would throw with no listener of its
  // own; the transport handles the same error on stdout itself.
  createInterface({ input: stdout })
    .on("line", (line) => msgs.push(JSON.parse(line)))
    .on("error", () => {});
  const handle = serveStdioEras(
    (era) => {
      builds.push(era);
      return build(era);
    },
    {
      io: { stdin, stdout },
      onHandshake: () => {
        counts.handshake++;
      },
      onEof: () => {
        counts.eof++;
      },
      onError: (e) => {
        errors.push(e.message);
      },
    },
  );
  const send = (message: object) => {
    stdin.write(`${JSON.stringify(message)}\n`);
  };
  const waitMsg = async (pred: (m: Msg) => boolean, what: string): Promise<Msg> => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no stdio line for ${what} within ${WAIT_MS}ms`);
      await sleep(10);
    }
  };
  const request = async (id: number, method: string, params: object = {}): Promise<Msg> => {
    send({ jsonrpc: "2.0", id, method, params });
    return waitMsg(
      (m) => m.id === id && ("result" in m || "error" in m),
      `${method} reply (id ${id})`,
    );
  };
  return { stdin, stdout, msgs, builds, counts, errors, handle, send, request, waitMsg };
}

async function legacyInit(h: Harness, id: number): Promise<Msg> {
  const init = await h.request(id, "initialize", {
    protocolVersion: LEGACY,
    capabilities: {},
    clientInfo: { name: "stdio-modern-era-test", version: "1" },
  });
  h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return init;
}

const discover = (h: Harness, id: number) =>
  h.request(id, "server/discover", { _meta: MODERN_META });

const modernList = (h: Harness, id: number, method: string) =>
  h.request(id, method, { _meta: MODERN_META });

/** A modern tools/call on the confirmation-gated tool, carrying the client's per-request capabilities. */
const callConfirm = (h: Harness, id: number, clientCapabilities: object) =>
  h.request(id, "tools/call", {
    name: "confirm_write",
    arguments: {},
    _meta: { ...MODERN_META, "io.modelcontextprotocol/clientCapabilities": clientCapabilities },
  });

/** Opens a session with `setup`, ends stdin, and expects onEof to have fired exactly once. */
async function expectEofOnce(setup: (h: Harness) => Promise<unknown>): Promise<void> {
  const h = harness();
  try {
    await setup(h);
    h.stdin.end();
    await sleep(200);
    expect(h.counts.eof).toBe(1);
  } finally {
    await h.handle.close();
  }
}

describe("stdio serves both protocol revisions, chosen by the opening message", () => {
  it(
    "control: a legacy client gets a tools list after initialize 2025-11-25, with no cache hints",
    async () => {
      const h = harness();
      try {
        const init = await legacyInit(h, 1);
        expect(init.error).toBeUndefined();
        expect(init.result.protocolVersion).toBe(LEGACY);
        expect(init.result.capabilities.resources.subscribe).toBe(true);
        const list = await h.request(2, "tools/list");
        expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("probe");
        expect(list.result.ttlMs).toBeUndefined();
      } finally {
        await h.handle.close();
      }
    },
    stallTimeout(20_000),
  );

  it(
    "a modern client's server/discover succeeds, names 2026-07-28, and does not offer resource subscriptions",
    async () => {
      const h = harness();
      try {
        const r = await discover(h, 1);
        expect(r.error).toBeUndefined();
        expect(r.result.supportedVersions).toContain(MODERN);
        expect(r.result.capabilities.resources?.subscribe).toBeUndefined();
      } finally {
        await h.handle.close();
      }
    },
    stallTimeout(20_000),
  );

  it(
    "a modern client's tools/list and resources/list carry a numeric ttlMs and a cacheScope",
    async () => {
      const h = harness();
      try {
        await discover(h, 1);
        const tools = await modernList(h, 2, "tools/list");
        const resources = await modernList(h, 3, "resources/list");
        for (const r of [tools, resources]) {
          expect(r.error).toBeUndefined();
          expect(typeof r.result.ttlMs).toBe("number");
          expect(["public", "private"]).toContain(r.result.cacheScope);
        }
        expect(tools.result.tools.length).toBeGreaterThan(0);
      } finally {
        await h.handle.close();
      }
    },
    stallTimeout(20_000),
  );

  it(
    "initialize naming 2026-07-28 without the envelope is negotiated down to 2025-11-25 by the legacy path",
    async () => {
      const h = harness();
      try {
        const r = await h.request(1, "initialize", {
          protocolVersion: MODERN,
          capabilities: {},
          clientInfo: { name: "stdio-modern-era-test", version: "1" },
        });
        expect(r.error).toBeUndefined();
        expect(r.result.protocolVersion).toBe(LEGACY);
        expect(h.builds).toEqual(["legacy"]);
      } finally {
        await h.handle.close();
      }
    },
    stallTimeout(20_000),
  );

  it(
    "modern probe then legacy initialize on one connection: both eras built, legacy serves, onEof not called, onHandshake once",
    async () => {
      const h = harness();
      try {
        await discover(h, 1);
        await legacyInit(h, 2);
        const list = await h.request(3, "tools/list");
        expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("probe");
        expect(h.builds).toEqual(["modern", "legacy"]);
        expect(h.counts.eof).toBe(0);
        expect(h.counts.handshake).toBe(1);
      } finally {
        await h.handle.close();
      }
    },
    stallTimeout(20_000),
  );
});

describe("stdio disconnect is reported once, and only for a real disconnect", () => {
  it(
    "stdin end on a legacy session calls onEof exactly once",
    async () => {
      await expectEofOnce((h) => legacyInit(h, 1));
    },
    stallTimeout(20_000),
  );

  it(
    "stdin end on a modern session calls onEof exactly once",
    async () => {
      await expectEofOnce(async (h) => {
        await discover(h, 1);
        await modernList(h, 2, "tools/list");
      });
    },
    stallTimeout(20_000),
  );

  it(
    "our own close() does not call onEof",
    async () => {
      const h = harness();
      await legacyInit(h, 1);
      await h.handle.close();
      await sleep(200);
      expect(h.counts.eof).toBe(0);
    },
    stallTimeout(20_000),
  );

  it(
    "modern stdio does not acknowledge resourceSubscriptions while resources.subscribe is not offered",
    async () => {
      const h = harness();
      try {
        await discover(h, 1);
        h.send({
          jsonrpc: "2.0",
          id: 2,
          method: "subscriptions/listen",
          params: {
            notifications: { resourceSubscriptions: [SUBSCRIBED_URI] },
            _meta: MODERN_META,
          },
        });
        const ack = await h.waitMsg(
          (m) =>
            m.method === "notifications/subscriptions/acknowledged" || (m.id === 2 && "error" in m),
          "subscriptions/listen acknowledgement",
        );
        expect(ack.error).toBeUndefined();
        expect(ack.params?.notifications?.resourceSubscriptions).toBeUndefined();
      } finally {
        await h.handle.close();
      }
    },
    stallTimeout(20_000),
  );
});

describe("stdio fatal wire close and per-request client capabilities", () => {
  it(
    "an input line over the transport's buffer limit calls onEof exactly once",
    async () => {
      const h = harness();
      try {
        await legacyInit(h, 1);
        // One chunk just over the SDK's 10 MiB read buffer, with no newline. The transport closes
        // itself on that overflow, and stdin never emits end: this is the only disconnect signal.
        h.stdin.write(Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
        await sleep(300);
        expect(h.counts.eof).toBe(1);
      } finally {
        await h.handle.close();
      }
    },
    stallTimeout(20_000),
  );

  it(
    "a stdout write error calls onEof exactly once",
    async () => {
      const h = harness();
      try {
        await discover(h, 1);
        // A broken pipe on stdout: the transport closes itself, and stdin never emits end.
        h.stdout.emit("error", new Error("EPIPE"));
        await sleep(300);
        expect(h.counts.eof).toBe(1);
      } finally {
        await h.handle.close();
      }
    },
    stallTimeout(20_000),
  );

  it(
    "a modern client that declares form elicitation gets input_required for a confirmation-gated call",
    async () => {
      const h = harness({ confirmTool: "confirm_write" });
      try {
        await discover(h, 1);
        const r = await callConfirm(h, 2, { elicitation: { form: {} } });
        expect(r.error).toBeUndefined();
        expect(r.result.resultType).toBe("input_required");
        const entries = Object.values(r.result.inputRequests ?? {}) as Msg[];
        expect(entries).toHaveLength(1);
        expect(entries[0]?.method).toBe("elicitation/create");
        expect(Object.keys(entries[0]?.params?.requestedSchema?.properties ?? {})).toEqual([
          "approve",
        ]);
      } finally {
        await h.handle.close();
      }
    },
    stallTimeout(20_000),
  );

  it(
    "control: the same call declaring no elicitation capability does not get input_required",
    async () => {
      const h = harness({ confirmTool: "confirm_write" });
      try {
        await discover(h, 1);
        const r = await callConfirm(h, 2, {});
        expect(r.result?.resultType).not.toBe("input_required");
        expect(JSON.stringify(r)).toContain("elicit_required");
      } finally {
        await h.handle.close();
      }
    },
    stallTimeout(20_000),
  );
});
