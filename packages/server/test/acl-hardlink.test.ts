// C-1b regression: a hard link is a second directory entry for the same inode, so a folder
// ACL that globs the alias path would serve a file living outside the allowed folder. realpath
// cannot dereference a hard link, so enforcement must gate on the inode link count. These tests
// place a real hard link on disk and assert the read fails closed.

import { linkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { enforcePathAcl } from "../src/vault/acl-path";
import { readFileChecked, readNote } from "../src/vault/notes-io";
import { makeTempDir, rmTemp } from "./tmp";

function tempVault(): string {
  const root = makeTempDir("otc-hardlink-");
  mkdirSync(join(root, "private"), { recursive: true });
  mkdirSync(join(root, "public"), { recursive: true });
  return root;
}

// Read whitelist confined to public/**; private/** and .obsidian are outside it.
const restrictedAcl = () =>
  new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths: ["public/**"] });

describe("C-1b hard-link folder-ACL bypass", () => {
  it("rejects a hard link aliasing a file outside the read whitelist", () => {
    const root = tempVault();
    try {
      writeFileSync(join(root, "private", "secret.md"), "---\napi_key: sk-SECRET\n---\n");
      linkSync(join(root, "private", "secret.md"), join(root, "public", "hl.md"));
      const acl = restrictedAcl();
      // The glob allows public/hl.md, but the inode gate fails it closed.
      expect(() => enforcePathAcl(acl, "read", "public/hl.md", root, [])).toThrow(
        /hard-link|inode/i,
      );
      // The fd-based readers independently reject the alias (TOCTOU-safe, on the open fd).
      expect(() => readNote(join(root, "public", "hl.md"))).toThrow(/hard-link|inode/i);
      expect(() => readFileChecked(join(root, "public", "hl.md"))).toThrow(/hard-link|inode/i);
    } finally {
      rmTemp(root);
    }
  });

  it("defeats the hard-link escalation past the .obsidian default-deny", () => {
    const root = tempVault();
    try {
      mkdirSync(join(root, ".obsidian", "plugins", "p"), { recursive: true });
      const secret = join(root, ".obsidian", "plugins", "p", "data.json");
      writeFileSync(secret, '{"apiKey":"OBSIDIAN-SECRET"}');
      linkSync(secret, join(root, "public", "hlob.md"));
      const acl = restrictedAcl();
      expect(() => enforcePathAcl(acl, "read", "public/hlob.md", root, [])).toThrow(
        /hard-link|inode/i,
      );
      expect(() => readNote(join(root, "public", "hlob.md"))).toThrow(/hard-link|inode/i);
    } finally {
      rmTemp(root);
    }
  });

  it("still reads a normal single-link note inside the whitelist", () => {
    const root = tempVault();
    try {
      writeFileSync(join(root, "public", "ok.md"), "hello\n");
      const acl = restrictedAcl();
      expect(() => enforcePathAcl(acl, "read", "public/ok.md", root, [])).not.toThrow();
      expect(readNote(join(root, "public", "ok.md")).raw).toBe("hello\n");
    } finally {
      rmTemp(root);
    }
  });

  // The guard used to run only when an ACL object was passed. A delete does not read through the
  // fd readers, so without it nothing refused a second name for another inode.
  it.each(["read", "write", "delete"] as const)(
    "rejects a hard link on %s when no ACL is configured",
    (op) => {
      const root = tempVault();
      try {
        mkdirSync(join(root, ".obsidian"), { recursive: true });
        writeFileSync(join(root, ".obsidian", "app.json"), "{}");
        linkSync(join(root, ".obsidian", "app.json"), join(root, "public", "alias.md"));
        expect(() => enforcePathAcl(undefined, op, "public/alias.md", root, [])).toThrow(
          "refusing a hard-linked file (inode aliasing)",
        );
      } finally {
        rmTemp(root);
      }
    },
  );

  it("still allows a single-link note when no ACL is configured", () => {
    const root = tempVault();
    try {
      writeFileSync(join(root, "public", "ok.md"), "hello\n");
      // An existing single-link file for every op, and a write target that does not exist yet.
      for (const op of ["read", "write", "delete"] as const)
        expect(() => enforcePathAcl(undefined, op, "public/ok.md", root, [])).not.toThrow();
      expect(() => enforcePathAcl(undefined, "write", "public/new.md", root, [])).not.toThrow();
    } finally {
      rmTemp(root);
    }
  });
});
