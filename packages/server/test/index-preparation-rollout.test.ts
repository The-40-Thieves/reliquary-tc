import { err, IndexingConfigSchema } from "@the-40-thieves/reliquary-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../src/embeddings";
import { ftsCandidates } from "../src/search/fts";
import { readGeneration } from "../src/search/generation";
import { deindexNote, indexNote } from "../src/search/indexer";
import * as preparation from "../src/search/indexing/prepare-note";
import { type M2Vault, makeM2Vault } from "./m2-helpers";

const PATH = "Notes/Rollout.md";
const RAW = "# Alpha\n\nrolloutneedle one\n\n# Beta\n\nrolloutneedle two";
const NOW = () => 1000;
const ONE_AT_A_TIME = { batchSize: 1, concurrency: 1 };

type Mode = "legacy" | "modular";

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function snapshot(v: M2Vault) {
  return {
    chunks: v.db.prepare("SELECT * FROM chunks ORDER BY chunk_index").all(),
    embeddings: v.db
      .prepare("SELECT chunk_id, model, hex(embedding) AS embedding FROM chunk_embeddings")
      .all(),
    notes: v.db.prepare("SELECT * FROM notes ORDER BY path").all(),
    generation: readGeneration(v.db, v.id),
  };
}

function spiedVault() {
  const base = fakeEmbeddingProvider({ dimensions: 32 });
  const embed = vi.fn<EmbeddingProvider["embed"]>(base.embed);
  return { v: makeM2Vault({ provider: { ...base, embed } }), embed };
}

function write(
  v: M2Vault,
  mode: Mode,
  raw = RAW,
  extra: {
    provider?: EmbeddingProvider;
    onIndexed?: () => void;
    isExcluded?: (rel: string) => boolean;
    embed?: typeof ONE_AT_A_TIME;
  } = {},
) {
  return indexNote(
    v.db,
    extra.provider ?? v.provider,
    v.id,
    PATH,
    raw,
    false,
    NOW,
    extra.onIndexed,
    true,
    undefined,
    extra.isExcluded,
    PATH,
    { writePreparation: mode, embed: extra.embed },
  );
}

/** A provider whose embed call blocks until released, so a write can be held mid-preparation. */
function heldProvider(v: M2Vault) {
  const started = deferred();
  const released = deferred();
  const provider: EmbeddingProvider = {
    ...v.provider,
    async embed(texts, options) {
      started.resolve();
      await released.promise;
      return v.provider.embed(texts, options);
    },
  };
  return { provider, started, released };
}

it("keeps legacy preparation as the validated default and rejects unknown selections", () => {
  expect(IndexingConfigSchema.parse({}).writePreparation).toBe("legacy");
  expect(IndexingConfigSchema.parse({ writePreparation: "legacy" }).writePreparation).toBe(
    "legacy",
  );
  expect(IndexingConfigSchema.parse({ writePreparation: "modular" }).writePreparation).toBe(
    "modular",
  );
  expect(IndexingConfigSchema.safeParse({ writePreparation: "shadow" }).success).toBe(false);
});

it("prepares a complete modular note without committing index rows", async () => {
  const v = makeM2Vault();
  try {
    const result = await preparation.prepareNote({
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      path: PATH,
      raw: RAW,
      ts: 1000,
      enrich: true,
      embed: ONE_AT_A_TIME,
    });
    expect(result.plan?.toEmbed).toHaveLength(2);
    expect(result.plan?.vectors).toHaveLength(2);
    expect(result.plan?.vectors.every((vector) => vector.length === 32)).toBe(true);
    expect(v.db.prepare("SELECT id FROM chunks").all()).toEqual([]);
    expect(v.db.prepare("SELECT chunk_id FROM chunk_embeddings").all()).toEqual([]);
    expect(readGeneration(v.db, v.id)).toBe(0);
  } finally {
    v.cleanup();
  }
});

describe.each(["legacy", "modular"] as const)("preparation rollout (%s)", (mode) => {
  it("executes only the selected preparation and commits once", async () => {
    const { v, embed } = spiedVault();
    const prepared = vi.spyOn(preparation, "prepareNote");
    const onIndexed = vi.fn();
    try {
      const result = await write(v, mode, RAW, { onIndexed, embed: ONE_AT_A_TIME });
      expect(result.upserted).toBe(2);
      expect(prepared).toHaveBeenCalledTimes(mode === "modular" ? 1 : 0);
      expect(embed).toHaveBeenCalledTimes(2);
      expect(onIndexed).toHaveBeenCalledTimes(1);
      expect(readGeneration(v.db, v.id)).toBe(1);
      expect(ftsCandidates(v.db, v.id, "rolloutneedle", 10)?.map((r) => r.path)).toEqual([PATH]);
    } finally {
      v.cleanup();
    }
  });

  it.each(["outage", "rejection"] as const)(
    "preserves the old index after a later embed %s without falling back",
    async (failure) => {
      const v = makeM2Vault();
      try {
        await write(v, mode, "# Existing\n\npreviousneedle");
        const before = snapshot(v);
        const embed = vi.fn<EmbeddingProvider["embed"]>(async (texts, options) => {
          if (embed.mock.calls.length > 1) {
            if (failure === "rejection") {
              throw err.embeddingProviderError("synthetic rejection", { status: 413 });
            }
            throw new Error("synthetic outage");
          }
          return v.provider.embed(texts, options);
        });
        const onIndexed = vi.fn();
        const provider = { ...v.provider, embed };
        await expect(
          write(v, mode, RAW, { provider, onIndexed, embed: ONE_AT_A_TIME }),
        ).rejects.toThrow(failure === "rejection" ? /rejected/ : /synthetic outage/);
        expect(embed).toHaveBeenCalledTimes(2);
        expect(onIndexed).not.toHaveBeenCalled();
        expect(snapshot(v)).toEqual(before);
        expect(ftsCandidates(v.db, v.id, "previousneedle", 10)?.map((r) => r.path)).toEqual([PATH]);
        expect(ftsCandidates(v.db, v.id, "rolloutneedle", 10)).toEqual([]);
      } finally {
        v.cleanup();
      }
    },
  );

  it("keeps excluded text searchable without sending it to the provider", async () => {
    const { v, embed } = spiedVault();
    try {
      await write(v, mode, RAW, { isExcluded: (path) => path === PATH });
      expect(embed).not.toHaveBeenCalled();
      expect(v.db.prepare("SELECT embedding_excluded FROM chunks").all()).toEqual([
        { embedding_excluded: 1 },
        { embedding_excluded: 1 },
      ]);
      expect(v.db.prepare("SELECT * FROM chunk_embeddings").all()).toEqual([]);
      expect(ftsCandidates(v.db, v.id, "rolloutneedle", 10)?.map((r) => r.path)).toEqual([PATH]);
    } finally {
      v.cleanup();
    }
  });

  it("switches preparation on an unchanged note without re-embedding or rebuilding", async () => {
    const { v, embed } = spiedVault();
    try {
      await write(v, mode === "legacy" ? "modular" : "legacy");
      const before = snapshot(v);
      embed.mockClear();
      const result = await write(v, mode);
      expect(result.unchanged).toBe(2);
      expect(result.upserted).toBe(0);
      expect(embed).not.toHaveBeenCalled();
      expect(snapshot(v)).toEqual(before);
    } finally {
      v.cleanup();
    }
  });

  it.each(["overwrite", "delete"] as const)(
    "drops a delayed preparation after a newer %s commits",
    async (mutation) => {
      const v = makeM2Vault();
      const { provider, started, released } = heldProvider(v);
      const onIndexed = vi.fn();
      let delayed: ReturnType<typeof indexNote> | undefined;
      try {
        await write(v, mode);
        delayed = write(v, mode, "# Delayed\n\nstaleneedle", { provider, onIndexed });
        await started.promise;
        if (mutation === "delete") deindexNote(v.db, v.id, PATH, false, true, undefined, NOW);
        else await write(v, mode, "# Fresh\n\nfreshneedle");
        const before = snapshot(v);
        released.resolve();
        expect((await delayed).staleSkipped).toBe(true);
        expect(onIndexed).not.toHaveBeenCalled();
        expect(snapshot(v)).toEqual(before);
        expect(ftsCandidates(v.db, v.id, "staleneedle", 10)).toEqual([]);
      } finally {
        released.resolve();
        await delayed;
        v.cleanup();
      }
    },
  );
});
