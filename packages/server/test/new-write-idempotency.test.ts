import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { registerM3Tools } from "../src/tools/m3";
import { registerM6Tools } from "../src/tools/m6";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

let vault: M6Vault | undefined;
afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

const basic = [
  {
    tool: "update_frontmatter",
    input: { vault: "test", path: "a.md", operation: "set", key: "status", value: "draft" },
    changed: { value: "other" },
  },
  {
    tool: "bulk_set_property",
    input: { vault: "test", paths: ["a.md"], key: "status", value: "draft" },
    changed: { value: "other" },
  },
  {
    tool: "prune_hub_links",
    input: { vault: "test", path: "a.md", dry_run: false },
    changed: { remove_duplicates: false },
  },
  {
    tool: "rewrite_link",
    input: { vault: "test", from_target: "Old", to_target: "New", dry_run: false },
    changed: { to_target: "Other" },
  },
];

const structured = [
  {
    tool: "format_table",
    path: "table.md",
    content: "| A | B |\n| --- | --- |\n| 2 | x |\n| 1 | y |\n",
    args: {},
    changed: { table_index: 1 },
  },
  {
    tool: "insert_table_row",
    path: "table.md",
    content: "| A | B |\n| --- | --- |\n| 2 | x |\n| 1 | y |\n",
    args: { values: ["3", "z"] },
    changed: { values: ["4"] },
  },
  {
    tool: "insert_table_column",
    path: "table.md",
    content: "| A | B |\n| --- | --- |\n| 2 | x |\n| 1 | y |\n",
    args: { header: "C" },
    changed: { header: "D" },
  },
  {
    tool: "sort_table_by_column",
    path: "table.md",
    content: "| A | B |\n| --- | --- |\n| 2 | x |\n| 1 | y |\n",
    args: { column: "A" },
    changed: { column: "B" },
  },
  {
    tool: "add_tag",
    path: "tag.md",
    content: "---\ntags: [old]\n---\nbody\n",
    args: { tag: "new" },
    changed: { tag: "other" },
  },
  {
    tool: "remove_tag",
    path: "tag.md",
    content: "---\ntags: [old]\n---\nbody\n",
    args: { tag: "old" },
    changed: { tag: "other" },
  },
  {
    tool: "add_kanban_card",
    path: "board.md",
    content: "---\nkanban-plugin: board\n---\n## Todo\n- [ ] Existing\n## Done\n",
    args: { column: "Todo", text: "New" },
    changed: { text: "Other" },
  },
  {
    tool: "move_kanban_card",
    path: "board.md",
    content: "---\nkanban-plugin: board\n---\n## Todo\n- [ ] Existing\n## Done\n",
    args: { from_column: "Todo", to_column: "Done", card_text: "Existing" },
    changed: { to_column: "Todo" },
  },
  {
    tool: "update_base",
    path: "a.base",
    content: "views: []\n",
    args: { patch: { formulas: { a: "1" } } },
    changed: { patch: { formulas: { a: "2" } } },
  },
  {
    tool: "update_canvas",
    path: "a.canvas",
    content: '{"nodes":[],"edges":[]}',
    args: {
      add_nodes: [{ id: "n", type: "text", text: "hello", x: 0, y: 0, width: 100, height: 100 }],
    },
    changed: { add_nodes: [] },
  },
];

const workspace = [
  {
    tool: "add_bookmark",
    file: ".obsidian/bookmarks.json",
    content: '{"items":[]}',
    args: { bookmark: { type: "file", path: "a.md" } },
    changed: { bookmark: { type: "file", path: "b.md" } },
  },
  {
    tool: "remove_bookmark",
    file: ".obsidian/bookmarks.json",
    content: '{"items":[{"type":"file","path":"a.md"}]}',
    args: { match: { path: "a.md" } },
    changed: { match: { path: "b.md" } },
  },
  {
    tool: "save_workspace",
    file: ".obsidian/workspaces.json",
    content: '{"workspaces":{}}',
    args: { name: "one", layout: {} },
    changed: { name: "two" },
  },
];

const allCases = [
  ...basic.map(({ tool, input, changed }) => ({
    tool,
    file: "a.md",
    content: "[[Old]] [[Old]]\n",
    files: { "a.md": "[[Old]] [[Old]]\n", "Old.md": "old\n" },
    input,
    changed,
    m6: true,
  })),
  ...structured.map(({ tool, path, content, args, changed }) => ({
    tool,
    file: path,
    content,
    files: { [path]: content },
    input: { vault: "test", path, ...args },
    changed,
    m6: false,
  })),
  ...workspace.map(({ tool, file, content, args, changed }) => ({
    tool,
    file,
    content,
    files: { [file]: content },
    input: { vault: "test", ...args },
    changed,
    m6: false,
  })),
  {
    tool: "delete_attachment",
    file: "a.png",
    content: "original",
    files: { "a.png": "original" },
    input: { vault: "test", path: "a.png" },
    changed: { permanent: true },
    m6: false,
  },
];

function fixture(files: Parameters<typeof makeM6Vault>[0]["files"], m6: boolean): M6Vault {
  return makeM6Vault({
    files,
    register: (registry, deps) =>
      m6 ? registerM6Tools(registry, deps) : registerM3Tools(registry, deps),
  });
}

describe("write idempotency keys", () => {
  it.each(allCases)(
    "replays $tool and refuses changed arguments",
    async ({ tool, file, content, files, input, changed, m6 }) => {
      vault = fixture(files, m6);
      const args = { ...input, idempotency_key: `key-${tool}` };
      let first = await vault.call(tool, args);
      if (!first.ok && first.error.code === "elicit_required") {
        const details = first.error.details as { args_hash: string };
        const token = issueElicitToken(vault.db, {
          vaultId: "test",
          toolName: tool,
          argsHash: details.args_hash,
          caller: "test",
        });
        first = await vault.call(tool, args, { elicitToken: token });
      }
      expect(first.ok, JSON.stringify(first)).toBe(true);
      vault.write(file, content);
      const replay = await vault.call(tool, args);
      expect(replay.ok, JSON.stringify(replay)).toBe(true);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      expect(vault.read(file)).toBe(content);
      const mismatch = await vault.callConfirmed(tool, { ...args, ...changed });
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    },
  );
});
