import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

describe("provenance vault settings", () => {
  for (const [path, json] of [
    [".obsidian/templates.json", '{"folder":"Meta/Tpl"}'],
    [".obsidian/plugins/templater-obsidian/data.json", '{"templates_folder":"Meta/Tpl"}'],
  ] as const) {
    it(`excludes the configured folder in ${path}`, async () => {
      const v = makeTestVault({ files: { "Meta/Tpl/note.md": "claim" } });
      try {
        const before = await v.call("audit_provenance", { vault: "test" });
        expect(before.ok && (before.data as { missing: string[] }).missing).toContain(
          "Meta/Tpl/note.md",
        );
        v.write(path, json);
        const after = await v.call("audit_provenance", { vault: "test" });
        expect(after.ok && (after.data as { missing: string[] }).missing).not.toContain(
          "Meta/Tpl/note.md",
        );
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
