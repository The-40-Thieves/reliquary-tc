import { describe, expect, it } from "vitest";
import { makeM5Vault } from "./m5-helpers";

describe("capture commit idempotency", () => {
  it("replays without writing again and rejects different arguments", async () => {
    const v = makeM5Vault();
    try {
      const enqueued = await v.call("enqueue_capture", { vault: "test", content: "captured body" });
      expect(enqueued.ok).toBe(true);
      if (!enqueued.ok) return;
      const args = {
        vault: "test",
        capture_id: (enqueued.data as { capture_id: string }).capture_id,
        target_path: "note.md",
        idempotency_key: "commit-capture",
      };
      const first = await v.call("commit_capture", args);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      v.write("note.md", "replacement");
      const replay = await v.call("commit_capture", args);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      expect(v.read("note.md")).toBe("replacement");
      const mismatch = await v.call("commit_capture", { ...args, target_path: "other.md" });
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    } finally {
      v.cleanup();
    }
  });
});
