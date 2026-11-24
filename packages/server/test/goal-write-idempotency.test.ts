import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { registerM8Tools } from "../src/tools/m8";
import { openMemoryDb } from "./helpers";

function fixture() {
  const edb = openMemoryDb();
  const db = openMemoryDb();
  runMigrations(
    edb,
    EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
      version: versionOf(file),
      sql: readFileSync(new URL(`../src/migrations/${file}`, import.meta.url), "utf8"),
    })),
  );
  provisionCacheDb(db);
  const registry = new ToolRegistry({ rootResolver: () => undefined });
  registerM8Tools(registry, { edb });
  const ctx = {
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "main",
    db,
  };
  return { db, edb, registry, ctx };
}

const cases = [
  [
    "replays creation and closure and rejects changed arguments",
    async ({ edb, registry, ctx }: ReturnType<typeof fixture>) => {
      const create = { vault: "main", text: "goal", idempotency_key: "create-goal" };
      const first = await registry.dispatch("set_goal", create, ctx);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      const replay = await registry.dispatch("set_goal", create, ctx);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      expect((edb.prepare("SELECT COUNT(*) AS n FROM goals").get() as { n: number }).n).toBe(1);
      const mismatch = await registry.dispatch("set_goal", { ...create, text: "other" }, ctx);
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
      if (!first.ok) return;
      const close = {
        vault: "main",
        id: (first.data as { id: string }).id,
        status: "completed",
        idempotency_key: "close-goal",
      };
      const closed = await registry.dispatch("close_goal", close, ctx);
      expect(closed.ok, JSON.stringify(closed)).toBe(true);
      const closedReplay = await registry.dispatch("close_goal", close, ctx);
      expect(closedReplay.meta?.idempotent_replay).toBe(true);
      expect(closedReplay.ok && closedReplay.data).toEqual(closed.ok && closed.data);
      const closeMismatch = await registry.dispatch(
        "close_goal",
        { ...close, status: "abandoned" },
        ctx,
      );
      expect(closeMismatch.ok ? null : closeMismatch.error.code).toBe("idempotency_key_mismatch");
    },
  ],
  [
    "replays episode forgetting without a second log entry",
    async ({ edb, registry, ctx }: ReturnType<typeof fixture>) => {
      edb
        .prepare(
          `INSERT INTO agent_episodes (id, ts, vault_id, caller, channel, episode_type, tool, status, eligibility, trust, blocked, valid_from) VALUES ('episode', 1, 'main', 'test', 'dispatch', 'tool_call', 'read_note', 'ok', 'eligible', 0.6, 0, 1)`,
        )
        .run();
      const args = { episode_id: "episode", idempotency_key: "forget" };
      const first = await registry.dispatch("work_forget", args, ctx);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      const replay = await registry.dispatch("work_forget", args, ctx);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      expect((edb.prepare("SELECT COUNT(*) AS n FROM forget_log").get() as { n: number }).n).toBe(
        1,
      );
      const mismatch = await registry.dispatch(
        "work_forget",
        { ...args, episode_id: "other" },
        ctx,
      );
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    },
  ],
  [
    "replays feedback without stamping again",
    async ({ edb, registry, ctx }: ReturnType<typeof fixture>) => {
      edb
        .prepare(
          "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, caller) VALUES ('r', 'chunk', 1, 'test')",
        )
        .run();
      const args = { chunk_id: "chunk", feedback: 1, idempotency_key: "feedback" };
      const first = await registry.dispatch("record_retrieval_feedback", args, ctx);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      edb.prepare("UPDATE chunk_retrievals SET feedback = 0 WHERE id = 'r'").run();
      const replay = await registry.dispatch("record_retrieval_feedback", args, ctx);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      expect(
        (
          edb.prepare("SELECT feedback FROM chunk_retrievals WHERE id = 'r'").get() as {
            feedback: number;
          }
        ).feedback,
      ).toBe(0);
      const mismatch = await registry.dispatch(
        "record_retrieval_feedback",
        { ...args, feedback: -1 },
        ctx,
      );
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    },
  ],
  [
    "leaves the key usable when feedback is refused for want of a session",
    async ({ edb, registry, ctx }: ReturnType<typeof fixture>) => {
      edb
        .prepare(
          "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, caller) VALUES ('r', 'chunk', 1, 'test')",
        )
        .run();
      const args = { chunk_id: "chunk", feedback: 1, idempotency_key: "refused-feedback" };
      const scoped = { ...ctx, grantedScopes: new Set(["write:workspace"]) };
      const refused = await registry.dispatch("record_retrieval_feedback", args, scoped);
      expect(refused.ok ? null : refused.error.code).toBe("forbidden");
      const retried = await registry.dispatch("record_retrieval_feedback", args, {
        ...scoped,
        sessionId: "s",
      });
      expect(retried.ok, JSON.stringify(retried)).toBe(true);
      expect(retried.meta?.idempotent_replay).toBeUndefined();
    },
  ],
  [
    "replays a task verdict without stamping a later episode",
    async ({ edb, db, registry, ctx }: ReturnType<typeof fixture>) => {
      db.prepare(
        "INSERT INTO workspace_sessions (id, vault_id, caller, started_at, trace_path, principal, trace_store) VALUES ('session', 'main', 'test', 1, 'trace', 'test', 'cache')",
      ).run();
      const seed = edb.prepare(
        `INSERT INTO agent_episodes (id, ts, vault_id, session_id, caller, channel, episode_type, tool, status, eligibility, trust, blocked, valid_from) VALUES (?, 1, 'main', 'session', 'test', 'dispatch', 'tool_call', 'read_note', 'ok', 'eligible', 0.6, 0, 1)`,
      );
      seed.run("first");
      const args = { result: 1, idempotency_key: "verdict" };
      const first = await registry.dispatch("work_result", args, ctx);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      expect(first.ok && first.data).toMatchObject({ stamped: 1 });
      seed.run("second");
      const replay = await registry.dispatch("work_result", args, ctx);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      expect(
        (
          edb.prepare("SELECT task_result FROM agent_episodes WHERE id = 'second'").get() as {
            task_result: number | null;
          }
        ).task_result,
      ).toBeNull();
      const mismatch = await registry.dispatch("work_result", { ...args, result: -1 }, ctx);
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    },
  ],
] as const;

describe("goal write idempotency", () => {
  it.each(cases)("%s", async (_name, run) => {
    const f = fixture();
    try {
      await run(f);
    } finally {
      f.db.close();
      f.edb.close();
    }
  });
});
