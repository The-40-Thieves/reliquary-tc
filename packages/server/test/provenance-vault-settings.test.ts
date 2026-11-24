import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

describe("provenance vault settings", () => {
  for (const [path, json] of [
    [".obsidian/templates.json", '{"folder":"Meta/Tpl"}'],
    [".obsidian/plugins/templater-obsidian/data.json", '{"templates_folder":"Meta/Tpl"}'],
  ] as const) {
    it(`excludes the configured folder in ${path}`, async () => {
      const v = makeTestVault({
        files: {
          "Meta/Tpl/note.md": "claim",
          "Meta/Tpl-archive/note.md": "claim",
          "Meta/Tplx/note.md": "claim",
        },
      });
      try {
        const before = await v.call("audit_provenance", { vault: "test" });
        expect(before.ok && (before.data as { missing: string[] }).missing).toContain(
          "Meta/Tpl/note.md",
        );
        v.write(path, json);
        const after = await v.call("audit_provenance", { vault: "test" });
        const missing = after.ok ? (after.data as { missing: string[] }).missing : [];
        expect(missing).not.toContain("Meta/Tpl/note.md");
        // A folder that only shares the prefix is not the template folder.
        expect(missing).toContain("Meta/Tpl-archive/note.md");
        expect(missing).toContain("Meta/Tplx/note.md");
      } finally {
        v.cleanup();
      }
    });
  }
  for (const key of ["source", "references"]) {
    it(`recognizes ${key} only when the field is implicit`, async () => {
      const v = makeTestVault({
        files: { "note.md": `---\n${key}: https://example.org\n---\nclaim` },
      });
      try {
        const implicit = await v.call("audit_provenance", { vault: "test" });
        expect(implicit.ok && (implicit.data as { missing: string[] }).missing).not.toContain(
          "note.md",
        );
        expect(
          implicit.ok && (implicit.data as { field_aliases: Record<string, string> }).field_aliases,
        ).toEqual({ "note.md": key });
        const explicit = await v.call("audit_provenance", { vault: "test", field: "sources" });
        expect(explicit.ok && (explicit.data as { missing: string[] }).missing).toContain(
          "note.md",
        );
      } finally {
        v.cleanup();
      }
    });
  }
  it("caps field_aliases at the limit and reports how many there were", async () => {
    const v = makeTestVault({
      files: {
        "a.md": "---\nsource: https://example.org\n---\nclaim",
        "b.md": "---\nsource: https://example.org\n---\nclaim",
        "c.md": "---\nreferences: https://example.org\n---\nclaim",
      },
    });
    try {
      const result = await v.call("audit_provenance", { vault: "test", limit: 2 });
      const data = result.ok
        ? (result.data as { field_aliases: Record<string, string>; field_aliases_count: number })
        : undefined;
      expect(Object.keys(data?.field_aliases ?? {})).toHaveLength(2);
      expect(data?.field_aliases_count).toBe(3);
    } finally {
      v.cleanup();
    }
  });
  it("resolves the type key per folder, not once for the vault", async () => {
    const v = makeTestVault({
      files: {
        "A/SCHEMA.md": "---\nconventions:\n  frontmatter:\n    type_key: kind\n---\n",
        "A/one.md": "---\nkind: claim\n---\nclaim",
        "A/two.md": "---\nkind: claim\n---\nclaim",
        "B/three.md": "---\ntype: claim\n---\nclaim",
        "B/four.md": "---\nkind: claim\n---\nclaim",
      },
    });
    try {
      const result = await v.call("audit_provenance", { vault: "test", types: ["claim"] });
      const missing = result.ok ? (result.data as { missing: string[] }).missing : [];
      expect(missing).toEqual(expect.arrayContaining(["A/one.md", "A/two.md", "B/three.md"]));
      expect(missing).not.toContain("B/four.md");
    } finally {
      v.cleanup();
    }
  });
  it("filters using the resolved type key", async () => {
    const v = makeTestVault({
      files: {
        "SCHEMA.md": "---\nconventions:\n  frontmatter:\n    type_key: kind\n---\n",
        "note.md": "---\nkind: claim\n---\nclaim",
      },
    });
    try {
      const result = await v.call("audit_provenance", { vault: "test", types: ["claim"] });
      expect(result.ok && (result.data as { missing: string[] }).missing).toContain("note.md");
    } finally {
      v.cleanup();
    }
  });
});
