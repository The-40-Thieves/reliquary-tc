import { describe, it } from "vitest";
import { checkBridgeReplay } from "./helpers/bridge-idempotency";
import { makeM4Vault } from "./m4-helpers";

describe("excalidraw write idempotency", () => {
  it.each(["create_excalidraw", "update_excalidraw"])(
    "replays %s without another bridge call",
    async (tool) => {
      const v = makeM4Vault({
        installed: ["excalidraw"],
        routes: {
          "POST /obsidian-tc/v1/excalidraw/write": {
            body: { ok: true, result: { path: "drawing.md", plugin_used: true } },
          },
        },
      });
      try {
        const args = { vault: "test", path: "drawing.md", idempotency_key: tool };
        await checkBridgeReplay(v, tool, args, { path: "other.md" });
      } finally {
        v.cleanup();
      }
    },
  );
});
