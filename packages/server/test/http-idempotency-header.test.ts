import { randomBytes } from "node:crypto";
import { ServerConfigSchema } from "@the-40-thieves/reliquary-tc-shared";
import { SignJWT } from "jose";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const AUDIENCE = "http://test";
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** A registry with one key-accepting tool and one that accepts none; both count their runs. */
function countingRegistry(counter: { writes: number }): ToolRegistry {
  const registry = new ToolRegistry({ rootResolver: () => undefined });
  for (const [name, accepts] of [
    ["keyed", true],
    ["plain", false],
  ] as const) {
    registry.register({
      name,
      description: "test",
      acceptsIdempotencyKey: accepts,
      inputSchema: z.object({ idempotency_key: z.string().min(1).max(128).optional() }),
      requiredScopes: [],
      handler: () => ({ writes: ++counter.writes }),
    });
  }
  return registry;
}

async function bearerFor(signingKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "caller", scopes: [], aud: AUDIENCE, iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(signingKey));
}

const counter = { writes: 0 };
let db: ReturnType<typeof openMemoryDb>;
let handle: ReturnType<typeof createHttpApp>;
let registry: ToolRegistry;
let token: string;

beforeEach(async () => {
  counter.writes = 0;
  db = openMemoryDb();
  provisionCacheDb(db);
  registry = countingRegistry(counter);
  const signingKey = randomBytes(32).toString("hex");
  const { auth } = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "jwt", jwtSecret: signingKey, audience: AUDIENCE },
  });
  handle = createHttpApp({
    name: "test",
    version: "1",
    registry,
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    enableDnsRebindingProtection: false,
  });
  token = await bearerFor(signingKey);
});

afterEach(async () => {
  await handle.close();
  db.close();
});

/** One `tools/call` over the real HTTP app with an `Idempotency-Key` header. */
async function call(name: string, key: string, args: object = {}) {
  const res = await handle.app.request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name,
      "idempotency-key": key,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, _meta: META },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : text);
  return body.result?.structuredContent ?? body;
}

it("replays a call keyed by the header, and matches the same key sent as an argument", async () => {
  expect((await call("keyed", "first")).writes).toBe(1);
  expect((await call("keyed", "first")).writes).toBe(1);
  expect((await call("keyed", "first", { idempotency_key: "first" })).writes).toBe(1);
  expect(counter.writes).toBe(1);
});

it("refuses a header that disagrees with the argument, or is too long, without echoing it", async () => {
  const mismatch = await call("keyed", "header-value", { idempotency_key: "argument-value" });
  expect(mismatch.code).toBe("validation_error");
  expect(JSON.stringify(mismatch)).not.toMatch(/header-value|argument-value/);
  expect((await call("keyed", "x".repeat(129))).code).toBe("validation_error");
  expect(counter.writes).toBe(0);
});

it("ignores the header for a tool that accepts no key", async () => {
  await call("plain", "ignored");
  await call("plain", "ignored");
  expect(counter.writes).toBe(2);
});

it("leaves a call with neither header nor argument unkeyed", async () => {
  const ctx = {
    caller: "caller",
    authenticated: true,
    grantedScopes: new Set<string>(),
    vaultId: "v1",
    db,
  };
  await registry.dispatch("keyed", {}, ctx);
  await registry.dispatch("keyed", {}, ctx);
  expect(counter.writes).toBe(2);
});
