import { linkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadRefusals } from "../src/tools/read-refusals";
import { FolderPins, withFolderPins } from "../src/vault/folder-links";
import { moveNoReplace, readNote, writeFileAtomic } from "../src/vault/notes-io";
import { makeTempDir, rmTemp } from "./tmp";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("ReadRefusals", () => {
  it("returns the raw text of a readable note and counts nothing", () => {
    const root = makeTempDir("obtc-read-refusals-");
    cleanups.push(() => rmTemp(root));
    mkdirSync(join(root, "n"), { recursive: true });
    writeFileSync(join(root, "n", "a.md"), "# A\n");
    const refusals = new ReadRefusals();
    expect(refusals.read(root, "n/a.md")).toBe("# A\n");
    expect(refusals.count).toBe(0);
    expect(refusals.out()).toEqual({});
  });

  it("rethrows a missing note (ENOENT) instead of skipping it", () => {
    const root = makeTempDir("obtc-read-refusals-");
    cleanups.push(() => rmTemp(root));
    const refusals = new ReadRefusals();
    let caught: unknown;
    try {
      refusals.read(root, "gone.md");
    } catch (e) {
      caught = e;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(refusals.count).toBe(0);
  });

  it("reports a missing note using its vault-relative path", () => {
    const root = makeTempDir("obtc-read-relative-");
    cleanups.push(() => rmTemp(root));
    mkdirSync(join(root, "notes"));
    const abs = join(root, "notes", "gone.md");
    try {
      withFolderPins(new FolderPins([{ root }]), () => readNote(abs));
      throw new Error("expected ENOENT");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect((error as Error).message).toContain("notes/gone.md");
      expect((error as Error).message).not.toContain(root);
    }
  });

  it.each([
    ["a read under a missing folder", (root: string) => readNote(join(root, "nodir", "gone.md"))],
    [
      "a write under a missing folder",
      (root: string) => writeFileAtomic(join(root, "nodir", "new.md"), Buffer.from("x"), false),
    ],
    [
      "a move of a missing note",
      (root: string) => moveNoReplace(join(root, "notes", "gone.md"), join(root, "notes", "b.md")),
    ],
  ])("%s reports ENOENT without the host path", (_name, run) => {
    const root = makeTempDir("obtc-enoent-relative-");
    cleanups.push(() => rmTemp(root));
    mkdirSync(join(root, "notes"));
    let caught: unknown;
    try {
      withFolderPins(new FolderPins([{ root }]), () => run(root));
    } catch (error) {
      caught = error;
    }
    expect((caught as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
    expect((caught as Error).message).not.toContain(root);
  });

  it("readBounded returns null for a note over the cap without counting it", () => {
    const root = makeTempDir("obtc-read-refusals-");
    cleanups.push(() => rmTemp(root));
    writeFileSync(join(root, "big.md"), "x".repeat(10));
    const refusals = new ReadRefusals();
    expect(refusals.readBounded(root, "big.md", 10)).toBe("x".repeat(10));
    expect(refusals.readBounded(root, "big.md", 9)).toBeNull();
    expect(refusals.out()).toEqual({});
  });

  it.skipIf(process.platform === "win32")("readBounded counts a refused note", () => {
    const root = makeTempDir("obtc-read-refusals-");
    const outside = makeTempDir("obtc-read-refusals-out-");
    cleanups.push(
      () => rmTemp(root),
      () => rmTemp(outside),
    );
    writeFileSync(join(outside, "src.md"), "# S\n");
    linkSync(join(outside, "src.md"), join(root, "hl.md"));
    const refusals = new ReadRefusals();
    expect(refusals.readBounded(root, "hl.md", 1024)).toBeNull();
    expect(refusals.out()).toEqual({ notes_read_refused: 1 });
  });
});
