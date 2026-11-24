import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

describe("periodic note idempotency", () => {
  it("replays creation without writing again and rejects changed arguments", async () => {
    const v = makeM3Vault();
    try {
      const args = {
        vault: "test",
        period: "daily",
        date: "2026-01-15",
        idempotency_key: "periodic",
      };
      const first = await v.call("find_or_create_periodic_note", args);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      if (!first.ok) return;
      const path = (first.data as { path: string }).path;
      v.write(path, "replacement");
      const replay = await v.call("find_or_create_periodic_note", args);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.data);
      expect(v.read(path)).toBe("replacement");
      const mismatch = await v.call("find_or_create_periodic_note", {
        ...args,
        date: "2026-01-16",
      });
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    } finally {
      v.cleanup();
    }
  });
});
