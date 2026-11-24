import { describe, expect, it } from "vitest";
import { checkBridgeReplay } from "./helpers/bridge-idempotency";
import { makeM4Vault } from "./m4-helpers";

describe("excalidraw write idempotency", () => {
  it.each([
    ["create_excalidraw", {}],
    ["update_excalidraw", { remove_element_ids: ["gone"], update_app_state: { zoom: 2 } }],
  ] as const)("replays %s without another bridge call", async (tool, edit) => {
    const v = makeM4Vault({
      installed: ["excalidraw"],
      routes: {
        "POST /obsidian-tc/v1/excalidraw/write": {
          body: { ok: true, result: { path: "drawing.md", plugin_used: true } },
        },
      },
    });
    try {
      const args = { vault: "test", path: "drawing.md", ...edit, idempotency_key: tool };
      await checkBridgeReplay(v, tool, args, { path: "other.md" });
      // The update reached the bridge with its edit, not as an empty no-op.
      const sent = String(v.bridgeRequests[0]?.body);
      for (const id of "remove_element_ids" in edit ? edit.remove_element_ids : [])
        expect(sent).toContain(id);
    } finally {
      v.cleanup();
    }
  });
});
