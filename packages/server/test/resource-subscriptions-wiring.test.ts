// A note change reaches the resource-change bus: every index-on-write hook that wireIndexCoordinator
// returns publishes {vaultId, relPath} on the bus passed in its deps.
//
// The two watcher hooks cannot be driven through a real filesystem watch here (registerVaultWatch is
// Windows-unsafe in the vault-watcher suite, and a watch would make this test timing-dependent), so
// the watcher module is replaced with one that hands the callbacks back to the test. Everything else
// in that module is the real one.
//
// The watcher publishes even when this process is a follower: the stream it feeds is held by this
// process, so the leader gate that protects the WRITE must not silence the PUBLISH.

import { describe, expect, it, vi } from "vitest";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../src/embeddings";
import { MetricsRecorder } from "../src/metrics/registry";
import { type IndexHealthState, wireIndexCoordinator } from "../src/runtime/indexing-wiring";
import { createResourceChangeBus, type ResourceChangeEvent } from "../src/vault/note-changes";
import { type M2Vault, makeM2Vault } from "./m2-helpers";

const captured = vi.hoisted(() => ({
  onUpsert: undefined as undefined | ((vaultId: string, path: string, content: string) => void),
  onDelete: undefined as undefined | ((vaultId: string, path: string) => void),
}));

vi.mock("../src/vault/watcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/watcher")>();
  return {
    ...actual,
    registerVaultWatch: (
      _vaults: unknown,
      _cfg: unknown,
      hooks: {
        onUpsert: (vaultId: string, path: string, content: string) => void;
        onDelete: (vaultId: string, path: string) => void;
      },
    ) => {
      captured.onUpsert = hooks.onUpsert;
      captured.onDelete = hooks.onDelete;
      return () => {};
    },
  };
});

function health(): IndexHealthState {
  return {
    inFlight: null,
    lastChunksUpserted: null,
    indexQueueBackpressures: 0,
    auditWriteFailures: 0,
    notesReady: true,
    frontmatterFailures: new Map(),
    writeFailures: 0,
    reconcileErrors: [],
    reconcileAt: 0,
    reconcile: "ok",
  };
}

function wire(v: M2Vault, opts: { isLeader?: () => boolean } = {}) {
  const bus = createResourceChangeBus();
  const published: ResourceChangeEvent[] = [];
  bus.onChange((e) => published.push(e));
  const provider: EmbeddingProvider = fakeEmbeddingProvider({ dimensions: 32 });
  const wiring = wireIndexCoordinator({
    db: v.db,
    embeddingProvider: provider,
    hasVec: false,
    chunkContext: false,
    indexing: { writeConcurrency: 1, writeConcurrencyPerVault: 1, queueMax: 100 },
    // The watcher is only consulted through the mocked registerVaultWatch above, so the vault list
    // and watch config are what the real wiring would receive.
    vaults: [{ id: v.id, path: v.root }],
    watch: { enabled: true, debounceMs: 0 },
    sqlHooksFor: () => ({}),
    indexHealth: health(),
    metrics: new MetricsRecorder(),
    acl: v.acl,
    aclByVault: new Map(),
    makeOnIndexed: () => undefined,
    resourceChangeBus: bus,
    ...(opts.isLeader ? { isLeader: opts.isLeader } : {}),
  });
  return { wiring, published };
}

describe("wireIndexCoordinator publishes note changes to the resource-change bus", () => {
  it("an explicit tool write and an explicit delete each publish their {vaultId, relPath}", async () => {
    const v = makeM2Vault({ files: {} });
    const { wiring, published } = wire(v);
    try {
      wiring.reindexHook(v.id, "notes/a.md", "# A\n\nbody\n");
      wiring.deindexHook(v.id, "notes/a.md");
      await wiring.indexCoordinator.idle();
      expect(published).toEqual([
        { vaultId: "test", relPath: "notes/a.md" },
        { vaultId: "test", relPath: "notes/a.md" },
      ]);
    } finally {
      wiring.stopVaultWatch();
      v.cleanup();
    }
  });

  it("a watcher upsert and a watcher delete publish, even when this process is a follower", async () => {
    const v = makeM2Vault({ files: {} });
    const { wiring, published } = wire(v, { isLeader: () => false });
    try {
      expect(captured.onUpsert).toBeTypeOf("function");
      expect(captured.onDelete).toBeTypeOf("function");
      captured.onUpsert?.(v.id, "notes/w.md", "# W\n\nwatched\n");
      captured.onDelete?.(v.id, "notes/w.md");
      await wiring.indexCoordinator.idle();
      expect(published).toEqual([
        { vaultId: "test", relPath: "notes/w.md" },
        { vaultId: "test", relPath: "notes/w.md" },
      ]);
    } finally {
      wiring.stopVaultWatch();
      v.cleanup();
    }
  });
});

describe("one change to a note is published once, whichever hooks see it", () => {
  const A = { vaultId: "test", relPath: "notes/a.md" };

  it("a tool write the watcher then sees publishes once; a later different content publishes again", async () => {
    const v = makeM2Vault({ files: {} });
    const { wiring, published } = wire(v);
    try {
      wiring.reindexHook(v.id, "notes/a.md", "# A\n\nbody\n");
      captured.onUpsert?.(v.id, "notes/a.md", "# A\n\nbody\n");
      expect(published).toEqual([A]);
      captured.onUpsert?.(v.id, "notes/a.md", "# A\n\nedited outside\n");
      expect(published).toEqual([A, A]);
      // Back to the first content is a change again, not a repeat of the first publish.
      captured.onUpsert?.(v.id, "notes/a.md", "# A\n\nbody\n");
      expect(published).toEqual([A, A, A]);
      await wiring.indexCoordinator.idle();
    } finally {
      wiring.stopVaultWatch();
      v.cleanup();
    }
  });

  it("a tool delete the watcher then sees publishes once; a re-created note publishes again", async () => {
    const v = makeM2Vault({ files: {} });
    const { wiring, published } = wire(v);
    try {
      wiring.reindexHook(v.id, "notes/a.md", "x");
      wiring.deindexHook(v.id, "notes/a.md");
      captured.onDelete?.(v.id, "notes/a.md");
      expect(published).toEqual([A, A]);
      captured.onUpsert?.(v.id, "notes/a.md", "x");
      expect(published).toEqual([A, A, A]);
      await wiring.indexCoordinator.idle();
    } finally {
      wiring.stopVaultWatch();
      v.cleanup();
    }
  });

  it("the same content on two different notes publishes for each", async () => {
    const v = makeM2Vault({ files: {} });
    const { wiring, published } = wire(v);
    try {
      wiring.reindexHook(v.id, "notes/a.md", "same");
      wiring.reindexHook(v.id, "notes/b.md", "same");
      expect(published.map((e) => e.relPath)).toEqual(["notes/a.md", "notes/b.md"]);
      await wiring.indexCoordinator.idle();
    } finally {
      wiring.stopVaultWatch();
      v.cleanup();
    }
  });
});
