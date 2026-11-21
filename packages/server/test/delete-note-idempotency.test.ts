// delete_note accepts a top-level `idempotency_key`: a retried delete with the same key is served
// from the first call's result and does not run again, so it cannot remove a note that was
// written back to the same path between the two calls.
import { afterEach, describe, expect, it } from "vitest";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

let v: M6Vault | undefined;
afterEach(() => {
  v?.cleanup();
  v = undefined;
});

const CALLER = { grantedScopes: new Set(["delete:notes", "read:notes"]) };

describe("delete_note with an idempotency_key", () => {
  it("a replay returns the first result and does not delete again", async () => {
    v = makeM6Vault({ files: { "a.md": "first\n" }, register: () => {} });
    const input = { vault: "test", path: "a.md", idempotency_key: "del-1" };
    const first = await v.callConfirmed("delete_note", input, CALLER);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(v.exists("a.md")).toBe(false);

    // The path is in use again before the retry arrives.
    v.write("a.md", "second\n");
    const replay = await v.call("delete_note", input, CALLER);
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    expect(replay.meta?.idempotent_replay).toBe(true);
    expect(replay.ok ? replay.data : null).toEqual(first.ok ? first.data : undefined);
    expect(v.read("a.md")).toBe("second\n");
  });

  it("the same key with different arguments is refused", async () => {
    v = makeM6Vault({ files: { "a.md": "A\n", "b.md": "B\n" }, register: () => {} });
    const key = { idempotency_key: "del-2" };
    const first = await v.callConfirmed(
      "delete_note",
      { vault: "test", path: "a.md", ...key },
      CALLER,
    );
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const other = await v.callConfirmed(
      "delete_note",
      { vault: "test", path: "b.md", ...key },
      CALLER,
    );
    expect(other.ok ? null : other.error.code).toBe("idempotency_key_mismatch");
    expect(v.exists("b.md")).toBe(true);
  });

  it("without a key, a second delete runs and reports the note missing", async () => {
    v = makeM6Vault({ files: { "a.md": "A\n" }, register: () => {} });
    const input = { vault: "test", path: "a.md" };
    expect((await v.callConfirmed("delete_note", input, CALLER)).ok).toBe(true);
    const again = await v.callConfirmed("delete_note", input, CALLER);
    expect(again.ok ? null : again.error.code).toBe("note_not_found");
  });

  // The key is marked before the note is removed. If the removal then fails, the server cannot
  // tell a retry whether the note went, so the retry is answered `indeterminate_outcome` and does
  // not run again. (`.trash` is a file here, so moving the note into it fails.)
  it("a delete that fails part-way is never run again under the same key", async () => {
    v = makeM6Vault({ files: { "a.md": "A\n", ".trash": "not a folder" }, register: () => {} });
    const input = { vault: "test", path: "a.md", idempotency_key: "del-3" };
    const first = await v.callConfirmed("delete_note", input, CALLER);
    expect(first.ok, JSON.stringify(first)).toBe(false);
    const retry = await v.callConfirmed("delete_note", input, CALLER);
    expect(retry.ok ? null : retry.error.code, JSON.stringify(retry)).toBe("indeterminate_outcome");
    expect(retry.meta?.idempotent_replay).toBe(true);
  });

  it("a refusal before the delete starts leaves the key free for a retry", async () => {
    v = makeM6Vault({ files: { "a.md": "A\n" }, register: () => {} });
    const key = { idempotency_key: "del-4" };
    const stale = { vault: "test", path: "a.md", prev_hash: "0".repeat(64), ...key };
    const refused = await v.callConfirmed("delete_note", stale, CALLER);
    expect(refused.ok).toBe(false);
    expect(v.exists("a.md")).toBe(true);
    // Nothing happened, so the same key and arguments run for real once the note matches.
    const again = await v.callConfirmed("delete_note", stale, CALLER);
    expect(again.ok ? null : again.error.code).not.toBe("indeterminate_outcome");
  });
});
