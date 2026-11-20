import { describe, expect, it, vi } from "vitest";
import * as notesIO from "../src/vault/notes-io";
import { contentHash } from "../src/vault/paths";
import { evidence, readableFixture } from "./fixtures/readable-notes-yield-vault";
import type { TestVault } from "./m1-helpers";

const scans: Array<[string, (v: TestVault) => Promise<unknown>]> = [
  ["get_outgoing_links", (v) => v.call("get_outgoing_links", { vault: "test", path: "links.md" })],
  ["prune_hub_links", (v) => v.call("prune_hub_links", { vault: "test", path: "links.md" })],
  [
    "rewrite_link",
    (v) => v.call("rewrite_link", { vault: "test", from_target: "hub", to_target: "new-hub" }),
  ],
  ["identity evidence", evidence],
];

describe("remaining readable-note scans service the event loop", () => {
  for (const [name, run] of scans) {
    it(`${name}: a timer runs before the scan completes`, { timeout: 60_000 }, async () => {
      const v = readableFixture(1000);
      // Count check-phase turns with a self-rearming setImmediate, not a 1 ms interval: Windows
      // timers tick every ~15 ms, so a scan that yields correctly can finish before one is due.
      let turns = 0;
      let handle = setImmediate(function tick() {
        turns++;
        handle = setImmediate(tick);
      });
      try {
        const result = await run(v);
        if (typeof result === "object" && result !== null && "ok" in result)
          expect(result.ok).toBe(true);
        expect(turns, "event-loop turns during the scan").toBeGreaterThan(0);
      } finally {
        clearImmediate(handle);
        v.cleanup();
      }
    });
  }
});

it("prune checks prev_hash after the yielding scan", { timeout: 60_000 }, async () => {
  const v = readableFixture(1000);
  const prev = contentHash(v.read("links.md"));
  const timer = setTimeout(() => v.write("links.md", "An edit made during the scan\n"), 0);
  try {
    const r = await v.call("prune_hub_links", { vault: "test", path: "links.md", prev_hash: prev });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
    expect(v.read("links.md")).toBe("An edit made during the scan\n");
  } finally {
    clearTimeout(timer);
    v.cleanup();
  }
});

// A real run must not yield between resolving links and writing: a note created or changed in that
// gap would make the index stale, and the write would act on a resolution that is no longer true.
describe("real runs plan and write in one turn", () => {
  it("rewrite_link reads every note without yielding", { timeout: 60_000 }, async () => {
    const v = readableFixture(1000);
    const read = notesIO.readNote;
    let pending: ReturnType<typeof setImmediate> | undefined;
    let fired = false;
    let readsAfterTurn = 0;
    const spy = vi.spyOn(notesIO, "readNote").mockImplementation((...args) => {
      if (fired) readsAfterTurn++;
      pending ??= setImmediate(() => {
        fired = true;
      });
      return read(...args);
    });
    try {
      await v.call("rewrite_link", {
        vault: "test",
        from_target: "hub",
        to_target: "new-hub",
        dry_run: false,
      });
      expect(spy.mock.calls.length).toBeGreaterThan(100);
      expect(readsAfterTurn).toBe(0);
    } finally {
      if (pending) clearImmediate(pending);
      spy.mockRestore();
      v.cleanup();
    }
  });

  it("prune_hub_links builds its index and reads the hub in one turn", {
    timeout: 60_000,
  }, async () => {
    const v = readableFixture(1000);
    const exists = notesIO.noteExists;
    const read = notesIO.readNote;
    let pending: ReturnType<typeof setImmediate> | undefined;
    let fired = false;
    let hubReadAfterTurn: boolean | undefined;
    const existsSpy = vi.spyOn(notesIO, "noteExists").mockImplementation((...args) => {
      pending ??= setImmediate(() => {
        fired = true;
      });
      return exists(...args);
    });
    const readSpy = vi.spyOn(notesIO, "readNote").mockImplementation((...args) => {
      if (args[0].endsWith("links.md")) hubReadAfterTurn ??= fired;
      return read(...args);
    });
    try {
      await v.call("prune_hub_links", { vault: "test", path: "links.md", dry_run: false });
      expect(hubReadAfterTurn).toBe(false);
    } finally {
      if (pending) clearImmediate(pending);
      existsSpy.mockRestore();
      readSpy.mockRestore();
      v.cleanup();
    }
  });
});
