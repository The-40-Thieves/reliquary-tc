import { afterEach, expect, it, vi } from "vitest";
import { revokeFamily, revokeGrant } from "../src/auth/as-grants";
import { cleanupFlows, issue, makeFlow, mcpPing, rows } from "./as-flow-harness";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFlows();
});

it.each(["family", "grant"] as const)("refuses a pending %s revocation", async (kind) => {
  const flow = await makeFlow();
  const token = await issue(flow);
  vi.spyOn(flow.registry, "revoke").mockImplementation(() => {
    throw new Error("busy");
  });
  const family = rows<{ family_id: string }>(flow, "SELECT family_id FROM refresh_tokens")[0]
    ?.family_id as string;
  const grant = rows<{ id: string }>(flow, "SELECT id FROM grants")[0]?.id as string;
  expect(() =>
    kind === "family"
      ? revokeFamily(flow.db, flow.registry, family, "test", flow.clock.t)
      : revokeGrant(flow.db, flow.registry, grant, "test", flow.clock.t),
  ).toThrow("busy");
  expect(rows(flow, "SELECT 1 FROM revocation_outbox").length).toBeGreaterThan(0);
  expect(await mcpPing(flow, token.access)).toBe(401);
});

it("accepts an unrevoked token", async () => {
  const flow = await makeFlow();
  const token = await issue(flow);
  expect(await mcpPing(flow, token.access)).toBe(200);
});

it("refuses a token when the outbox lookup fails", async () => {
  const flow = await makeFlow();
  const token = await issue(flow);
  expect(await mcpPing(flow, token.access)).toBe(200);
  flow.db.exec("DROP TABLE revocation_outbox");
  expect(await mcpPing(flow, token.access)).toBe(401);
});
