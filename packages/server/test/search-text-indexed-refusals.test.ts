import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { err } from "@the-40-thieves/reliquary-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ftsCandidates } from "../src/search/fts";
import { searchTextIndexed } from "../src/search/text";
import { ReadRefusals } from "../src/tools/read-refusals";
import { readNote } from "../src/vault/notes-io";
import { makeM2Vault } from "./m2-helpers";
import { hardLinkOutside, itemPaths, okData } from "./read-refusal-helpers";

// Match the cross-platform refusal fixture in read-refusal-walkers-mixed.test.ts.
const failure = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    readNote: vi.fn((abs: string) => {
      if (abs.endsWith("b.md") && failure.error) throw failure.error;
      return actual.readNote(abs);
    }),
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  failure.error = undefined;
  vi.mocked(readNote).mockClear();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function indexedVault() {
  const v = makeM2Vault({
    files: {
      "a.md": "zebra alpha\n",
      "n/a.md": "zebra beta\n",
      "n/b.md": "zebra outside\n",
    },
    acl: { rules: [{ glob: "n/b.md", scopes: ["read:private"] }] },
    metadataIndex: { hasFts: true, ready: () => true },
  });
  cleanups.push(() => v.cleanup());
  okData(await v.call("index_vault", { vault: "test" }));
  expect(
    ftsCandidates(v.db, "test", "zebra", 2000)
      ?.map((c) => c.path)
      .sort(),
  ).toEqual(["a.md", "n/a.md", "n/b.md"]);
  vi.mocked(readNote).mockClear();
  return v;
}

function readableItems(data: Record<string, unknown>) {
  return (data.items as Array<{ path: string }>).filter((item) => item.path !== "n/b.md");
}

describe.each([
  ["search_text", { query: "zebra" }],
  ["search_vault", { query: "zebra", mode: "text" }],
] as const)("%s with a ready FTS index", (tool, args) => {
  const input = { vault: "test", ...args };

  it("omits notes_read_refused on a clean indexed vault", async () => {
    const v = await indexedVault();
    const data = okData(await v.call(tool, input));
    expect(itemPaths(data)).toEqual(["a.md", "n/a.md", "n/b.md"]);
    expect(data).not.toHaveProperty("notes_read_refused");
  });

  it.skipIf(process.platform === "win32")(
    "counts a hard-linked candidate and preserves readable hits",
    async () => {
      const v = await indexedVault();
      const before = okData(await v.call(tool, input));
      unlinkSync(join(v.root, "n/b.md"));
      cleanups.push(hardLinkOutside(v.root, "zebra outside\n", join("n", "b.md")));
      const data = okData(await v.call(tool, input));
      expect(data.items).toEqual(readableItems(before));
      expect(data.notes_read_refused).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not count a hard-linked candidate outside the caller's ACL",
    async () => {
      const v = await indexedVault();
      unlinkSync(join(v.root, "n/b.md"));
      cleanups.push(hardLinkOutside(v.root, "zebra outside\n", join("n", "b.md")));
      const data = okData(await v.call(tool, input, { grantedScopes: new Set(["read:notes"]) }));
      expect(itemPaths(data)).toEqual(["a.md", "n/a.md"]);
      expect(data).not.toHaveProperty("notes_read_refused");
    },
  );

  it("counts a simulated safe-open refusal and preserves readable hits", async () => {
    const v = await indexedVault();
    const before = okData(await v.call(tool, input));
    failure.error = err.aclDenied("safe open refused the path: test");
    const data = okData(await v.call(tool, input));
    expect(data.items).toEqual(readableItems(before));
    expect(data.notes_read_refused).toBe(1);
  });

  it("neither reads nor counts a candidate outside the caller's ACL", async () => {
    const v = await indexedVault();
    failure.error = err.aclDenied("safe open refused the path: test");
    const data = okData(await v.call(tool, input, { grantedScopes: new Set(["read:notes"]) }));
    expect(itemPaths(data)).toEqual(["a.md", "n/a.md"]);
    expect(data).not.toHaveProperty("notes_read_refused");
    expect(vi.mocked(readNote).mock.calls.some(([abs]) => abs.endsWith("b.md"))).toBe(false);
  });

  it("skips a candidate deleted after indexing without counting a refusal", async () => {
    const v = await indexedVault();
    const before = okData(await v.call(tool, input));
    unlinkSync(join(v.root, "n/b.md"));
    const data = okData(await v.call(tool, input));
    expect(data.items).toEqual(readableItems(before));
    expect(data).not.toHaveProperty("notes_read_refused");
  });
});

it("propagates unexpected indexed note read errors", async () => {
  const v = await indexedVault();
  failure.error = Object.assign(new Error("unexpected read failure"), { code: "EIO" });
  const refusals = new ReadRefusals();
  expect(() =>
    searchTextIndexed(v.db, "test", v.root, { query: "zebra", limit: 100, refusals }),
  ).toThrow(failure.error);
  expect(refusals.count).toBe(0);
});
