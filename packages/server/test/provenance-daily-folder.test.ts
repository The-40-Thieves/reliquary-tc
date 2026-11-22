import { describe, expect, it } from "vitest";
import { classificationFold } from "../src/vault/case-sensitivity";
import { makeTestVault } from "./m1-helpers";

describe("provenance daily folders", () => {
  it("excludes the configured daily folder while retaining other notes", async () => {
    const v = makeTestVault({
      files: {
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "Journal" }),
        "Journal/2026-01-01.md": "daily",
        "claim.md": "claim",
      },
    });
    try {
      const result = await v.call("audit_provenance", { vault: "test" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("audit failed");
      expect((result.data as { missing: string[] }).missing).toEqual(["claim.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("retains the default exclusion without daily configuration", async () => {
    const v = makeTestVault({ files: { "01-daily/x.md": "daily", "claim.md": "claim" } });
    try {
      const result = await v.call("audit_provenance", { vault: "test" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("audit failed");
      expect((result.data as { missing: string[] }).missing).toEqual(["claim.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("matches the folder name by the vault's case rule", async () => {
    const v = makeTestVault({
      files: {
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "journal" }),
        "Journal/2026-01-01.md": "daily",
        "claim.md": "claim",
      },
    });
    try {
      const folds = classificationFold(v.vaultRegistry.resolve(v.id).caseInsensitive);
      const result = await v.call("audit_provenance", { vault: "test" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("audit failed");
      const missing = [...(result.data as { missing: string[] }).missing].sort();
      expect(missing).toEqual(folds ? ["claim.md"] : ["Journal/2026-01-01.md", "claim.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("keeps a sibling folder that only shares the prefix", async () => {
    const v = makeTestVault({
      files: {
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "Journal" }),
        "Journal/2026-01-01.md": "daily",
        "Journal-archive/old.md": "claim",
      },
    });
    try {
      const result = await v.call("audit_provenance", { vault: "test" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("audit failed");
      expect((result.data as { missing: string[] }).missing).toEqual(["Journal-archive/old.md"]);
    } finally {
      v.cleanup();
    }
  });
});
