import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeTestVault } from "./m1-helpers";

describe("restore idempotency", () => {
  it("replays without overwriting again and rejects changed arguments", async () => {
    const v = makeTestVault({
      files: { "a.md": "original" },
      snapshots: { enabled: true, retention: 10 },
    });
    try {
      const snap = await v.call("snapshot_note", { vault: "test", path: "a.md" });
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      v.write("a.md", "current");
      const args = {
        vault: "test",
        path: "a.md",
        snapshot_id: (snap.data as { snapshot_id: number }).snapshot_id,
        idempotency_key: "restore",
      };
      const need = await v.call("restore_note", args);
      expect(need.ok ? null : need.error.code, JSON.stringify(need)).toBe("elicit_required");
      if (need.ok) return;
      const token = issueElicitToken(v.db, {
        vaultId: "test",
        toolName: "restore_note",
        argsHash: (need.error.details as { args_hash: string }).args_hash,
        caller: "test",
      });
      const first = await v.call("restore_note", args, { elicitToken: token });
      expect(first.ok, JSON.stringify(first)).toBe(true);
      expect(v.read("a.md")).toBe("original");
      v.write("a.md", "replacement");
      const replay = await v.call("restore_note", args);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      expect(v.read("a.md")).toBe("replacement");
      const mismatch = await v.call("restore_note", { ...args, path: "other.md" });
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    } finally {
      v.cleanup();
    }
  });
});
