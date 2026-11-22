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
import { callerMayReadNote } from "../src/vault/cas";
import { hardDelete, moveNoReplace, trashNote, writeNoteAtomic } from "../src/vault/notes-io";
import { resolveVaultPath } from "../src/vault/paths";
import { makeTempDir, rmTemp } from "./tmp";

type Op = "write" | "delete";
type Effect = "delete" | "write" | "move" | "replace" | "backlink";
interface CallOpts {
  /** The operation declared for dest.md (a move's destination). */
  destOp?: Op;
  /** The registered tool name: the audit exempts a move tool's writes to notes it only read. */
  tool?: string;
}

let root: string;

/** What the synthetic tool does to the vault once its declared paths passed their ACL checks. */
function perform(effect: Effect, ctx: CallerContext): void {
  const source = resolveVaultPath(root, "source.md");
  if (effect === "delete") hardDelete(source);
  if (effect === "write") writeNoteAtomic(source, "new");
  if (effect === "move") moveNoReplace(source, resolveVaultPath(root, "dest.md"));
  // An overwrite moves the old file to the trash as a step of the write.
  if (effect === "replace") trashNote(root, "source.md", "write");
  if (effect === "backlink" && callerMayReadNote(ctx, root, "linker.md"))
    writeNoteAtomic(resolveVaultPath(root, "linker.md"), "rewritten");
}

async function call(sourceOp: Op, effect: Effect, opts: CallOpts = {}) {
  const name = opts.tool ?? "synthetic_op";
  const registry = new ToolRegistry({ rootResolver: () => root });
  registry.register({
    name,
    description: "synthetic",
    inputSchema: z.object({ vault: z.string() }),
    requiredScopes: ["write:notes"],
    pathAcl: () => [
      { op: sourceOp, path: "source.md" },
      ...(effect === "move" ? [{ op: opts.destOp ?? "write", path: "dest.md" }] : []),
    ],
    handler: (_input: unknown, ctx: CallerContext) => {
      perform(effect, ctx);
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
  return registry.dispatch(name, { vault: "v" }, ctx);
}

beforeEach(() => {
  root = makeTempDir("acl-op-");
  writeFileSync(join(root, "source.md"), "old");
  writeFileSync(join(root, "linker.md"), "[[source]]");
  setAclAuditMode("on");
  clearCollectedViolations();
});
afterEach(() => {
  setAclAuditMode("off");
  rmTemp(root);
});

describe("ACL audit operations", () => {
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
  it("requires delete on the move source", async () => {
    await call("delete", "move");
    expect(getCollectedViolations()).toHaveLength(0);
    writeFileSync(join(root, "source.md"), "old");
    unlinkSync(join(root, "dest.md"));
    await call("write", "move");
    expect(getCollectedViolations()).toEqual([
      expect.objectContaining({ path: "source.md", op: "delete", checkedOps: ["write"] }),
    ]);
  });
  it("requires write on the move destination", async () => {
    await call("delete", "move", { destOp: "delete" });
    expect(getCollectedViolations()).toEqual([
      expect.objectContaining({ path: "dest.md", op: "write", checkedOps: ["delete"] }),
    ]);
  });
  it("does nothing when disabled", async () => {
    setAclAuditMode("off");
    expect((await call("write", "delete")).ok).toBe(true);
    expect(getCollectedViolations()).toHaveLength(0);
  });
});

describe("ACL audit: steps that are part of a permitted write", () => {
  it("accepts an overwrite that trashes the file it replaces under a write check", async () => {
    setAclAuditMode("strict");
    expect((await call("write", "replace")).ok).toBe(true);
    expect(getCollectedViolations()).toHaveLength(0);
  });
  it("accepts a move tool rewriting a linking note it was only allowed to read", async () => {
    setAclAuditMode("strict");
    expect((await call("delete", "backlink", { tool: "move_note" })).ok).toBe(true);
    expect(getCollectedViolations()).toHaveLength(0);
  });
  it("still reports that rewrite from a tool that is not a move tool", async () => {
    await call("delete", "backlink");
    expect(getCollectedViolations()).toEqual([
      expect.objectContaining({ path: "linker.md", op: "write", checkedOps: ["read"] }),
    ]);
  });
});
