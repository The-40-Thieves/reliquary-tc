import { getSystemErrorName } from "node:util";
import { err, ReliquaryTcError } from "@the-40-thieves/reliquary-tc-shared";
import { vaultDetailPath } from "./folder-links";

// An I/O fault on a note read (EACCES, EIO, EMFILE ...), as opposed to a policy refusal. Both
// backends report it as the same `internal_error`: the errno name in the details, the vault's own
// spelling of the path, and never the absolute host path a raw Node error carries in its message.
// The native module marks a fault with an `io:<ERRNO>:` reason (`io:#<number>:` for an errno it has
// no name for). A missing file, a symlink and a refusal pass through unchanged.
export function readIoError(error: unknown, abs: string): unknown {
  if (error instanceof ReliquaryTcError) return error;
  const e = error as NodeJS.ErrnoException;
  const message = e?.message ?? "";
  const end = message.startsWith("io:") ? message.indexOf(":", 3) : -1;
  const native = end > 3 ? message.slice(3, end) : undefined;
  let errno = native ?? (typeof e?.errno === "number" ? e.code : undefined);
  if (errno?.startsWith("#")) {
    // An errno with no name comes back as a sentence (or throws when out of range).
    try {
      const name = getSystemErrorName(-Number(errno.slice(1)));
      errno = name.startsWith("Unknown") ? "UNKNOWN" : name;
    } catch {
      errno = "UNKNOWN";
    }
  }
  if (!errno || errno === "ENOENT" || errno === "ELOOP" || errno === "ENOTDIR") return error;
  return err.internalError("unable to read file", { errno, path: vaultDetailPath(abs) });
}

export function readIo<T>(read: () => T, abs: string): T {
  try {
    return read();
  } catch (e) {
    throw readIoError(e, abs);
  }
}
