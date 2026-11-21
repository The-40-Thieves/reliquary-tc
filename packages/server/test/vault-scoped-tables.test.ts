// Every cache.db table is one of: vault-scoped (has vault_id), join-scoped (a foreign key to a
// vault-scoped parent), or global with a reason. UNRESOLVED holds tables nobody has decided yet.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";

const VAULT_SCOPED = [
  "acl_path_sets",
  "capture_queue",
  "chunks",
  "cluster_summaries",
  "cluster_summary_members",
  "contradictions",
  "elicit_requests",
  "elicit_tokens",
  "event_log",
  "idempotency_keys",
  "jobs",
  "memory_entities",
  "note_snapshots",
  "note_summaries",
  "note_write_fence",
  "notes",
  "snapshot_blobs",
  "syntheses",
  "vault_context_watermark",
  "vault_edges",
  "vault_generation",
  "vault_identity",
  "workspace_sessions",
  "write_provenance",
  "write_provenance_heads",
] as const;
const JOIN_SCOPED: Record<string, { parent: string; via: string[] }> = {
  acl_path_members: { parent: "acl_path_sets", via: ["set_id"] },
  chunk_embeddings: { parent: "chunks", via: ["chunk_id"] },
  memory_observation_intervals: { parent: "memory_entities", via: ["entity_id"] },
  memory_relations: { parent: "memory_entities", via: ["source_id", "target_id"] },
};
const GLOBAL: Record<string, string> = {
  index_leader_epoch: "Cache-wide indexing leader fencing counter.",
  job_runs: "Cache-wide scheduler job history.",
  schema_migrations: "Migration versions and checksums for the database.",
  telemetry_state: "Server installation telemetry state.",
  wiki_judge_usage: "Cache-wide daily judge call budget.",
};
const UNRESOLVED: Record<string, string> = {
  audit_reports: "Health reports aggregate every vault and are read without a vault filter.",
  reconcile_state: "One cache-wide row whose error list can name individual vaults.",
  wiki_judge_verdicts: "Verdicts are keyed by content hashes and model, with no vault identity.",
};
interface Table {
  columns: string[];
  foreignKeys: Array<{ from: string; table: string }>;
}
function describeTable(db: ReturnType<typeof openMemoryDb>, name: string): Table {
  const quoted = `"${name.replaceAll('"', '""')}"`;
  const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>;
  const foreignKeys = db
    .prepare(`PRAGMA foreign_key_list(${quoted})`)
    .all() as Table["foreignKeys"];
  return { columns: columns.map((column) => column.name), foreignKeys };
}
function schemaTables(): Map<string, Table> {
  const db = openMemoryDb();
  try {
    provisionCacheDb(db);
    const tables = db.prepare("PRAGMA table_list").all() as Array<{ name: string; type: string }>;
    const definitions = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string; sql: string | null }>;
    const virtualRoots = definitions
      .filter(({ sql }) => /\bUSING\s+(?:fts[345]|vec0)\s*\(/i.test(sql ?? ""))
      .map(({ name }) => name);
    const isVirtual = (name: string, type: string) =>
      virtualRoots.some(
        (root) => name === root || (type === "shadow" && name.startsWith(`${root}_`)),
      );
    return new Map(
      tables
        .filter(
          ({ name, type }) =>
            !name.startsWith("sqlite_") && type !== "view" && !isVirtual(name, type),
        )
        .map(({ name }) => [name, describeTable(db, name)] as const),
    );
  } finally {
    db.close();
  }
}
describe("cache table vault scope", () => {
  const tables = schemaTables();
  const classified = [
    ...VAULT_SCOPED,
    ...Object.keys(JOIN_SCOPED),
    ...Object.keys(GLOBAL),
    ...Object.keys(UNRESOLVED),
  ];
  const columnsOf = (name: string) => tables.get(name)?.columns ?? [];

  it("classifies every migrated table exactly once", () => {
    expect(tables.size).toBeGreaterThanOrEqual(37);
    for (const name of tables.keys()) {
      expect(
        classified.filter((entry) => entry === name),
        `unclassified or duplicate table: ${name}`,
      ).toHaveLength(1);
    }
    for (const name of classified) expect(tables.has(name), `stale table: ${name}`).toBe(true);
  });

  it("a vault-scoped table has a vault_id column", () => {
    for (const name of VAULT_SCOPED)
      expect(columnsOf(name), `${name} lacks vault_id`).toContain("vault_id");
  });

  it("a join-scoped table reaches a vault-scoped parent through a foreign key", () => {
    for (const [name, { parent, via }] of Object.entries(JOIN_SCOPED)) {
      expect(columnsOf(name), `${name} has vault_id: list it as vault-scoped`).not.toContain(
        "vault_id",
      );
      expect(VAULT_SCOPED, `${name}: parent ${parent} is not vault-scoped`).toContain(parent);
      const keys = tables.get(name)?.foreignKeys ?? [];
      for (const column of via) {
        expect(
          keys.some((key) => key.from === column && key.table === parent),
          `${name}.${column} is not a foreign key to ${parent}`,
        ).toBe(true);
      }
    }
  });

  it("a global or undecided table has no vault_id and states a reason", () => {
    for (const [name, reason] of Object.entries({ ...GLOBAL, ...UNRESOLVED })) {
      expect(columnsOf(name), `${name} has vault_id: list it as vault-scoped`).not.toContain(
        "vault_id",
      );
      expect(reason.trim(), `${name} needs a reason`).not.toBe("");
    }
  });

  it("the undecided list does not grow", () => {
    expect(Object.keys(UNRESOLVED).sort()).toEqual([
      "audit_reports",
      "reconcile_state",
      "wiki_judge_verdicts",
    ]);
  });
});
