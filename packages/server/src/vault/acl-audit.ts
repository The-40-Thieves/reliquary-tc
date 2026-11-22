// THE-414 follow-up (issue #280): an opt-in, dev/test-only audit that verifies a tool's declared
// `pathAcl` extractor mirrors the vault paths and operations its handler uses.
//
// `acl-extraction-coverage.test.ts` proves every mutating path tool DECLARES a pathAcl (or is a
// documented exemption). This catches the next bug class: a declared extractor that returns the
// WRONG or INCOMPLETE set — so the central dispatch stage checks path A while the handler actually
// touches path B. Enabled only when RELIQUARY_TC_ACL_AUDIT is set (never in production):
//   - "on" / "1": collect violations (read them via getCollectedViolations()).
//   - "strict":   additionally throw the moment an uncovered fs-op path is resolved.
//
// Mechanism: runDispatch wraps the central pathAcl stage + the handler in an AsyncLocalStorage
// frame. enforcePathAcl records each operation and path it checks; resolveVaultPath
// reports each path a handler resolves, and filesystem primitives report destructive operations.
// A path resolved for an fs op but never ACL-checked in the
// same dispatch is a violation. The central stage records BEFORE the handler runs, so ordering
// inside the handler does not matter. Every entry point is a no-op when disabled, so production
// carries zero overhead beyond one boolean check.
import { AsyncLocalStorage } from "node:async_hooks";

// acl-path.ts's AclOp, spelled out because that module imports this one. A caller passes its own
// AclOp, so the two cannot drift apart without a compile error.
type AclOp = "read" | "write" | "delete";

export interface AclAuditViolation {
  tool: string;
  /** aclRel resolved for a filesystem op that no folder-ACL check covered in this dispatch. */
  path: string;
  op?: AclOp;
  checkedOps?: AclOp[];
}

interface AuditFrame {
  tool: string;
  /** When false, uncovered fs-op path uses are not flagged: for tools that intentionally touch
   *  dynamic paths beyond their static pathAcl (cross-note backlink / reference rewrites). */
  auditUses: boolean;
  checked: Map<string, Set<AclOp>>;
  paths: Map<string, string>;
}

/** Tools that declare a pathAcl for their primary paths but intentionally resolve ADDITIONAL,
 *  runtime-discovered paths — rewriting links / references in other notes. Those extra fs-op path
 *  uses are a documented carve-out (THE-303 / N-3), so use-flagging is skipped for them (their
 *  declared from/to paths are still centrally enforced). */
export const CROSS_NOTE_REWRITE_TOOLS = new Set<string>([
  "move_note", // updateBacklinks() rewrites every note linking the moved one
  "move_attachment", // rewriteAttachmentReferences() rewrites linking notes (integrity carve-out)
  "bulk_move_notes", // per-row moves + the all-or-nothing backlink rewrite phase
]);

/** Tools that call findAttachmentReferences() (src/formats/attachments.ts), which walks the WHOLE
 *  vault and reads every note's content with no per-note ACL check, to discover which notes
 *  reference a given attachment. This is a DIFFERENT safety argument than CROSS_NOTE_REWRITE_TOOLS
 *  above: a rewrite tool is safe because it returns nothing the caller can observe, but these tools
 *  return the discovered paths (or a count derived from them) directly in the response. They are
 *  safe ONLY because every call site filters its output through readableRel(ctx.acl, p, ctx.grantedScopes) before it
 *  reaches the caller (get_attachment / delete_attachment: `references`; list_attachments:
 *  `reference_count`) -- see the N-2 comment in attachment-tools.ts. This carve-out is conditional
 *  on that filtering staying pinned by test/attachment-tools-branch-coverage.test.ts's "reference
 *  discovery is ACL-filtered" suite (THE-607): if a future edit drops one of those `.filter(...)`
 *  calls, that suite goes red first. Do NOT add a tool here on the strength of "it's a read, not a
 *  write" alone -- confirm its output is actually filtered before assuming this carve-out applies. */
export const CROSS_NOTE_READ_TOOLS = new Set<string>([
  "get_attachment", // include_references: true
  "delete_attachment", // unconditional reference discovery, always filtered before returning
  "list_attachments", // include_reference_count: true
]);

/** True when `tool` is exempt from use-flagging under either carve-out above (rewrite or read). */
export function isCrossNoteAuditExempt(tool: string): boolean {
  return CROSS_NOTE_REWRITE_TOOLS.has(tool) || CROSS_NOTE_READ_TOOLS.has(tool);
}

let _enabled = false;
let _strict = false;
let _collected: AclAuditViolation[] = [];

function applyMode(mode: string): void {
  _enabled = mode === "1" || mode === "on" || mode === "strict";
  _strict = mode === "strict";
}
applyMode(process.env.RELIQUARY_TC_ACL_AUDIT ?? "");

/** Test-only: force the audit mode at runtime (production reads RELIQUARY_TC_ACL_AUDIT once at load). */
export function setAclAuditMode(mode: "off" | "on" | "strict"): void {
  applyMode(mode === "off" ? "" : mode);
}

const als = new AsyncLocalStorage<AuditFrame>();

/** Run `fn` inside a fresh audit frame. A transparent passthrough when the audit is disabled. */
export function runAudited<T>(opts: { tool: string; auditUses: boolean }, fn: () => T): T {
  if (!_enabled) return fn();
  return als.run(
    { tool: opts.tool, auditUses: opts.auditUses, checked: new Map(), paths: new Map() },
    fn,
  );
}

/** Record that `aclRel` passed a folder-ACL check (called from enforcePathAcl on success). */
export function recordAclCheck(op: AclOp, aclRel: string, abs: string): void {
  if (!_enabled) return;
  const frame = als.getStore();
  if (!frame) return;
  const ops = frame.checked.get(aclRel) ?? new Set<AclOp>();
  ops.add(op);
  frame.checked.set(aclRel, ops);
  frame.paths.set(abs, aclRel);
}

export function recordPathOp(op: AclOp, abs: string): void {
  if (!_enabled) return;
  const frame = als.getStore();
  const path = frame?.paths.get(abs);
  if (!frame || path === undefined) return;
  const checkedOps = [...(frame.checked.get(path) ?? [])];
  if (checkedOps.includes(op)) return;
  // Secondary backlink and reference rewrites intentionally touch runtime-discovered paths. Such
  // a path carries no check, or only the read check the rewrite planner made on it.
  const secondary = checkedOps.every((checked) => checked === "read");
  if (op === "write" && secondary && CROSS_NOTE_REWRITE_TOOLS.has(frame.tool)) return;
  _collected.push({ tool: frame.tool, path, op, checkedOps });
  if (_strict)
    throw new Error(
      `ACL audit: ${frame.tool} performed ${op} on "${path}" without its folder-ACL check`,
    );
}

/** Record that `aclRel` was resolved for a filesystem op (called from resolveVaultPath). Flags a
 *  violation when the current tool audits uses and no ACL check covered this path; throws in strict
 *  mode so the offending call fails loudly. */
export function recordPathUse(aclRel: string, abs?: string): void {
  if (!_enabled) return;
  const frame = als.getStore();
  if (frame && abs !== undefined) frame.paths.set(abs, aclRel);
  if (!frame?.auditUses) return;
  if (frame.checked.has(aclRel)) return;
  _collected.push({ tool: frame.tool, path: aclRel });
  if (_strict)
    throw new Error(
      `ACL audit: ${frame.tool} resolved "${aclRel}" for a filesystem op with no folder-ACL check`,
    );
}

/** Violations collected since the last clear (dev/test only). */
export function getCollectedViolations(): readonly AclAuditViolation[] {
  return _collected;
}

export function clearCollectedViolations(): void {
  _collected = [];
}
