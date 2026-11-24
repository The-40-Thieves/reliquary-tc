// The inode-aliasing check shared by the path ACL, the index's ACL identity and inspect_acl.
// A hard link is a second name for an inode. realpath cannot dereference it, so a file reached
// under an allowed name may be a file that lives somewhere the caller may not touch.
import { type Stats, statSync } from "node:fs";

/** What the check needs from a stat; injectable so a failing stat can be tested. */
type LinkStat = (abs: string) => Pick<Stats, "isFile" | "nlink"> | undefined;

/**
 * Why this target must be refused as a possible alias of another inode, or `null` when it need not
 * be. `"hard_link"` for a regular file with more than one link; `"unknown_link_count"` when the
 * count cannot be read at all, since an unknown count is not a count of one. Only a target that is
 * not there (a write that has not happened yet) gets `null`, since it has no inode to alias.
 */
export function hardLinkReason(
  abs: string,
  stat: LinkStat = (p) => statSync(p, { throwIfNoEntry: false }),
): "hard_link" | "unknown_link_count" | null {
  try {
    const st = stat(abs);
    if (st?.isFile() !== true) return null;
    // Anything but a real number of at most 1 refuses: NaN, a missing count, or a value such as
    // null or "0" that would only pass by coercion.
    const n: unknown = st.nlink;
    if (typeof n !== "number" || Number.isNaN(n)) return "unknown_link_count";
    return n > 1 ? "hard_link" : null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    return code !== "ENOENT" && code !== "ENOTDIR" ? "unknown_link_count" : null;
  }
}

export function isHardLinkedFile(abs: string, stat?: LinkStat): boolean {
  return hardLinkReason(abs, stat) !== null;
}
