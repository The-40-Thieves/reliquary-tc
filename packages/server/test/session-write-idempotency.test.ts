import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeM5Vault } from "./m5-helpers";

describe("session end idempotency", () => {
  it("replays the end without appending another trace", async () => {
    const v = makeM5Vault();
    try {
      const start = await v.call("start_session", { vault: "test", caller: "test" });
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const session = start.data as { session_id: string; trace_path: string };
      const args = { vault: "test", session_id: session.session_id, idempotency_key: "end-key" };
      const first = await v.call("end_session", args);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      const trace = readFileSync(join(v.cacheDir, session.trace_path), "utf8");
      const replay = await v.call("end_session", args);
      expect(replay.ok).toBe(true);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      expect(readFileSync(join(v.cacheDir, session.trace_path), "utf8")).toBe(trace);
      const mismatch = await v.call("end_session", { ...args, end_metadata: { x: 1 } });
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    } finally {
      v.cleanup();
    }
  });
});
