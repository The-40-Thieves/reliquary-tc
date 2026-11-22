import { describe, expect, it } from "vitest";
import { makeM4Vault } from "./m4-helpers";

describe("task write idempotency", () => {
  it("replays an update without writing again and rejects different arguments", async () => {
    const vault = makeM4Vault({ files: { "tasks.md": "- [ ] original\n" } });
    try {
      const args = {
        vault: "test",
        path: "tasks.md",
        line: 1,
        set: { description: "changed" },
        idempotency_key: "task-key",
      };
      const first = await vault.call("update_task", args);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      vault.write("tasks.md", "- [ ] replacement\n");
      const replay = await vault.call("update_task", args);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      expect(vault.read("tasks.md")).toBe("- [ ] replacement\n");
      const mismatch = await vault.call("update_task", { ...args, set: { description: "other" } });
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    } finally {
      vault.cleanup();
    }
  });
});
