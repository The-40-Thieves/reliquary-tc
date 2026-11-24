// resources/updated over real HTTP (modern era only): a `subscriptions/listen` carrying
// `params.notifications.resourceSubscriptions` is answered by serveResourceSubscription, not the SDK
// handler, and every event is re-checked against the caller's own read permission.
//
// Shape of the proof: a NEGATIVE assertion ("no update for the note the caller cannot read") only
// means something if the same stream demonstrably delivers an update for a note it CAN read. So each
// case that asserts silence also asserts delivery on the same stream, and checks the silent publish
// first, so a late delivery cannot be mistaken for silence.

import { ServerConfigSchema } from "@the-40-thieves/reliquary-tc-shared";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import {
  createResourceChangeBus,
  type ResourceChangeBus,
} from "../src/mcp/resource-subscriptions";
import {
  buildResourceUri,
  CATALOG_RESOURCE_URI,
  canReadResourceUri,
  RESOURCE_SCHEME,
} from "../src/mcp/resources";
import { type HttpHandle, startHttp } from "../src/transports/http";
import { type TestVault, makeTestVault } from "./m1-helpers";
import { stallTimeout } from "./stall-timeouts";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const ACK = "notifications/subscriptions/acknowledged";
const UPDATED = "notifications/resources/updated";
const SUB_KEY = "io.modelcontextprotocol/subscriptionId";

type Frame = { jsonrpc: string; method?: string; params?: any; id?: unknown; error?: unknown };

const FILES = { "pub/a.md": "PUBLIC\n", "secret/b.md": "SECRET\n" };
const PUB = buildResourceUri("test", "pub/a.md");
const SECRET_NOTE = buildResourceUri("test", "secret/b.md");

// The vault's own ACL: only pub/** is readable. Root ACL is permissive; the per-vault override is
// what canRead must honour (registry.aclFor), exactly as resources/read does.
const vaults: TestVault[] = [];
const handles: HttpHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const v of vaults.splice(0)) v.cleanup();
});

function vault(): TestVault {
  const v = makeTestVault({ files: FILES, aclByVault: { test: { readPaths: ["pub/**"] } } });
  vaults.push(v);
  return v;
}

async function boot(v: TestVault, bus: ResourceChangeBus): Promise<HttpHandle> {
  const auth = ServerConfigSchema.parse({
    vaults: [{ id: "test", path: v.root }],
    auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
  }).auth;
  const handle = await startHttp({
    name: "reliquary-tc",
    version: "0.0.0-test",
    registry: v.registry,
    vaultRegistry: v.vaultRegistry,
    auth,
    db: v.db,
    vaultId: "test",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    resourceChangeBus: bus,
  });
  handles.push(handle);
  return handle;
}

async function tokenFor(scopes: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "agent-1", scopes, aud: "http://test", iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
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

/** Open a `subscriptions/listen` for `uris` and read its stream in the background. `modern: false`
 *  sends the same request without the modern protocol header and `_meta` envelope. */
async function openListen(
  port: number,
  jwt: string,
  uris: string[],
  opts: { modern?: boolean; id?: number } = {},
): Promise<Listen> {
  const modern = opts.modern !== false;
  const ac = new AbortController();
  const params: Record<string, unknown> = { notifications: { resourceSubscriptions: uris } };
  if (modern) {
    params._meta = {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientInfo": { name: "rs-sub-test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
  }
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    signal: ac.signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": modern ? MODERN : LEGACY,
      ...(modern ? { "mcp-method": "subscriptions/listen" } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: opts.id ?? 1,
      method: "subscriptions/listen",
      params,
    }),
  });
  const out: Listen = {
    status: res.status,
    frames: [],
    raw: "",
    ended: () => ended,
    waitFor: async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (pred(out.frames)) return true;
        await sleep(20);
      }
      return pred(out.frames);
    },
    stop: async () => {
      ac.abort();
      await pump;
    },
  };
  let ended = false;
  const pump = (async () => {
    const reader = res.body?.getReader();
    if (!reader) {
      ended = true;
      return;
    }
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        out.raw += chunk;
        buf += chunk;
        let cut = buf.indexOf("\n\n");
        while (cut >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              out.frames.push(JSON.parse(line.slice(6)) as Frame);
            } catch {
              /* a partial frame cannot happen here: blocks are cut on the blank line */
            }
          }
          cut = buf.indexOf("\n\n");
        }
      }
    } catch {
      /* aborted by stop(), or the server closed the connection */
    } finally {
      ended = true;
    }
  })();
  return out;
}

const isAck = (f: Frame) => f.method === ACK;
const updateFor = (uri: string) => (f: Frame) => f.method === UPDATED && f.params?.uri === uri;

describe("resources/updated over HTTP (modern era)", () => {
  it(
    "(a) a caller with read access is acked, and an out-of-band publish reaches its stream for a note it can read",
    async () => {
      const v = vault();
      const bus = createResourceChangeBus();
      const handle = await boot(v, bus);
      const s = await openListen(handle.port, await tokenFor(["*"]), [PUB], { id: 1 });
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
      const v = vault();
      const bus = createResourceChangeBus();
      const handle = await boot(v, bus);
      // "*" grants read:notes, so the refusal here is the folder ACL alone.
      const s = await openListen(handle.port, await tokenFor(["*"]), [SECRET_NOTE, PUB], {
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
      const v = vault();
      const bus = createResourceChangeBus();
      const handle = await boot(v, bus);
      const scoped = await openListen(handle.port, await tokenFor(["write:notes"]), [PUB], {
        id: 3,
      });
      const control = await openListen(handle.port, await tokenFor(["*"]), [PUB], { id: 4 });
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
      const v = vault();
      const bus = createResourceChangeBus();
      const handle = await boot(v, bus);
      const s = await openListen(handle.port, await tokenFor(["*"]), [PUB], {
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

  it("(e) canReadResourceUri: the normalized target for a readable note, null for every refusal", () => {
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

    const refused: Array<{ label: string; result: unknown }> = [
      {
        label: "denied path (folder ACL)",
        result: canReadResourceUri(v.vaultRegistry, ctx, SECRET_NOTE, aclFor),
      },
      {
        label: "catalog URI (not subscribable)",
        result: canReadResourceUri(v.vaultRegistry, ctx, CATALOG_RESOURCE_URI, aclFor),
      },
      {
        label: "malformed URI (no vault/path separator)",
        result: canReadResourceUri(v.vaultRegistry, ctx, `${RESOURCE_SCHEME}://nosep`, aclFor),
      },
      {
        label: "foreign scheme",
        result: canReadResourceUri(v.vaultRegistry, ctx, "https://example.com/x.md", aclFor),
      },
      {
        label: "unknown vault",
        result: canReadResourceUri(
          v.vaultRegistry,
          ctx,
          `${RESOURCE_SCHEME}://nope/pub/a.md`,
          aclFor,
        ),
      },
      {
        label: "unauthenticated caller",
        result: canReadResourceUri(
          v.vaultRegistry,
          v.ctx({ authenticated: false }),
          PUB,
          aclFor,
        ),
      },
      {
        label: "caller without read:notes",
        result: canReadResourceUri(
          v.vaultRegistry,
          v.ctx({ grantedScopes: new Set(["write:notes"]) }),
          PUB,
          aclFor,
        ),
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
});
