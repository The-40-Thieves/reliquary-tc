import { ServerConfigSchema } from "@the-40-thieves/reliquary-tc-shared";
import { SignJWT } from "jose";
import { expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

it("accepts HTTP idempotency keys", async () => {
  const db = openMemoryDb();
  provisionCacheDb(db);
  let writes = 0;
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
      handler: () => ({ writes: ++writes }),
    });
  }
  const secret = "test-only-secret-not-a-real-credential-0123456789";
  const auth = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "jwt", jwtSecret: secret, audience: "http://test" },
  }).auth;
  const handle = createHttpApp({
    name: "test",
    version: "1",
    registry,
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    enableDnsRebindingProtection: false,
  });
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    sub: "caller",
    scopes: [],
    aud: "http://test",
    iat: now,
    exp: now + 600,
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(secret));
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
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const body = JSON.parse(line ? line.slice(6) : text);
    return body.result?.structuredContent ?? body;
  }
  try {
    const first = await call("keyed", "first");
    expect(first.writes).toBe(1);
    expect((await call("keyed", "first")).writes).toBe(1);
    expect(writes).toBe(1);
    expect((await call("keyed", "first", { idempotency_key: "first" })).writes).toBe(1);
    const mismatch = await call("keyed", "header-secret", { idempotency_key: "argument-secret" });
    expect(mismatch.code).toBe("validation_error");
    expect(JSON.stringify(mismatch)).not.toContain("header-secret");
    expect(JSON.stringify(mismatch)).not.toContain("argument-secret");
    expect((await call("keyed", "x".repeat(129))).code).toBe("validation_error");
    expect((await call("plain", "ignored")).writes).toBeGreaterThan(1);
    expect((await call("plain", "ignored")).writes).toBeGreaterThan(1);
    expect(writes).toBe(3);
    const ctx = {
      caller: "caller",
      authenticated: true,
      grantedScopes: new Set<string>(),
      vaultId: "v1",
      db,
    };
    await registry.dispatch("keyed", {}, ctx);
    await registry.dispatch("keyed", {}, ctx);
    expect(writes).toBe(5);
  } finally {
    await handle.close();
    db.close();
  }
});
