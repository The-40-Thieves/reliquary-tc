import { chmodSync, linkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readIoError } from "../src/vault/native-read-error";
import { makeM2Vault } from "./m2-helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeTempDir, rmTemp } from "./tmp";

const skipChmod = process.platform === "win32" || process.getuid?.() === 0;

describe.skipIf(skipChmod)("read I/O faults", () => {
  it("search fails with a path-safe internal error", async () => {
    const v = makeM2Vault({ files: { "n/a.md": "zebra" } });
    const path = join(v.root, "n/a.md");
    try {
      chmodSync(path, 0);
      const result = await v.call("search_text", { vault: v.id, query: "zebra" });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "internal_error", details: { errno: "EACCES" } },
      });
      expect(JSON.stringify(result)).not.toContain(v.root);
    } finally {
      chmodSync(path, 0o600);
      v.cleanup();
    }
  });

  it("attachment reference scans fail on read faults", async () => {
    const v = makeM3Vault({ files: { "img.png": "png", "n/a.md": "![[img.png]]" } });
    const path = join(v.root, "n/a.md");
    try {
      chmodSync(path, 0);
      const result = await v.call("list_attachments", {
        vault: v.id,
        include_reference_count: true,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "internal_error", details: { errno: "EACCES" } },
      });
      expect(JSON.stringify(result)).not.toContain(v.root);
    } finally {
      chmodSync(path, 0o600);
      v.cleanup();
    }
  });

  it.each([false, true])(
    "indexing counts a failed read separately (streaming: %s)",
    async (streamingWalk) => {
      const v = makeM2Vault({ files: { "n/a.md": "zebra" }, streamingWalk });
      const path = join(v.root, "n/a.md");
      try {
        chmodSync(path, 0);
        const result = await v.call("index_vault", { vault: v.id, response_format: "detailed" });
        expect(result).toMatchObject({
          ok: true,
          data: { notes_read_failed: 1, notes_read_refused: 0 },
        });
        // The count is reported; the paths are not, since no caller check covers them.
        expect(JSON.stringify(result)).not.toContain("read_failures");
      } finally {
        chmodSync(path, 0o600);
        v.cleanup();
      }
    },
  );
});

describe.skipIf(process.platform === "win32")("hard links", () => {
  it("remain refused during search", async () => {
    const v = makeM2Vault({ files: { "n/a.md": "zebra" } });
    const outside = makeTempDir("read-fault-outside-");
    try {
      writeFileSync(join(outside, "secret.md"), "secret");
      linkSync(join(outside, "secret.md"), join(v.root, "n/link.md"));
      const result = await v.call("search_text", { vault: v.id, query: "secret" });
      expect(result).toMatchObject({ ok: true, data: { notes_read_refused: 1 } });
    } finally {
      v.cleanup();
      rmTemp(outside);
    }
  });
});

describe("native fault marker", () => {
  it("reports an errno the platform has no name for as UNKNOWN", () => {
    expect(readIoError(new Error("io:#99999: read"), "/v/n/a.md")).toMatchObject({
      code: "internal_error",
      details: { errno: "UNKNOWN" },
    });
  });
});
