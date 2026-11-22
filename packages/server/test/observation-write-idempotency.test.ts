import { describe, expect, it } from "vitest";
import { makeM5Vault } from "./m5-helpers";

describe("observation write idempotency", () => {
  it("replays a correction and rejects different arguments", async () => {
    const v = makeM5Vault();
    try {
      const created = await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "Example",
        observations: ["old"],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const entity = created.data as {
        entity_id: string;
        observations: { observation_id: string }[];
      };
      const args = {
        vault: "test",
        entity_id: entity.entity_id,
        observation_id: entity.observations[0]?.observation_id,
        observation: "new",
        idempotency_key: "observation-key",
      };
      const first = await v.call("update_observation", args);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      const replay = await v.call("update_observation", args);
      expect(replay.ok).toBe(true);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      const mismatch = await v.call("update_observation", { ...args, observation: "different" });
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    } finally {
      v.cleanup();
    }
  });
});
