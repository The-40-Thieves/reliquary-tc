// A note the safe open refuses (acl_denied) is skipped by indexVault, not an abort of the whole pass.
// The walk lists a note under its symlink-resolved identity; the read goes through the safe open,
// which refuses an unconfigured symlinked folder (`wiki -> pages`) and a hard-linked file that
// gained its second link after the walk's stat. Only that refusal is caught here: every other error
// (ENOENT for a note deleted mid-pass, a non-regular file) propagates unchanged, except an I/O fault
// on the read (EACCES, EIO, EMFILE ...): one unreadable file must not abort the pass, so it is
// skipped and counted on its own, apart from the refusals.

import { join, sep } from "node:path";
import { ReliquaryTcError } from "@the-40-thieves/reliquary-tc-shared";
import type { AclPath } from "../../vault/acl-identity";
import { readIoError } from "../../vault/native-read-error";
import { readNoteOrRefusal } from "../../vault/read-refusal";
import { ACL_PATH_UNRESOLVED } from "../../vault/stored-acl-path";
import { syncAclPaths } from "./acl-path-sync";
import type { IndexStats, IndexVaultArgs } from "./types";

/** The note's raw text, or null after recording a refused read (see recordReadRefusal). */
export function readOrRecordRefusal(
  args: Pick<IndexVaultArgs, "root" | "db" | "vaultId" | "sql">,
  stats: IndexStats,
  walkedSet: Map<string, AclPath | typeof ACL_PATH_UNRESOLVED>,
  readableWalked: Set<string>,
  rel: string,
): string | null {
  let read: ReturnType<typeof readNoteOrRefusal>;
  try {
    read = readNoteOrRefusal(args.root, rel);
  } catch (error) {
    const e = readIoError(error, join(args.root, rel));
    if (
      !(e instanceof ReliquaryTcError) ||
      e.code !== "internal_error" ||
      typeof e.details?.errno !== "string"
    )
      throw e;
    stats.notes_read_failed = (stats.notes_read_failed ?? 0) + 1;
    stats.read_failures = [...(stats.read_failures ?? []), { path: rel, error: e.details.errno }];
    walkedSet.set(rel, ACL_PATH_UNRESOLVED);
    readableWalked.delete(rel);
    syncAclPaths(args.db, args.vaultId, new Map([[rel, ACL_PATH_UNRESOLVED]]), args.sql);
    return null;
  }
  if ("refused" in read) {
    recordReadRefusal(args, stats, walkedSet, readableWalked, rel, read.refused);
    return null;
  }
  return read.raw;
}

/** A refusal's text with the vault root taken out: a note is named vault-relative only, never by its host path. */
export function vaultRelativeError(message: string, root: string): string {
  return message.replaceAll(`${root}${sep}`, "").replaceAll(root, "");
}

/** Records one refused read: counted and named by the pass, its identity UNRESOLVED (fail closed), and
 *  no longer readable. The name stays in walkedSet, so the sweep does not treat the note as deleted.
 *  The stored row is synced NOW, not after the walk: a later error in this pass must not leave the
 *  note's old resolved identity in place (search reads that row, not the walk). */
export function recordReadRefusal(
  pass: Pick<IndexVaultArgs, "db" | "vaultId" | "sql">,
  stats: IndexStats,
  walkedSet: Map<string, AclPath | typeof ACL_PATH_UNRESOLVED>,
  readableWalked: Set<string>,
  rel: string,
  error: string,
): void {
  stats.notes_read_refused += 1;
  stats.read_refusals.push({ path: rel, error });
  walkedSet.set(rel, ACL_PATH_UNRESOLVED);
  readableWalked.delete(rel);
  syncAclPaths(pass.db, pass.vaultId, new Map([[rel, ACL_PATH_UNRESOLVED]]), pass.sql);
}
