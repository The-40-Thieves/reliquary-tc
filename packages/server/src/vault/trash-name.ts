/** Stem and extension of a vault path: trashNote inserts ` (n)` between them on a collision. */
export function splitTrashName(relPath: string): { stem: string; ext: string } {
  const dot = relPath.lastIndexOf(".");
  const slash = relPath.lastIndexOf("/");
  return dot > slash
    ? { stem: relPath.slice(0, dot), ext: relPath.slice(dot) }
    : { stem: relPath, ext: "" };
}
