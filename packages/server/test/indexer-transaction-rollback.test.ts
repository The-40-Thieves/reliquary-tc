import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqlite } from "../src/db/node-node-sqlite";
import { provisionCacheDb } from "../src/db/provision";
import type { Database, Statement } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexNote } from "../src/search/indexer";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT_ID = "test";
const PATH = "note.md";
// Two headings -> chunkNote (src/search/chunk.ts) yields two chunks, so applyNoteWrites issues
// multiple INSERT INTO chunks calls before the transaction's final statement (the vault_generation
// bump) runs — the writes that must NOT survive a late failure.
const RAW =
  "# Alpha\n\nThe quick brown fox jumps over the lazy dog.\n\n# Beta\n\nA second section.\n";

/** Wrap a real Database so any prepared statement whose SQL contains `matchSql` throws on `.run()`
 *  — a failure injected at a specific point in an otherwise-real transaction. Every other statement
 *  (including reads used by table-existence probes) passes through unchanged. */
function injectRunFailure(real: Database, matchSql: string): Database {
  const wrap = (sql: string, stmt: Statement): Statement =>
    sql.includes(matchSql)
      ? {
          run: (): never => {
            throw new Error(`injected failure at: ${matchSql}`);
          },
          get: (...args: unknown[]) => stmt.get(...args),
          all: (...args: unknown[]) => stmt.all(...args),
        }
      : stmt;
  return {
    exec: (sql: string) => real.exec(sql),
    prepare: (sql: string) => wrap(sql, real.prepare(sql)),
    prepareCached: real.prepareCached
      ? (sql: string) => wrap(sql, (real.prepareCached as (s: string) => Statement)(sql))
      : undefined,
    loadExtension: real.loadExtension?.bind(real),
    close: real.close?.bind(real),
  };
}

const count = (db: Database, sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...args) as { c: number }).c;
const hasTable = (db: Database, name: string): boolean =>
  db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
  undefined;

/** Query the REAL (unwrapped) connection: the transaction must have rolled back, so none of this
 *  note's writes survive. */
function expectNoPartialState(real: Database): void {
  expect(
    count(real, "SELECT count(*) AS c FROM chunks WHERE vault_id = ? AND path = ?", VAULT_ID, PATH),
  ).toBe(0);
  expect(
    count(
      real,
      "SELECT count(*) AS c FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.vault_id = ? AND c.path = ?",
      VAULT_ID,
      PATH,
    ),
  ).toBe(0);
  expect(
    count(real, "SELECT count(*) AS c FROM notes WHERE vault_id = ? AND path = ?", VAULT_ID, PATH),
  ).toBe(0);
  if (hasTable(real, "chunk_fts")) {
    // THE-711 follow-up: chunk_fts is contentless — `WHERE path = ?` is not just unavailable,
    // it would silently match zero and pass vacuously. The path is resolved through the join to
    // chunks instead, which is also the stronger check: it asserts no FTS row SURVIVES for this
    // note, orphan or otherwise, rather than that no row carries its path.
    expect(
      count(
        real,
        "SELECT count(*) AS c FROM chunk_fts JOIN chunks ON chunks.rowid = chunk_fts.rowid WHERE chunks.path = ?",
        PATH,
      ),
    ).toBe(0);
    // And no orphan was left behind either: totals stay reconciled, which is what keeps
    // ensureChunkFts from triggering a full reindex on the next open.
    expect(count(real, "SELECT COUNT(*) AS c FROM chunk_fts")).toBe(
      count(real, "SELECT COUNT(*) AS c FROM chunks"),
    );
  }
  if (hasTable(real, "vault_generation")) {
    const generation = real
      .prepare("SELECT generation FROM vault_generation WHERE vault_id = ?")
      .get(VAULT_ID) as { generation: number } | undefined;
    expect(generation).toBeUndefined();
  }
}

describe.each(["legacy", "modular"] as const)(
  "indexNote transaction rollback (%s)",
  (writePreparation) => {
    let dir: string;
    let real: Database;
    const index = (db: Database) =>
      indexNote(
        db,
        fakeEmbeddingProvider({ dimensions: 8 }),
        VAULT_ID,
        PATH,
        RAW,
        false,
        () => 1000,
        undefined,
        false,
        undefined,
        undefined,
        PATH,
        { writePreparation },
      );

    afterEach(() => {
      real.close?.();
      rmTemp(dir);
    });

    it("a failure on the LAST statement of the transaction leaves no partial state", async () => {
      dir = makeTempDir("otc-idx-rollback-");
      real = await openNodeSqlite(join(dir, "cache.db"));
      provisionCacheDb(real);
      // Fail on the vault_generation bump (generation.ts bumpGeneration) — the LAST write inside
      // indexNote's transaction, so chunk/embedding/FTS/note writes have all already run on this
      // connection by the time it throws.
      const db = injectRunFailure(real, "INSERT INTO vault_generation");
      await expect(index(db)).rejects.toThrow(/injected failure/);
      expectNoPartialState(real);
    });

    it("control: the same note indexes cleanly with no injected failure", async () => {
      dir = makeTempDir("otc-idx-rollback-ok-");
      real = await openNodeSqlite(join(dir, "cache.db"));
      provisionCacheDb(real);
      expect((await index(real)).upserted).toBe(2);
      expect(
        count(
          real,
          "SELECT count(*) AS c FROM chunks WHERE vault_id = ? AND path = ?",
          VAULT_ID,
          PATH,
        ),
      ).toBe(2);
    });
  },
);
