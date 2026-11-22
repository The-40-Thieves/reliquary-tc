import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import {
  clearCollectedViolations,
  getCollectedViolations,
  setAclAuditMode,
} from "../src/vault/acl-audit";
import { hardDelete, moveNoReplace, writeNoteAtomic } from "../src/vault/notes-io";
import { resolveVaultPath } from "../src/vault/paths";
import { makeTempDir, rmTemp } from "./tmp";

describe("ACL audit operations", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir("acl-op-");
    writeFileSync(join(root, "source.md"), "old");
    setAclAuditMode("on");
    clearCollectedViolations();
  });
  afterEach(() => {
    setAclAuditMode("off");
    rmTemp(root);
  });
  async function call(sourceOp: "write" | "delete", effect: "delete" | "write" | "move") {
    const registry = new ToolRegistry({ rootResolver: () => root });
    registry.register({
      name: "synthetic_op",
      description: "synthetic",
      inputSchema: z.object({ vault: z.string() }),
      requiredScopes: ["write:notes"],
      pathAcl: () => [
        { op: sourceOp, path: "source.md" },
        ...(effect === "move" ? [{ op: "write", path: "dest.md" }] : []),
      ],
      handler: () => {
        const source = resolveVaultPath(root, "source.md");
        if (effect === "delete") hardDelete(source);
        if (effect === "write") writeNoteAtomic(source, "new");
        if (effect === "move") moveNoReplace(source, resolveVaultPath(root, "dest.md"));
        return { ok: true };
      },
    } as any);
    const ctx: CallerContext = {
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v",
      db: {} as Database,
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    };
    return registry.dispatch("synthetic_op", { vault: "v" }, ctx);
  }
  it("reports a delete checked only as write", async () => {
    expect((await call("write", "delete")).ok).toBe(true);
    expect(getCollectedViolations()).toEqual([
      expect.objectContaining({ path: "source.md", op: "delete", checkedOps: ["write"] }),
    ]);
  });
  it("rejects the mismatch in strict mode", async () => {
    setAclAuditMode("strict");
    expect((await call("write", "delete")).ok).toBe(false);
  });
  it("accepts matching delete and write", async () => {
    await call("delete", "delete");
    await call("write", "write");
    expect(getCollectedViolations()).toHaveLength(0);
  });
  it("requires delete on the move source and write on its destination", async () => {
    await call("delete", "move");
    expect(getCollectedViolations()).toHaveLength(0);
    writeFileSync(join(root, "source.md"), "old");
    unlinkSync(join(root, "dest.md"));
    await call("write", "move");
    expect(getCollectedViolations()).toEqual([
      expect.objectContaining({ path: "source.md", op: "delete", checkedOps: ["write"] }),
    ]);
  });
  it("does nothing when disabled", async () => {
    setAclAuditMode("off");
    expect((await call("write", "delete")).ok).toBe(true);
    expect(getCollectedViolations()).toHaveLength(0);
  });
});
