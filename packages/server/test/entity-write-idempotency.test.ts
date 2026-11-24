import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeM5Vault } from "./m5-helpers";

describe("entity write idempotency", () => {
  it("replays entity creation and refuses changed arguments", async () => {
    const v = makeM5Vault();
    try {
      const args = {
        vault: "test",
        type: "person",
        name: "Example",
        materialize: false,
        idempotency_key: "entity",
      };
      const first = await v.call("create_entity", args);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      const replay = await v.call("create_entity", args);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      const mismatch = await v.call("create_entity", { ...args, name: "Different" });
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
      expect(
        (v.db.prepare("SELECT COUNT(*) AS n FROM memory_entities").get() as { n: number }).n,
      ).toBe(1);
      if (!first.ok) return;
      const rename = {
        vault: "test",
        entity_id: (first.data as { entity_id: string }).entity_id,
        new_name: "Renamed",
        idempotency_key: "rename",
      };
      const renamed = await v.call("rename_entity", rename);
      expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
      const renameReplay = await v.call("rename_entity", rename);
      expect(renameReplay.meta?.idempotent_replay).toBe(true);
      expect(renameReplay.ok && renameReplay.data).toEqual(renamed.ok && renamed.data);
      const renameMismatch = await v.call("rename_entity", { ...rename, new_name: "Other" });
      expect(renameMismatch.ok ? null : renameMismatch.error.code).toBe("idempotency_key_mismatch");
      const del = { vault: "test", entity_id: rename.entity_id, idempotency_key: "delete-entity" };
      const deleted = await v.callConfirmed("delete_entity", del);
      expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
      const deleteReplay = await v.call("delete_entity", del);
      expect(deleteReplay.meta?.idempotent_replay).toBe(true);
      expect(deleteReplay.ok && deleteReplay.data).toEqual(deleted.ok && deleted.data);
      const deleteMismatch = await v.call("delete_entity", { ...del, permanent: true });
      expect(deleteMismatch.ok ? null : deleteMismatch.error.code).toBe("idempotency_key_mismatch");
      expect(
        (v.db.prepare("SELECT COUNT(*) AS n FROM memory_entities").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      v.cleanup();
    }
  });
  it("leaves the key usable when the entity's note cannot be written", async () => {
    const note = "memory/person/Example.md";
    const v = makeM5Vault({ files: { [note]: "hand-written\n" } });
    try {
      const args = { vault: "test", type: "person", name: "Example", idempotency_key: "refused" };
      const refused = await v.call("create_entity", args);
      expect(refused.ok).toBe(false);
      const rows = () =>
        (v.db.prepare("SELECT COUNT(*) AS n FROM memory_entities").get() as { n: number }).n;
      expect(rows()).toBe(0);
      rmSync(join(v.root, note));
      const retried = await v.call("create_entity", args);
      expect(retried.ok, JSON.stringify(retried)).toBe(true);
      expect(retried.meta?.idempotent_replay).toBeUndefined();
      expect(rows()).toBe(1);
    } finally {
      v.cleanup();
    }
  });
  it("replays relation creation and rejects changed arguments", async () => {
    const v = makeM5Vault();
    try {
      const a = await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "A",
        materialize: false,
      });
      const b = await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "B",
        materialize: false,
      });
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      const args = {
        vault: "test",
        source_id: (a.data as { entity_id: string }).entity_id,
        target_id: (b.data as { entity_id: string }).entity_id,
        relation_type: "knows",
        idempotency_key: "link",
      };
      const first = await v.call("link_entities", args);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      const replay = await v.call("link_entities", args);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      const mismatch = await v.call("link_entities", { ...args, relation_type: "other" });
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
      expect(
        (v.db.prepare("SELECT COUNT(*) AS n FROM memory_relations").get() as { n: number }).n,
      ).toBe(1);
      const unlink = { ...args, idempotency_key: "unlink" };
      const removed = await v.call("unlink_entities", unlink);
      expect(removed.ok, JSON.stringify(removed)).toBe(true);
      const removedReplay = await v.call("unlink_entities", unlink);
      expect(removedReplay.meta?.idempotent_replay).toBe(true);
      expect(removedReplay.ok && removedReplay.data).toEqual(removed.ok && removed.data);
      const unlinkMismatch = await v.call("unlink_entities", { ...unlink, relation_type: "other" });
      expect(unlinkMismatch.ok ? null : unlinkMismatch.error.code).toBe("idempotency_key_mismatch");
      expect(
        (v.db.prepare("SELECT COUNT(*) AS n FROM memory_relations").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      v.cleanup();
    }
  });
});
