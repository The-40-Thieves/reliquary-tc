import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintTargets } from "../src/elicit-drift";
import { argsHash } from "../src/hash";
import { enforcePathAcl } from "../src/vault/acl-path";

const mocked = vi.hoisted(() => ({ unknownPath: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      const stat = fs.statSync(...args);
      if (String(args[0]) === mocked.unknownPath && stat)
        return { ...stat, nlink: Number.NaN, isFile: () => true };
      return stat;
    },
  };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "confirmation-read-"));
});
afterEach(() => {
  mocked.unknownPath = "";
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("confirmation checked reads", () => {
  it("refuses a hard-linked target", () => {
    writeFileSync(join(root, "original.md"), "secret");
    linkSync(join(root, "original.md"), join(root, "hl.md"));
    expect(() => fingerprintTargets(root, ["hl.md"])).toThrow(/hard-linked file/);
    try {
      fingerprintTargets(root, ["hl.md"]);
    } catch (error) {
      expect(error).toMatchObject({ code: "acl_denied" });
    }
  });
  it("preserves the ordinary fingerprint", () => {
    const path = join(root, "ordinary.md");
    writeFileSync(path, "ordinary bytes");
    const st = statSync(path);
    const hash = createHash("sha256").update("ordinary bytes").digest("hex");
    const state = `file:${hash}:${st.size}:${st.mtimeMs}:${st.ino}`;
    expect(fingerprintTargets(root, ["ordinary.md"])).toBe(
      argsHash("state", { "ordinary.md": state }),
    );
  });
  it("preserves absent targets", () => {
    expect(fingerprintTargets(root, ["new.md"])).toBe(argsHash("state", { "new.md": "absent" }));
  });
  it("distinguishes an unknown link count at the ACL refusal", () => {
    writeFileSync(join(root, "unknown.md"), "x");
    mocked.unknownPath = join(root, "unknown.md");
    expect(() => enforcePathAcl(undefined, "read", "unknown.md", root, [])).toThrow(
      "refusing a file whose link count cannot be read",
    );
  });
  it("retains the hard-link ACL refusal", () => {
    writeFileSync(join(root, "original.md"), "x");
    linkSync(join(root, "original.md"), join(root, "hl.md"));
    expect(() => enforcePathAcl(undefined, "read", "hl.md", root, [])).toThrow(
      "refusing a hard-linked file (inode aliasing)",
    );
  });
});
