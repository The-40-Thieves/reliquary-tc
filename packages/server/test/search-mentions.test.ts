import { linkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
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

interface TwoVaultOptions {
  /** Governs `work` only. */
  workAcl?: FolderAcl;
  boundVaultOnly?: boolean;
  /** Runs once per vault root after Hello.md is written. */
  setup?: (root: string, id: string) => void;
}

/** Two vaults, `main` and `work`, each holding Hello.md. The returned call answers the hits as
 *  sorted `<vault>/<path>` strings. */
function twoVaultRegistry(opts: TwoVaultOptions = {}): VaultRegistry {
  const vaults = ["main", "work"].map((id) => {
    const path = makeTempDir("obtc-mentions-multi-");
    tmp.push(path);
    writeFileSync(join(path, "Hello.md"), "# Hello\n");
    opts.setup?.(path, id);
    return { id, path };
  });
  return new VaultRegistry(vaults, undefined, undefined, { boundVaultOnly: opts.boundVaultOnly });
}

function twoVaults(opts: TwoVaultOptions = {}) {
  const vaultRegistry = twoVaultRegistry(opts);
  const tool = buildSearchMentionsTool({ vaultRegistry }, (id) =>
    id === "work" ? opts.workAcl : undefined,
  );
  return async (ctx: Partial<CallerContext>, vault?: string): Promise<string[]> => {
    const full = {
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "main",
      acl: new FolderAcl(OPEN),
      db: {} as never,
      ...ctx,
    } as CallerContext;
    const input = SearchMentionsInput.parse({ query: "hello", ...(vault ? { vault } : {}) });
    const out = (await tool.handler(input, full)) as { items: Array<{ uri: string }> };
    return out.items
      .map((i) => parseResourceUri(i.uri))
      .map((u) => `${u.vaultId}/${u.relPath}`)
      .sort();
  };
}

describe("search_mentions with no vault argument", () => {
  it("searches every vault for a trusted, unbound caller", async () => {
    expect(await twoVaults()({})).toEqual(["main/Hello.md", "work/Hello.md"]);
  });

  it("searches only the caller's own vault for a vault-bound caller", async () => {
    expect(await twoVaults()({ vaultBound: true })).toEqual(["main/Hello.md"]);
  });

  it("judges each vault by its own ACL, not the caller's default", async () => {
    const workAcl = new FolderAcl({ ...OPEN, readPaths: [] });
    expect(await twoVaults({ workAcl })({})).toEqual(["main/Hello.md"]);
  });
});

describe("search_mentions offers only links resources/read opens", () => {
  it("leaves out a hard-linked note, which every read refuses", async () => {
    const setup = (root: string, id: string) => {
      if (id !== "main") return;
      writeFileSync(join(root, "Hello-a.md"), "a\n");
      linkSync(join(root, "Hello-a.md"), join(root, "Hello-b.md"));
    };
    expect(await twoVaults({ setup })({})).toEqual(["main/Hello.md", "work/Hello.md"]);
  });

  it("under resources.boundVaultOnly, a named foreign vault returns nothing", async () => {
    const call = twoVaults({ boundVaultOnly: true });
    expect(await call({}, "work")).toEqual([]);
    expect(await call({}, "main")).toEqual(["main/Hello.md"]);
  });
});

describe("search_mentions through dispatch", () => {
  // Dispatch re-points ctx.vaultId at the named vault before the handler runs, so the guard has to
  // judge the caller's own vault, not the one the call acts on.
  it("under resources.boundVaultOnly, a named foreign vault still returns nothing", async () => {
    const vaultRegistry = twoVaultRegistry({ boundVaultOnly: true });
    const registry = new ToolRegistry({
      rootResolver: () => undefined,
      visibleVaultIds: () => ["main", "work"],
    });
    registry.register(buildSearchMentionsTool({ vaultRegistry }, (id) => registry.aclFor(id)));
    const ctx: CallerContext = {
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "main",
      db: {} as never,
    };
    const foreign = await registry.dispatch("search_mentions", { query: "", vault: "work" }, ctx);
    if (!foreign.ok) throw new Error(foreign.error.code);
    expect((foreign.data as { items: Item[] }).items).toEqual([]);
    const own = await registry.dispatch("search_mentions", { query: "", vault: "main" }, ctx);
    if (!own.ok) throw new Error(own.error.code);
    expect((own.data as { items: Item[] }).items.map((i) => i.title)).toEqual(["Hello.md"]);
  });
});

describe("search_mentions cost per call", () => {
  it("resolves the ACL identity only of the rows it offers, not of every indexed note", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`n${i}.md`] = "x";
    const v = vaultWith(files, {}, () => true);
    try {
      const ins = v.db.prepare(
        "INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at, acl_path) VALUES (?, ?, ?, '[]', NULL, 'h', ?, 1, 1, ?)",
      );
      for (let i = 0; i < 30; i++) ins.run("test", `n${i}.md`, `n${i}`, 1000 + i, `n${i}.md`);
      const db = v.db as unknown as { prepare: (sql: string) => unknown };
      const prepare = db.prepare.bind(v.db);
      let identityLookups = 0;
      db.prepare = (sql: string) => {
        if (sql.includes("SELECT DISTINCT acl_path")) identityLookups++;
        return prepare(sql);
      };
      expect(await mentionTitles(v, "", 2)).toEqual(["n29.md", "n28.md"]);
      expect(identityLookups).toBeGreaterThan(0);
      expect(identityLookups).toBeLessThan(10);
    } finally {
      v.cleanup();
    }
  });
});
