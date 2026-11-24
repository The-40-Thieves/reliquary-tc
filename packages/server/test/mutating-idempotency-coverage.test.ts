import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { isMutatingDefinition } from "../src/mcp/tool-tags";

const exemptions: Record<string, string> = {
  execute_command: "runs an arbitrary command or template: the arguments do not fix the effect",
  execute_template: "runs an arbitrary command or template: the arguments do not fix the effect",
  trigger_quickadd: "runs an arbitrary command or template: the arguments do not fix the effect",
  remotely_save_trigger: "a pure trigger: a repeat is intended",
  reset_vault_cache: "a pure trigger: a repeat is intended",
  session_rerun: "re-running is the intent",
  show_file_in_obsidian: "switches UI state, writes nothing durable",
  open_workspace: "switches UI state, writes nothing durable",
  cancel_task: "registered inline, naturally idempotent",
};

describe("mutating tool idempotency coverage", () => {
  const mutating = buildFullRegistry().list().filter(isMutatingDefinition);
  it("covers every mutating tool", () => {
    const missing = mutating.filter(
      (tool) => !tool.acceptsIdempotencyKey && !exemptions[tool.name],
    );
    expect(missing.map((tool) => tool.name).sort()).toEqual([]);
  });
  it("keeps exemptions current", () => {
    expect(
      Object.keys(exemptions).filter((name) => !mutating.some((tool) => tool.name === name)),
    ).toEqual([]);
  });
  it("checks a nonempty opt-in surface", () => {
    expect(mutating.filter((tool) => tool.acceptsIdempotencyKey).length).toBeGreaterThanOrEqual(60);
  });
});
