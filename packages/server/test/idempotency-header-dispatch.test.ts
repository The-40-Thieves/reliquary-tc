import { expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import { argsHash } from "../src/hash";
import { ToolRegistry } from "../src/mcp/registry";
import { openMemoryDb } from "./helpers";

/** One key-accepting tool that counts its runs, and a caller to dispatch it as. */
function fixture() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const counter = { writes: 0 };
  const registry = new ToolRegistry({ rootResolver: () => undefined });
  registry.register({
    name: "write",
    description: "test",
    acceptsIdempotencyKey: true,
    inputSchema: z.object({
      idempotency_key: z.string().min(1).max(128).optional(),
      bulk_idempotency_key: z.string().optional(),
      note: z.string().optional(),
      options: z.object({ idempotency_key: z.string().optional() }).optional(),
    }),
    requiredScopes: [],
    handler: () => ({ writes: ++counter.writes }),
  });
  const ctx = {
    caller: "caller",
    authenticated: true,
    grantedScopes: new Set<string>(),
    vaultId: "v1",
    db,
  };
  return { db, counter, registry, ctx };
}

it("replays a header-keyed call", async () => {
  const { db, counter, registry, ctx } = fixture();
  const keyed = { ...ctx, idempotencyKeyHeader: "key" };
  await registry.dispatch("write", {}, keyed);
  const result = await registry.dispatch("write", {}, keyed);
  expect(result.meta.idempotent_replay).toBe(true);
  expect(counter.writes).toBe(1);
  db.close();
});

it.each(["idempotency_key", "bulk_idempotency_key", "options"])(
  "matches the %s argument form and a hash stored by an older version",
  async (location) => {
    const { db, counter, registry, ctx } = fixture();
    const args =
      location === "options" ? { options: { idempotency_key: "key" } } : { [location]: "key" };
    await registry.dispatch("write", args, ctx);
    // An older version hashed the arguments WITH the key in them.
    db.prepare("UPDATE idempotency_keys SET args_hash = ?").run(argsHash("write", args));
    const replay = await registry.dispatch("write", {}, { ...ctx, idempotencyKeyHeader: "key" });
    expect(replay.meta.idempotent_replay).toBe(true);
    expect(counter.writes).toBe(1);
    db.close();
  },
);

it("refuses a header that disagrees with the argument, without echoing either value", async () => {
  const { db, counter, registry, ctx } = fixture();
  const result = await registry.dispatch(
    "write",
    { idempotency_key: "argument-value" },
    { ...ctx, idempotencyKeyHeader: "header-value" },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "validation_error" } });
  expect(JSON.stringify(result)).not.toMatch(/header-value|argument-value/);
  expect(counter.writes).toBe(0);
  db.close();
});

it("keeps the same header key with different arguments a mismatch", async () => {
  const { db, counter, registry, ctx } = fixture();
  const keyed = { ...ctx, idempotencyKeyHeader: "key" };
  await registry.dispatch("write", { note: "a" }, keyed);
  const second = await registry.dispatch("write", { note: "b" }, keyed);
  expect(second).toMatchObject({ ok: false, error: { code: "idempotency_key_mismatch" } });
  expect(counter.writes).toBe(1);
  db.close();
});
