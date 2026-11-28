import { expect, it } from "vitest";
import { ftsCandidates } from "../src/search/fts";
import { deindexNote, indexNote } from "../src/search/indexer";
import { makeM2Vault } from "./m2-helpers";

const PATH = "Notes/Delete.md";
const RAW = "# Alpha\n\ndeleteneedle one\n\n# Beta\n\ndeleteneedle two";
const NOW = () => 1000;

// node:sqlite reports sqlite3_last_insert_rowid() in every run() result, and an FTS5 segment flush
// during a chunk_fts delete leaves that value above 2^53 for the rest of the transaction.
it("deletes a multi-chunk note under node:sqlite and leaves the connection writable", async () => {
  const v = makeM2Vault();
  try {
    const index = () =>
      indexNote(
        v.db,
        v.provider,
        v.id,
        PATH,
        RAW,
        false,
        NOW,
        undefined,
        true,
        undefined,
        undefined,
        PATH,
      );
    await index();
    expect(v.db.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toEqual({ n: 2 });
    deindexNote(v.db, v.id, PATH, false, true, undefined, NOW);
    expect(v.db.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toEqual({ n: 0 });
    expect(v.db.prepare("SELECT COUNT(*) AS n FROM chunk_embeddings").get()).toEqual({ n: 0 });
    expect(ftsCandidates(v.db, v.id, "deleteneedle", 10)).toEqual([]);
    expect((await index()).upserted).toBe(2);
  } finally {
    v.cleanup();
  }
});
