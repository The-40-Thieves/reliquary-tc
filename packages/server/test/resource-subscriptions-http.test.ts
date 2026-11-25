// resources/updated over real HTTP (modern era only): a `subscriptions/listen` carrying
// `params.notifications.resourceSubscriptions` is answered by serveResourceSubscription, not the SDK
// handler, and every event is re-checked against the caller's own read permission.
//
// Shape of the proof: a NEGATIVE assertion ("no update for the note the caller cannot read") only
// means something if the same stream demonstrably delivers an update for a note it CAN read. So each
// case that asserts silence also asserts delivery on the same stream, and checks the silent publish
// first, so a late delivery cannot be mistaken for silence.

import { randomBytes } from "node:crypto";
import { linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/reliquary-tc-shared";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import {
  ADVISORY_SUBSCRIPTION_KEY,
  type AdvisoryBus,
  createAdvisoryBus,
} from "../src/mcp/advisories";
import {
  buildResourceUri,
  CATALOG_RESOURCE_URI,
  canReadResourceUri,
  RESOURCE_SCHEME,
  readResourceFor,
} from "../src/mcp/resources";
import { createHttpApp, type HttpApp } from "../src/transports/http";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { stallTimeout } from "./stall-timeouts";

const signingKey = randomBytes(32).toString("hex");
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const ACK = "notifications/subscriptions/acknowledged";
const UPDATED = "notifications/resources/updated";
const SUB_KEY = "io.modelcontextprotocol/subscriptionId";
const LISTEN_URL = "http://localhost/mcp";

type Frame = { jsonrpc: string; method?: string; params?: any; id?: unknown; error?: unknown };

const FILES = { "pub/a.md": "PUBLIC\n", "secret/b.md": "SECRET\n" };
const PUB = buildResourceUri("test", "pub/a.md");
const SECRET_NOTE = buildResourceUri("test", "secret/b.md");

// The vault's own ACL: only pub/** is readable. Root ACL is permissive; the per-vault override is
// what canRead must honour (registry.aclFor), exactly as resources/read does.
const vaults: TestVault[] = [];
const apps: HttpApp[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const v of vaults.splice(0)) v.cleanup();
});

function vault(): TestVault {
  const v = makeTestVault({ files: FILES, aclByVault: { test: { readPaths: ["pub/**"] } } });
  vaults.push(v);
  return v;
}

function boot(v: TestVault, advisoryBus?: AdvisoryBus): HttpApp {
  const auth = ServerConfigSchema.parse({
    vaults: [{ id: "test", path: v.root }],
    auth: { mode: "jwt", jwtSecret: signingKey, audience: "http://test", tokenTtlSeconds: 3600 },
  }).auth;
  const app = createHttpApp({
    vaultRegistry: v.vaultRegistry,
    vaultId: "test",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    db: v.db,
    auth,
    registry: v.registry,
    version: "0.0.0-test",
    name: "reliquary-tc",
    ...(advisoryBus ? { advisoryBus } : {}),
  });
  apps.push(app);
  return app;
}

/** A fresh vault with its app, and the change bus the test publishes on. */
function startVault() {
  const v = vault();
  return { bus: v.vaultRegistry.changes, app: boot(v) };
}

async function tokenFor(scopes: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "agent-1", scopes, aud: "http://test", iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(signingKey));
}

interface Listen {
  status: number;
  frames: Frame[];
  /** Every byte the response carried, for responses that are not an SSE stream. */
  raw: string;
  ended: () => boolean;
  waitFor: (pred: (frames: Frame[]) => boolean, ms?: number) => Promise<boolean>;
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForFrames(
  frames: Frame[],
  pred: (frames: Frame[]) => boolean,
  ms = 3000,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred(frames)) return true;
    await sleep(20);
  }
  return pred(frames);
}

function listenHeaders(jwt: string, modern: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${jwt}`,
    host: "localhost",
    "mcp-protocol-version": modern ? MODERN : LEGACY,
    ...(modern ? { "mcp-method": "subscriptions/listen" } : {}),
  };
}

function listenBody(uris: string[], modern: boolean, id: number, advisory = false): string {
  const notifications: Record<string, unknown> = { resourceSubscriptions: uris };
  if (advisory) notifications[ADVISORY_SUBSCRIPTION_KEY] = true;
  const params: Record<string, unknown> = { notifications };
  if (modern) {
    params._meta = {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientInfo": { name: "rs-sub-test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
  }
  return JSON.stringify({ jsonrpc: "2.0", id, method: "subscriptions/listen", params });
}

/** Parse every complete SSE block in `buf` into `frames`; returns the unparsed tail. */
function takeFrames(buf: string, frames: Frame[]): string {
  let cut = buf.indexOf("\n\n");
  while (cut >= 0) {
    const block = buf.slice(0, cut);
    buf = buf.slice(cut + 2);
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        frames.push(JSON.parse(line.slice(6)) as Frame);
      } catch {
        /* a partial frame cannot happen here: blocks are cut on the blank line */
      }
    }
    cut = buf.indexOf("\n\n");
  }
  return buf;
}

async function readFrames(res: Response, out: Listen): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      out.raw += chunk;
      buf = takeFrames(buf + chunk, out.frames);
    }
  } catch {
    /* aborted by stop(), or the server closed the connection */
  }
}

/** Open a `subscriptions/listen` for `uris` and read its stream in the background. `modern: false`
 *  sends the same request without the modern protocol header and `_meta` envelope. */
async function openListen(
  app: HttpApp,
  jwt: string,
  uris: string[],
  opts: { modern?: boolean; id?: number; advisory?: boolean } = {},
): Promise<Listen> {
  const modern = opts.modern !== false;
  const ac = new AbortController();
  const res = await app.app.request(LISTEN_URL, {
    method: "POST",
    signal: ac.signal,
    headers: listenHeaders(jwt, modern),
    body: listenBody(uris, modern, opts.id ?? 1, opts.advisory === true),
  });
  let ended = false;
  const out: Listen = {
    status: res.status,
    frames: [],
    raw: "",
    ended: () => ended,
    waitFor: (pred, ms) => waitForFrames(out.frames, pred, ms),
    stop: async () => {
      ac.abort();
      await pump;
    },
  };
  const pump = readFrames(res, out).finally(() => {
    ended = true;
  });
  return out;
}

const isAck = (f: Frame) => f.method === ACK;
const updateFor = (uri: string) => (f: Frame) => f.method === UPDATED && f.params?.uri === uri;

describe("resources/updated over HTTP (modern era)", () => {
  it(
    "(a) a caller with read access is acked, and an out-of-band publish reaches its stream for a note it can read",
    async () => {
      const { bus, app } = startVault();
      const s = await openListen(app, await tokenFor(["*"]), [PUB], { id: 1 });
      try {
        expect(s.status).toBe(200);
        expect(await s.waitFor((fs) => fs.some(isAck))).toBe(true);
        const ack = s.frames.find(isAck);
        expect(ack?.params?.notifications?.resourceSubscriptions).toEqual([PUB]);
        expect(ack?.params?._meta?.[SUB_KEY]).toBe(1);

        // The real case: nothing is in flight; the vault watcher's publish is the only trigger.
        bus.publish({ vaultId: "test", relPath: "pub/a.md" });

        expect(await s.waitFor((fs) => fs.some(updateFor(PUB)))).toBe(true);
        const update = s.frames.find(updateFor(PUB));
        expect(update?.params).toEqual({ uri: PUB, _meta: { [SUB_KEY]: 1 } });
      } finally {
        await s.stop();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "(b) a caller whose read ACL does not cover the note is acked with the URI echoed, gets no update for it, and a readable URI in the same subscription still arrives",
    async () => {
      const { bus, app } = startVault();
      // "*" grants read:notes, so the refusal here is the folder ACL alone.
      const s = await openListen(app, await tokenFor(["*"]), [SECRET_NOTE, PUB], {
        id: 2,
      });
      try {
        expect(await s.waitFor((fs) => fs.some(isAck))).toBe(true);
        const ack = s.frames.find(isAck);
        expect(ack?.params?.notifications?.resourceSubscriptions).toEqual([SECRET_NOTE, PUB]);

        // Denied note first, then the readable one. Frames arrive in publish order, so once the
        // readable update has landed, any frame the denied note would have produced has landed too.
        bus.publish({ vaultId: "test", relPath: "secret/b.md" });
        bus.publish({ vaultId: "test", relPath: "pub/a.md" });

        expect(await s.waitFor((fs) => fs.some(updateFor(PUB)))).toBe(true);
        expect(s.frames.filter(updateFor(SECRET_NOTE))).toHaveLength(0);
      } finally {
        await s.stop();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "(c) a caller WITHOUT the read:notes scope is acked and gets no update, while a control stream holding read:notes does",
    async () => {
      const { bus, app } = startVault();
      const scoped = await openListen(app, await tokenFor(["write:notes"]), [PUB], {
        id: 3,
      });
      const control = await openListen(app, await tokenFor(["*"]), [PUB], { id: 4 });
      try {
        expect(await scoped.waitFor((fs) => fs.some(isAck))).toBe(true);
        expect(await control.waitFor((fs) => fs.some(isAck))).toBe(true);
        expect(scoped.frames.find(isAck)?.params?.notifications?.resourceSubscriptions).toEqual([
          PUB,
        ]);

        bus.publish({ vaultId: "test", relPath: "pub/a.md" });

        expect(await control.waitFor((fs) => fs.some(updateFor(PUB)))).toBe(true);
        expect(scoped.frames.filter(updateFor(PUB))).toHaveLength(0);
      } finally {
        await scoped.stop();
        await control.stop();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "(d) the same request WITHOUT the modern protocol header and _meta envelope is not answered by the new stream",
    async () => {
      // Existing behaviour, measured: the legacy-era request is not intercepted by the new seam (the
      // interception requires mcp-protocol-version === 2026-07-28), so it falls through to the SDK's
      // ordinary legacy handling. This test asserts only what the wire must NOT carry: our ack
      // echoing the URI, and our update frame.
      const { bus, app } = startVault();
      const s = await openListen(app, await tokenFor(["*"]), [PUB], {
        modern: false,
        id: 5,
      });
      try {
        // Give the legacy response time to finish; it is a plain request, not a held stream.
        for (let i = 0; i < 75 && !s.ended(); i++) await sleep(20);
        bus.publish({ vaultId: "test", relPath: "pub/a.md" });
        await sleep(200);
        expect(s.frames.some((f) => f.method === UPDATED)).toBe(false);
        const ackEchoesUri = s.frames.some(
          (f) => f.method === ACK && JSON.stringify(f.params).includes(PUB),
        );
        expect(ackEchoesUri).toBe(false);
      } finally {
        await s.stop();
      }
    },
    stallTimeout(30_000),
  );

  it("(f) a modern tools/list that carries resourceSubscriptions is answered as JSON, not as an SSE stream", async () => {
    const { app } = startVault();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
      params: {
        notifications: { resourceSubscriptions: [PUB] },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "rs-sub-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    const headers = { ...listenHeaders(await tokenFor(["*"]), true), "mcp-method": "tools/list" };
    const res = await app.app.request(LISTEN_URL, { method: "POST", headers, body });
    expect(res.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", id: 11 });
  });
});

describe("which resource URIs a caller may subscribe to", () => {
  it("(e) canReadResourceUri: the normalized target for a readable note, including one not yet on disk", () => {
    const v = vault();
    const aclFor = (id: string) => v.registry.aclFor(id);
    const ctx = v.ctx();

    // Floor: a readable note that does not exist on disk yet still resolves to its target.
    const readable = canReadResourceUri(
      v.vaultRegistry,
      ctx,
      buildResourceUri("test", "pub/new.md"),
      aclFor,
    );
    expect(readable).toEqual({ vaultId: "test", relPath: "pub/new.md" });
  });

  it("(e) canReadResourceUri: a hard-linked note is refused exactly as resources/read refuses it; an ordinary note and a deleted note still resolve", () => {
    const v = vault();
    const aclFor = (id: string) => v.registry.aclFor(id);
    const ctx = v.ctx();
    writeFileSync(join(v.root, "pub", "ordinary.md"), "ORDINARY\n");
    linkSync(join(v.root, "pub", "a.md"), join(v.root, "pub", "alias.md"));
    const hard = buildResourceUri("test", "pub/alias.md");
    const ordinary = buildResourceUri("test", "pub/ordinary.md");

    // The read path must really refuse the alias first, or the agreement below proves nothing.
    expect(() => readResourceFor({ registry: v.registry }, v.vaultRegistry, ctx, hard)).toThrow();
    expect(canReadResourceUri(v.vaultRegistry, ctx, hard, aclFor)).toBeNull();
    expect(canReadResourceUri(v.vaultRegistry, ctx, ordinary, aclFor)).toEqual({
      vaultId: "test",
      relPath: "pub/ordinary.md",
    });

    unlinkSync(join(v.root, "pub", "ordinary.md"));
    expect(canReadResourceUri(v.vaultRegistry, ctx, ordinary, aclFor)).toEqual({
      vaultId: "test",
      relPath: "pub/ordinary.md",
    });
  });

  it("(e) canReadResourceUri: null for every refusal", () => {
    const v = vault();
    const aclFor = (id: string) => v.registry.aclFor(id);
    const ctx = v.ctx();

    const at = (uri: string, caller = ctx) =>
      canReadResourceUri(v.vaultRegistry, caller, uri, aclFor);
    const refused: Array<{ label: string; result: unknown }> = [
      { label: "denied path (folder ACL)", result: at(SECRET_NOTE) },
      { label: "catalog URI (not subscribable)", result: at(CATALOG_RESOURCE_URI) },
      {
        label: "malformed URI (no vault/path separator)",
        result: at(`${RESOURCE_SCHEME}://nosep`),
      },
      { label: "foreign scheme", result: at("https://example.com/x.md") },
      { label: "unknown vault", result: at(`${RESOURCE_SCHEME}://nope/pub/a.md`) },
      { label: "unauthenticated caller", result: at(PUB, v.ctx({ authenticated: false })) },
      {
        label: "caller without read:notes",
        result: at(PUB, v.ctx({ grantedScopes: new Set(["write:notes"]) })),
      },
    ];
    let checked = 0;
    for (const { label, result } of refused) {
      expect(result, label).toBeNull();
      checked++;
    }
    expect(checked).toBe(refused.length);
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it("(e) canReadResourceUri: a path that escapes the vault root is refused, however it is encoded", () => {
    const v = vault();
    const aclFor = (id: string) => v.registry.aclFor(id);
    const escapes = [
      `${RESOURCE_SCHEME}://test/pub/../secret/b.md`,
      `${RESOURCE_SCHEME}://test/pub/%2e%2e/secret/b.md`,
      `${RESOURCE_SCHEME}://test/%2e%2e/secret/b.md`,
      `${RESOURCE_SCHEME}://test/%2Fetc%2Fpasswd`,
    ];
    for (const uri of escapes) {
      expect(canReadResourceUri(v.vaultRegistry, v.ctx(), uri, aclFor), uri).toBeNull();
    }
  });

  it.skipIf(process.platform === "win32")(
    "(e) canReadResourceUri: an in-vault symlink whose target lies outside the vault is refused",
    () => {
      const v = vault();
      const aclFor = (id: string) => v.registry.aclFor(id);
      const ctx = v.ctx();
      const outside = mkdtempSync(join(tmpdir(), "rs-outside-"));
      try {
        symlinkSync(outside, join(v.root, "pub", "out"));
        // Control: an ordinary file in the same readable folder still resolves.
        expect(canReadResourceUri(v.vaultRegistry, ctx, PUB, aclFor)).not.toBeNull();
        const through = buildResourceUri("test", "pub/out/x.md");
        expect(canReadResourceUri(v.vaultRegistry, ctx, through, aclFor)).toBeNull();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it(
    "closing the app ends an open resource stream, so shutdown does not wait on a connected subscriber",
    async () => {
      const { app } = startVault();
      const s = await openListen(app, await tokenFor(["*"]), [PUB]);
      try {
        expect(await s.waitFor((fs) => fs.some(isAck))).toBe(true);
        await app.close();
        expect(await waitForFrames([], () => s.ended(), 2000)).toBe(true);
      } finally {
        await s.stop();
      }
    },
    stallTimeout(30_000),
  );

  it("each test vault has its own change bus", () => {
    expect(vault().vaultRegistry.changes).not.toBe(vault().vaultRegistry.changes);
  });
});

/** A signed token with no `sub` claim: a usable-looking token with no identity (see mcp-advisories). */
async function tokenWithoutSub(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scopes: ["*"], aud: "http://test", iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(signingKey));
}

/** One `subscriptions/listen` that asks for both advisory push and resource updates (Finding 3). */
describe("one listen asking for advisory and resource notifications", () => {
  const ADVISORY_FRAME = "notifications/advisory";
  const ADVISORY_EVENT = {
    chunkId: "hit",
    goalId: "g1",
    goalText: "goal",
    score: 0.9,
    candidateKind: "note_changed",
  };

  function startBoth() {
    const v = vault();
    const advisoryBus = createAdvisoryBus();
    return { bus: v.vaultRegistry.changes, advisoryBus, app: boot(v, advisoryBus) };
  }

  it(
    "acks both keys in ONE frame, then delivers a resource update and an advisory on that stream",
    async () => {
      const { bus, advisoryBus, app } = startBoth();
      const s = await openListen(app, await tokenFor(["*"]), [PUB], { id: 21, advisory: true });
      try {
        expect(s.status).toBe(200);
        expect(await s.waitFor((fs) => fs.some(isAck))).toBe(true);
        const acks = s.frames.filter(isAck);
        expect(acks).toHaveLength(1);
        expect(acks[0]?.params?.notifications?.[ADVISORY_SUBSCRIPTION_KEY]).toBe(true);
        expect(acks[0]?.params?.notifications?.resourceSubscriptions).toEqual([PUB]);
        expect(acks[0]?.params?._meta?.[SUB_KEY]).toBe(21);

        bus.publish({ vaultId: "test", relPath: "pub/a.md" });
        advisoryBus.publish({
          vaultId: "test",
          caller: "agent-1",
          sessionId: "s1",
          advisories: [ADVISORY_EVENT],
        });

        expect(await s.waitFor((fs) => fs.some(updateFor(PUB)))).toBe(true);
        expect(await s.waitFor((fs) => fs.some((f) => f.method === ADVISORY_FRAME))).toBe(true);
      } finally {
        await s.stop();
      }
    },
    stallTimeout(30_000),
  );

  it("refuses the combined request from a caller with no usable identity: HTTP 403, no stream", async () => {
    const { app } = startBoth();
    const s = await openListen(app, await tokenWithoutSub(), [PUB], { id: 22, advisory: true });
    try {
      expect(s.status).toBe(403);
      expect(s.frames.some(isAck)).toBe(false);
    } finally {
      await s.stop();
    }
  });

  it("refuses the combined request naming more than 256 URIs: HTTP 400 with -32602, no stream", async () => {
    const { app } = startBoth();
    const uris = Array.from({ length: 257 }, (_, i) => buildResourceUri("test", `n/${i}.md`));
    const s = await openListen(app, await tokenFor(["*"]), uris, { id: 23, advisory: true });
    try {
      expect(s.status).toBe(400);
      expect(s.raw).toContain("-32602");
      expect(s.frames.some(isAck)).toBe(false);
    } finally {
      await s.stop();
    }
  });
});

describe("only subscriptions/listen opens an extension stream", () => {
  it("a modern tools/list that carries the advisory key is answered as JSON, not as an SSE stream", async () => {
    const app = boot(vault(), createAdvisoryBus());
    const listen = JSON.parse(listenBody([], true, 31, true));
    const body = JSON.stringify({ ...listen, method: "tools/list" });
    const headers = { ...listenHeaders(await tokenFor(["*"]), true), "mcp-method": "tools/list" };
    const res = await app.app.request(LISTEN_URL, { method: "POST", headers, body });
    expect(res.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", id: 31 });
  });
});
