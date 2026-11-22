// The inode-aliasing check shared by the path ACL, the index's ACL identity and inspect_acl.
// A hard link is a second name for an inode. realpath cannot dereference it, so a file reached
// under an allowed name may be a file that lives somewhere the caller may not touch.
import { type Stats, statSync } from "node:fs";

/** What the check needs from a stat; injectable so a failing stat can be tested. */
type LinkStat = (abs: string) => Pick<Stats, "isFile" | "nlink"> | undefined;

/**
 * Must this target be refused as a possible alias of another inode? True for a regular file with
 * more than one link, and true when the link count cannot be read at all: an unknown count is not
 * a count of one. Only a target that is not there (a write that has not happened yet) is let
 * through, since it has no inode to alias.
 */
export function isHardLinkedFile(
  abs: string,
  stat: LinkStat = (p) => statSync(p, { throwIfNoEntry: false }),
): boolean {
  try {
    const st = stat(abs);
    if (st?.isFile() !== true) return false;
    // Anything but a real number of at most 1 refuses: NaN, a missing count, or a value such as
    // null or "0" that would only pass by coercion.
    const n: unknown = st.nlink;
    return typeof n !== "number" || !(n <= 1);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}
