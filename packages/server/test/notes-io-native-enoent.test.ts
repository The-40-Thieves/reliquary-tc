// The native write and rename paths map a refusal on a missing path to ENOENT. The addon is not
// loaded on every CI leg, so a refusing stand-in is put in its place: the mapping under test is in
// notes-io.ts, not in the addon.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderPins, withFolderPins } from "../src/vault/folder-links";
import { makeTempDir, rmTemp } from "./tmp";

vi.mock("../src/vault/native-io", async (importOriginal) => {
  const refuse = () => {
    throw new Error("refused: no such path");
  };
  return {
    ...(await importOriginal<typeof import("../src/vault/native-io")>()),
    nativeIo: {
      safeWriteNoteAtomic: refuse,
      safeWriteNoteExclusive: refuse,
      safeRenameNoReplace: refuse,
    },
  };
});

const { moveNoReplace, writeFileAtomic } = await import("../src/vault/notes-io");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("a native refusal on a missing path", () => {
  it.each([
    [
      "a write under a missing folder",
      (root: string) => writeFileAtomic(join(root, "nodir", "new.md"), Buffer.from("x"), false),
    ],
    [
      "a move of a missing note",
      (root: string) => moveNoReplace(join(root, "nodir", "gone.md"), join(root, "there.md")),
    ],
  ])("%s is ENOENT with the vault-relative path", (_name, act) => {
    const root = makeTempDir("obtc-native-enoent-");
    cleanups.push(() => rmTemp(root));
    let caught: unknown;
    try {
      withFolderPins(new FolderPins([{ root }]), () => act(root));
    } catch (e) {
      caught = e;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect((caught as Error).message).toContain("nodir/");
    expect((caught as Error).message).not.toContain(root);
  });
});
