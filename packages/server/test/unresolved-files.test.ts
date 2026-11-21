import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

describe("unresolved links to files", () => {
  it("resolves readable files by path and basename, but not missing files", async () => {
    const v = makeTestVault({
      files: {
        "note.md":
          "![[TaskNotes/Views/tasks-default.base]] [[Scripts/Vault-Audit.mjs]] [[PICTURE.png]] [[x.base]] " +
          "![page](docs/manual.pdf#page=2) [[manual.pdf#page=3]]",
        "TaskNotes/Views/tasks-default.base": "",
        "scripts/vault-audit.mjs": "",
        "images/picture.png": "",
        "docs/manual.pdf": "",
      },
    });
    try {
      const r = await v.call("find_unresolved_links", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(
          (r.data as { unresolved: Array<{ target: string }> }).unresolved.map((x) => x.target),
        ).toEqual(["x.base"]);
      const health = await v.call("vault_health_score", { vault: "test" });
      expect(health.ok).toBe(true);
      if (health.ok)
        expect(
          (health.data as { metrics: { unresolved_links: number } }).metrics.unresolved_links,
        ).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("does not reveal a file outside the read allowlist", async () => {
    const options = { acl: { readPaths: ["public/**"] } };
    const present = makeTestVault({
      ...options,
      files: { "public/note.md": "[[private/secret.base]]", "private/secret.base": "" },
    });
    const missing = makeTestVault({
      ...options,
      files: { "public/note.md": "[[private/secret.base]]" },
    });
    try {
      const a = await present.call("find_unresolved_links", { vault: "test" });
      const b = await missing.call("find_unresolved_links", { vault: "test" });
      expect(a.ok && a.data).toEqual(b.ok && b.data);
      expect(a.ok).toBe(true);
      if (a.ok) expect((a.data as { total: number }).total).toBe(1);
    } finally {
      present.cleanup();
      missing.cleanup();
    }
  });
});
