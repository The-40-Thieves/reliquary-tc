import { registerWikiPagesSweep } from "../../src/runtime/wiki-pages-sweep";
import { NO_EXCLUSION } from "../../src/search/index-exclusion";
import { collectIdentityEvidence } from "../../src/tools/m7/knowledge/wiki-evidence";
import type { WikiGenerateResult } from "../../src/tools/m7/knowledge/wiki-generated";
import { ReadRefusals } from "../../src/tools/read-refusals";
import { makeTestVault, type TestVault } from "../m1-helpers";
import { scanFixtureFiles } from "./scan-yield-vault";

export function readableFixture(bulk = 30): TestVault {
  const files = scanFixtureFiles(bulk);
  delete files["wiki/index.md"];
  files["links.md"] =
    '---\nrelated: "[[hub]]"\n---\n[[hub]] [[hub]] [[dup]] [[secret/Hidden]] [[missing]] ![[hub]]\n';
  files["secret/Hidden.md"] = "---\naliases: [Hub]\n---\n# Hub\n[[hub]]\n";
  files["wiki/SCHEMA.md"] = "---\ntypes:\n  - name: concept\n  - name: person\n---\n";
  for (let i = 0; i < bulk; i++) {
    files[`wiki/f${i % 17}/p${i}.md`] =
      `---\ntype: ${i % 2 ? "concept" : "person"}\naliases: [Hub]\n---\n# Page ${i}\n[[hub|Hub]]\n`;
  }
  return makeTestVault({
    files,
    wikiFolder: "wiki",
    acl: { rules: [{ glob: "secret/**", scopes: ["secret:read"] }] },
  });
}

export const LINK_CALLS: Array<[string, Record<string, unknown>]> = [
  ["get_outgoing_links", { path: "links.md" }],
  ["get_outgoing_links", { path: "links.md", include_embeds: false, response_format: "concise" }],
  ["prune_hub_links", { path: "links.md" }],
  ["prune_hub_links", { path: "links.md", remove_duplicates: false }],
  ["rewrite_link", { from_target: "hub", to_target: "new-hub", folder: "wiki" }],
  ["rewrite_link", { from_target: "missing", to_target: "hub", include_embeds: false }],
];

export async function evidence(v: TestVault): Promise<string> {
  const r = await collectIdentityEvidence(
    { root: v.root, acl: v.acl, grantedScopes: [], wikiFolder: "wiki" },
    "Hub",
    { isExcluded: (p) => p === "wiki/f0/p0.md", refusals: new ReadRefusals() },
  );
  return JSON.stringify({
    candidates: [...r.candidates],
    scanned: r.scanned,
    notes: r.notes,
    mentions: r.mentions,
    linkers: r.linkers,
    warnings: r.warnings.out(),
    refusals: r.warnings.refusals.out(),
  });
}

export async function generate(v: TestVault): Promise<string> {
  let task: { run: (signal: AbortSignal) => unknown } | undefined;
  const reports: WikiGenerateResult[] = [];
  registerWikiPagesSweep(
    {
      register: (t: never) => {
        task = t;
      },
    } as never,
    {
      cacheDb: v.db,
      vaults: [{ id: "test", root: v.root, wikiFolder: "wiki" }],
      aclFor: () => v.acl,
      exclusionFor: () => NO_EXCLUSION,
      intervalMs: 1000,
      sealKey: () => "readable-notes-yield-test-seal-key",
      onResult: (_id, result) => {
        reports.push(result);
      },
    },
  );
  await task?.run(new AbortController().signal);
  return JSON.stringify({ reports, index: v.read("wiki/index.md") });
}
