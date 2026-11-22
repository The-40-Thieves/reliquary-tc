import { describe, expect, it } from "vitest";
import { makeWikiHarness } from "./wiki-test-helpers";

describe("wiki commit idempotency", () => {
  it("replays without writing again and refuses changed arguments", async () => {
    const h = makeWikiHarness({ wikiFolder: "wiki" });
    try {
      const args = {
        vault: "test",
        page: { path: "wiki/Topic.md", frontmatter: {}, body: "# Topic\n" },
        idempotency_key: "wiki",
      };
      const first = await h.v.call("commit_wiki_page", args);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      h.v.write("wiki/Topic.md", "replacement");
      const replay = await h.v.call("commit_wiki_page", args);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      expect(h.v.read("wiki/Topic.md")).toBe("replacement");
      const mismatch = await h.v.call("commit_wiki_page", {
        ...args,
        page: { ...args.page, body: "different" },
      });
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    } finally {
      h.v.cleanup();
    }
  });
});
