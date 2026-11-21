// The hard-link check stats the target. A stat that fails for any reason other than "nothing is
// there" leaves the link count unknown, and unknown must refuse: the check used to answer "not
// hard-linked" for every error, which let an unverifiable target through.
import type { Stats } from "node:fs";
import { describe, expect, it } from "vitest";
import { isHardLinkedFile } from "../src/vault/acl-path";

const failing = (code: string) => (): Stats => {
  throw Object.assign(new Error(code), { code });
};
const fileWith = (nlink: number) => (): Stats =>
  ({ isFile: () => true, nlink }) as unknown as Stats;

describe("isHardLinkedFile when the stat fails", () => {
  it.each(["EACCES", "EPERM", "EIO", "ELOOP", "EMFILE"])(
    "refuses when the stat fails with %s",
    (code) => {
      expect(isHardLinkedFile("/vault/a.md", failing(code))).toBe(true);
    },
  );

  it("refuses when the error carries no code", () => {
    const stat = (): Stats => {
      throw new Error("unexpected");
    };
    expect(isHardLinkedFile("/vault/a.md", stat)).toBe(true);
  });

  // A write target that does not exist yet has no inode to alias.
  it.each(["ENOENT", "ENOTDIR"])("allows an absent target (%s)", (code) => {
    expect(isHardLinkedFile("/vault/new.md", failing(code))).toBe(false);
  });

  it("allows an absent target reported as undefined", () => {
    expect(isHardLinkedFile("/vault/new.md", () => undefined)).toBe(false);
  });

  it("still reads the link count when the stat succeeds", () => {
    expect(isHardLinkedFile("/vault/a.md", fileWith(1))).toBe(false);
    expect(isHardLinkedFile("/vault/a.md", fileWith(2))).toBe(true);
    const dir = (): Stats => ({ isFile: () => false, nlink: 3 }) as unknown as Stats;
    expect(isHardLinkedFile("/vault/dir", dir)).toBe(false);
  });
});
