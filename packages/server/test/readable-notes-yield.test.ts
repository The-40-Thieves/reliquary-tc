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
      let ticks = 0;
      const timer = setInterval(() => {
        ticks++;
      }, 1);
      try {
        const result = await run(v);
        if (typeof result === "object" && result !== null && "ok" in result)
          expect(result.ok).toBe(true);
        expect(ticks, "timer ticks during the scan").toBeGreaterThan(0);
      } finally {
        clearInterval(timer);
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

it("rewrite refuses a plan whose source changed during a yield", { timeout: 60_000 }, async () => {
  const v = readableFixture(1000);
  const read = notesIO.readNote;
  let pending: ReturnType<typeof setImmediate> | undefined;
  let changed = false;
  const spy = vi.spyOn(notesIO, "readNote").mockImplementation((...args) => {
    const result = read(...args);
    if (args[0].endsWith("links.md") && !pending && !changed) {
      pending = setImmediate(() => {
        changed = true;
        v.write("links.md", "An edit made during the scan\n");
      });
    }
    return result;
  });
  try {
    const r = await v.call("rewrite_link", {
      vault: "test",
      from_target: "hub",
      to_target: "new-hub",
      dry_run: false,
    });
    expect(changed).toBe(true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
    expect(v.read("links.md")).toBe("An edit made during the scan\n");
  } finally {
    if (pending) clearImmediate(pending);
    spy.mockRestore();
    v.cleanup();
  }
});
