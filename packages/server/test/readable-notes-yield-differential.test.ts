// Captured on the synchronous implementation. Update only for an intentional output change:
// UPDATE_READABLE_EXPECTED=1 vitest run test/readable-notes-yield-differential.test.ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  evidence,
  generate,
  LINK_CALLS,
  readableFixture,
} from "./fixtures/readable-notes-yield-vault";

const expectedPath = fileURLToPath(
  new URL("./fixtures/readable-notes-yield-before.json", import.meta.url),
);

it("preserves synchronous output bytes, ordering and ACL filtering", async () => {
  const v = readableFixture();
  try {
    const got: Record<string, string> = {};
    for (const [name, input] of LINK_CALLS) {
      const r = await v.call(name, { vault: "test", ...input });
      expect(r.ok, name).toBe(true);
      got[`${name} ${JSON.stringify(input)}`] = JSON.stringify(r.ok ? r.data : r);
    }
    got.evidence = await evidence(v);
    got.generated = await generate(v);
    expect(JSON.parse(got.evidence).notes).not.toContain("secret/Hidden.md");
    expect(JSON.parse(got.evidence).candidates.length).toBeGreaterThan(0);
    expect(JSON.parse(got.generated).reports[0].written).toContain("wiki/index.md");
    if (process.env.UPDATE_READABLE_EXPECTED === "1")
      writeFileSync(expectedPath, `${JSON.stringify(got, null, 2)}\n`);
    expect(got).toEqual(JSON.parse(readFileSync(expectedPath, "utf8")));
  } finally {
    v.cleanup();
  }
});
