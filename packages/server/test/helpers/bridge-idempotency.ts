import { expect } from "vitest";
import type { makeM4Vault } from "../m4-helpers";

export async function checkBridgeReplay(
  v: ReturnType<typeof makeM4Vault>,
  tool: string,
  args: Record<string, unknown>,
  changed: Record<string, unknown>,
  confirmed = false,
): Promise<void> {
  const first = await (confirmed ? v.callConfirmed(tool, args) : v.call(tool, args));
  expect(first.ok, JSON.stringify(first)).toBe(true);
  const replay = await v.call(tool, args);
  expect(replay.ok).toBe(true);
  expect(replay.meta?.idempotent_replay).toBe(true);
  expect(replay.ok && replay.data).toEqual(first.ok && first.data);
  expect(v.bridgeRequests).toHaveLength(1);
  const mismatch = await v.call(tool, { ...args, ...changed });
  expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
}
