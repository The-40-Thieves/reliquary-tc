import { describe, it } from "vitest";
import { checkBridgeReplay } from "./helpers/bridge-idempotency";
import { makeM4Vault } from "./m4-helpers";

describe("git write idempotency", () => {
  it.each([
    {
      tool: "git_stage",
      route: "stage",
      input: { paths: ["a.md"] },
      changed: { paths: ["b.md"] },
      result: { staged: 1 },
      confirmed: false,
    },
    {
      tool: "git_commit",
      route: "commit",
      input: { message: "snapshot" },
      changed: { message: "another snapshot" },
      result: { committed: 1, fired_at: "t" },
      confirmed: true,
    },
  ])(
    "replays $tool without another bridge request",
    async ({ tool, route, input, changed, result, confirmed }) => {
      const v = makeM4Vault({
        installed: ["git"],
        files: { "a.md": "a", "b.md": "b" },
        routes: { [`POST /obsidian-tc/v1/git/${route}`]: { body: { ok: true, result } } },
      });
      try {
        const args = { vault: "test", ...input, idempotency_key: tool };
        await checkBridgeReplay(v, tool, args, changed, confirmed);
      } finally {
        v.cleanup();
      }
    },
  );
});
