import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import type { CallerContext } from "../src/mcp/registry";
import { parseResourceUri } from "../src/mcp/resources";
import { buildSearchMentionsTool, SearchMentionsInput } from "../src/tools/m2/search-mentions-tool";
import { VaultRegistry } from "../src/vault/registry";
import { makeTestVault, type TestVault, type TestVaultOptions } from "./m1-helpers";
import { makeTempDir, rmTemp } from "./tmp";

interface Item {
  type: string;
  uri: string;
  name: string;
  title?: string;
  mimeType?: string;
}

/** A test vault with the mentions tool registered on top of the M1 tools. */
function vaultWith(
  files: Record<string, string>,
  extra: Partial<TestVaultOptions> = {},
  metadataReady?: () => boolean,
): TestVault {
  return makeTestVault({
    ...extra,
    files,
    registerTools: (registry, vaultRegistry) => {
      const metadataIndex = metadataReady ? { hasFts: false, ready: metadataReady } : undefined;
      registry.register(
        buildSearchMentionsTool({ vaultRegistry, metadataIndex }, (id) => registry.aclFor(id)),
      );
    },
  });
}

/** Set a note's mtime to `epochSeconds`, so recency ordering is deterministic. */
function setMtime(v: TestVault, rel: string, epochSeconds: number): void {
  utimesSync(join(v.root, rel), epochSeconds, epochSeconds);
}

async function mentionTitles(v: TestVault, query: string, limit?: number): Promise<string[]> {
  const r = await v.call("search_mentions", {
    vault: "test",
    query,
    ...(limit === undefined ? {} : { limit }),
  });
  if (!r.ok) throw new Error(`search_mentions failed: ${r.error.code}`);
  return (r.data as { items: Item[] }).items.map((i) => i.title ?? "");
}

describe("search_mentions ranking", () => {
  it("a file-name match ranks before a path-only match, even when the path match is newer", async () => {
    const v = vaultWith({
      "projects/alpha-plan.md": "a",
      "notes/plan-ideas.md": "b",
      "plans/readme.md": "c",
    });
    try {
      setMtime(v, "projects/alpha-plan.md", 1000);
      setMtime(v, "notes/plan-ideas.md", 2000);
      setMtime(v, "plans/readme.md", 3000);
      expect(await mentionTitles(v, "plan")).toEqual([
        "notes/plan-ideas.md",
        "projects/alpha-plan.md",
        "plans/readme.md",
      ]);
    } finally {
      v.cleanup();
    }
  });

  it("matches the file name case-insensitively and without the .md suffix", async () => {
    const v = vaultWith({ "Inbox/Weekly-Review.md": "x", "other.md": "y" });
    try {
      expect(await mentionTitles(v, "WEEKLY")).toEqual(["Inbox/Weekly-Review.md"]);
      expect(await mentionTitles(v, "Weekly-Review")).toEqual(["Inbox/Weekly-Review.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("an empty query returns the most recently modified notes first", async () => {
    const v = vaultWith({ "old.md": "1", "new.md": "2", "mid.md": "3" });
    try {
      setMtime(v, "old.md", 1000);
      setMtime(v, "mid.md", 2000);
      setMtime(v, "new.md", 3000);
      expect(await mentionTitles(v, "")).toEqual(["new.md", "mid.md", "old.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("only markdown notes are offered", async () => {
    const v = vaultWith({ "a.md": "x", "image.png": "not a note", "b.txt": "text" });
    try {
      expect(await mentionTitles(v, "")).toEqual(["a.md"]);
    } finally {
      v.cleanup();
    }
  });
});

describe("search_mentions filters", () => {
  it("a note the caller's path ACL denies is absent", async () => {
    const v = vaultWith(
      { "open/visible.md": "x", "secret/hidden.md": "y" },
      { acl: { readPaths: ["open/**"] } },
    );
    try {
      expect(await mentionTitles(v, "")).toEqual(["open/visible.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("a note under an Obsidian Excluded folder is absent", async () => {
    const v = vaultWith({
      ".obsidian/app.json": JSON.stringify({ userIgnoreFilters: ["Archive/"] }),
      "Archive/old.md": "x",
      "live/new.md": "y",
    });
    try {
      expect(await mentionTitles(v, "")).toEqual(["live/new.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("the notes table path applies the same ACL, and drops unresolved, missing and outside rows", async () => {
    const v = vaultWith({ "a.md": "x", "b.md": "y" }, {}, () => true);
    try {
      const ins = v.db.prepare(
        "INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at, acl_path) VALUES (?, ?, ?, '[]', NULL, 'h', ?, 1, 1, ?)",
      );
      ins.run("test", "a.md", "a", 1000, "a.md");
      ins.run("test", "b.md", "b", 3000, "b.md");
      ins.run("test", "ghost.md", "ghost", 5000, "ghost.md");
      ins.run("test", "unresolved.md", "u", 6000, null);
      ins.run("test", "../escape.md", "e", 7000, "../escape.md");
      expect(await mentionTitles(v, "")).toEqual(["b.md", "a.md"]);
    } finally {
      v.cleanup();
    }
  });
});

describe("search_mentions output", () => {
  it("every item is a resource_link whose uri round-trips to the same vault and path", async () => {
    const v = vaultWith({ "dir/sp ace#1.md": "x", "b.md": "y" });
    try {
      const r = await v.call("search_mentions", { vault: "test", query: "" });
      if (!r.ok) throw new Error(r.error.code);
      const items = (r.data as { items: Item[] }).items;
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.type).toBe("resource_link");
        expect(item.mimeType).toBe("text/markdown");
        const parsed = parseResourceUri(item.uri);
        expect(parsed.vaultId).toBe("test");
        expect(parsed.relPath).toBe(item.title);
        expect(item.name).toBe((item.title ?? "").split("/").pop()?.replace(/\.md$/, ""));
      }
    } finally {
      v.cleanup();
    }
  });

  it("limit is honoured, and a limit above 50 is refused", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`n${i}.md`] = "x";
    const v = vaultWith(files);
    try {
      expect(await mentionTitles(v, "", 2)).toHaveLength(2);
      const over = await v.call("search_mentions", { vault: "test", query: "", limit: 51 });
      expect(over.ok).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});

const OPEN = { readOnly: false, defaultScopes: [], rules: [] };
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmTemp(d);
});

/** Two vaults, `main` and `work`, each holding Hello.md; `workAcl` governs `work` only. */
function twoVaults(workAcl?: FolderAcl) {
  const vaults = ["main", "work"].map((id) => {
    const path = makeTempDir("obtc-mentions-multi-");
    tmp.push(path);
    writeFileSync(join(path, "Hello.md"), "# Hello\n");
    return { id, path };
  });
  const vaultRegistry = new VaultRegistry(vaults);
  const tool = buildSearchMentionsTool({ vaultRegistry }, (id) =>
    id === "work" ? workAcl : undefined,
  );
  return async (ctx: Partial<CallerContext>): Promise<string[]> => {
    const full = {
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "main",
      acl: new FolderAcl(OPEN),
      db: {} as never,
      ...ctx,
    } as CallerContext;
    const out = (await tool.handler(SearchMentionsInput.parse({ query: "hel" }), full)) as {
      items: Array<{ uri: string }>;
    };
    return out.items.map((i) => parseResourceUri(i.uri).vaultId).sort();
  };
}

describe("search_mentions with no vault argument", () => {
  it("searches every vault for a trusted, unbound caller", async () => {
    expect(await twoVaults()({})).toEqual(["main", "work"]);
  });

  it("searches only the caller's own vault for a vault-bound caller", async () => {
    expect(await twoVaults()({ vaultBound: true })).toEqual(["main"]);
  });

  it("judges each vault by its own ACL, not the caller's default", async () => {
    const closed = new FolderAcl({ ...OPEN, readPaths: [] });
    expect(await twoVaults(closed)({})).toEqual(["main"]);
  });
});
