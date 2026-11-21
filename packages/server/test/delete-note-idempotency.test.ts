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
    const first = await v.callConfirmed("delete_note", { vault: "test", path: "a.md", ...key }, CALLER);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const other = await v.callConfirmed("delete_note", { vault: "test", path: "b.md", ...key }, CALLER);
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
});
