// Staging-directory helpers for scripts/bundle-mcpb.ts (THE-951).
//
// The MCPB CLI's `pack` command (pinned @anthropic-ai/mcpb@2.1.2 — re-checked, still no
// `--manifest` flag on `pack --help`) always reads `manifest.json` from the root of the directory
// it packs, and the repo root's own manifest.json is the companion plugin's Obsidian manifest
// (THE-950), not the MCPB bundle manifest (which lives at mcpb/manifest.json). The previous
// approach swapped the MCPB manifest onto the live root manifest.json for the duration of the pack
// call and restored it in a `finally` — not kill-safe: a process killed between the swap and the
// restore left the live tree's manifest.json permanently overwritten (THE-950's failure mode,
// reproduced by the THE-950 review with `kill -9`). This module packs from a throwaway staging
// directory instead, so the live tree is never written to at all (except the `.mcpb` output
// itself, which lands outside the staging dir).
//
// Kept dependency-free (no `bun` import) so it can be unit-tested under plain `node --test`
// (scripts/*.test.mjs) — bundle-mcpb.ts is the only caller that needs Bun's `$` shell, to invoke
// the actual `mcpb` CLI; this module only touches the filesystem.
import {
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The ONLY repo paths that are staged, relative to the repo root. This is an allow-list on purpose:
// the step used to stage the whole checkout and leave it to .mcpbignore to deny what should not
// ship, so every new tracked file (a deploy config, a linter config, a services/ tree) went into
// the bundle until someone named it there. A path the bundle needs is added HERE.
//
//   .mcpbignore              applied by the CLI to what is staged (it drops itself, and prunes
//                            inside packages/server/dist); never packed.
//   packages/server          only dist/ (the built server and its assets) and the three files
//                            beside it. package.json is load-bearing: its "type": "module" is what
//                            makes Node load dist/cli.js as ESM.
//
// Not staged, and why it matters: the root manifest.json is the companion plugin's Obsidian manifest
// (THE-950). The bundle's manifest.json is written fresh below from mcpb/manifest.json, so it is
// never a write through a hardlink to the live tree's file (THE-951). node_modules is assembled by
// stageRuntimeModules, not copied.
export const STAGED_REPO_PATHS = [
  ".mcpbignore",
  "LICENSE",
  "NOTICE",
  "README.md",
  "package.json",
  "packages/server/LICENSE",
  "packages/server/NOTICE",
  "packages/server/package.json",
  "packages/server/dist",
];

// Every name the packed bundle may hold at its root. The files come from the repo (manifest.json
// from mcpb/manifest.json), `node_modules` is assembled by stageRuntimeModules, and the third-party
// licence file is one the caller's `populate` may write.
export const BUNDLE_ROOT_ENTRIES = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "manifest.json",
  "package.json",
  "THIRD-PARTY-LICENSES.txt",
  "node_modules",
  "packages",
];

/**
 * Hardlinks `src` onto `dest`, falling back to a real copy when they are on different
 * filesystems (`EXDEV` — a `link(2)` limitation, not something a retry fixes). Injectable so
 * the EXDEV fallback is deterministically testable without depending on the host's mount layout.
 */
export async function linkOrCopy(
  src,
  dest,
  { link: linkFn = link, copyFile: copyFileFn = copyFile } = {},
) {
  try {
    await linkFn(src, dest);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await copyFileFn(src, dest);
  }
}

async function stageTree(src, dest) {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    await symlink(await readlink(src), dest);
    return;
  }
  if (st.isDirectory()) {
    await mkdir(dest, { recursive: true });
    for (const name of await readdir(src)) {
      // Workspace-level install trees (packages/*/node_modules, symlinked into the bun store) never
      // ship; the bundle's own node_modules is assembled by stageRuntimeModules below.
      if (name === "node_modules") continue;
      await stageTree(join(src, name), join(dest, name));
    }
    return;
  }
  await linkOrCopy(src, dest);
}

/**
 * Populates `stagingDir` with the bundle's inputs: STAGED_REPO_PATHS and nothing else (hardlinked
 * where possible, since the pack step only reads), plus `mcpb/manifest.json`'s content written
 * fresh as `manifest.json` at the staging root. A listed path that is missing is an error, not a
 * bundle silently packed without it.
 */
export async function stageBundleInputs(repoRoot, stagingDir) {
  for (const path of STAGED_REPO_PATHS) {
    const parts = path.split("/");
    const dest = join(stagingDir, ...parts);
    await mkdir(dirname(dest), { recursive: true });
    await stageTree(join(repoRoot, ...parts), dest);
  }
  const mcpbManifest = await readFile(join(repoRoot, "mcpb", "manifest.json"));
  await writeFile(join(stagingDir, "manifest.json"), mcpbManifest);
}

/**
 * Throws when the staging root holds a name outside BUNDLE_ROOT_ENTRIES (`.mcpbignore` aside, which
 * the CLI reads and drops). The CLI only removes entries, so a clean staging root is a clean bundle
 * root; this is what stops a `populate` step from adding a root file nobody declared.
 */
export async function assertStagingRoot(stagingDir) {
  const allowed = new Set([...BUNDLE_ROOT_ENTRIES, ".mcpbignore"]);
  const stray = (await readdir(stagingDir)).filter((name) => !allowed.has(name));
  if (stray.length > 0) {
    throw new Error(
      `mcpb-staging: ${stray.join(", ")} would be packed at the bundle root but is not in BUNDLE_ROOT_ENTRIES`,
    );
  }
}

const EMBEDDER_PACKAGE = "@the-40-thieves/reliquary-tc-embedder-local";

/**
 * Assembles the bundle's own `node_modules` (no install tree is ever copied from the repo): the packages the server reaches by bare specifier at run time that a bundle would
 * otherwise lack.
 *
 *   sqlite-vec       the loader package plus ALL of its platform packages: one .mcpb runs on every
 *                    OS, so vec0 for each must be inside it (they are ~150 KB each).
 *   embedder-local   the default embeddings provider, as ONE bundled file (scripts/lib/
 *                    embedder-bundle.mjs inlines Transformers.js and the ONNX runtime shim), plus
 *                    native files under `ort/<platform>-<arch>/` and darwin-x64 WASM files beside
 *                    the bundle.
 *
 * `sources` is `{ sqliteVec: { dir, platformPackages: [{ name, dir }] },
 *   embedder: { version, bundleFile, wasmFiles: [{ name, path }],
 *     ortFiles: { "<platform>-<arch>": [{ name, path }] } } }`.
 */
export async function stageRuntimeModules(stagingDir, sources) {
  const modules = join(stagingDir, "node_modules");
  const vec = sources.sqliteVec;
  await cp(vec.dir, join(modules, "sqlite-vec"), { recursive: true, dereference: true });
  for (const p of vec.platformPackages) {
    await cp(p.dir, join(modules, p.name), { recursive: true, dereference: true });
  }
  const embedderDir = join(modules, ...EMBEDDER_PACKAGE.split("/"));
  await mkdir(embedderDir, { recursive: true });
  await copyFile(sources.embedder.bundleFile, join(embedderDir, "index.mjs"));
  const manifest = {
    name: EMBEDDER_PACKAGE,
    version: sources.embedder.version,
    type: "module",
    main: "./index.mjs",
    exports: { ".": "./index.mjs", "./package.json": "./package.json" },
  };
  await writeFile(join(embedderDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const f of sources.embedder.wasmFiles) {
    await copyFile(f.path, join(embedderDir, f.name));
  }
  for (const [platformKey, files] of Object.entries(sources.embedder.ortFiles)) {
    const ortDir = join(embedderDir, "ort", platformKey);
    await mkdir(ortDir, { recursive: true });
    for (const f of files) await copyFile(f.path, join(ortDir, f.name));
  }
}

/**
 * Builds a staging directory under the OS temp dir, populates it via stageBundleInputs (then
 * `populate(stagingDir)`, for the bundle's node_modules), checks its root with assertStagingRoot,
 * calls `pack(stagingDir, outFile)` to
 * produce the bundle, and always removes the staging directory (success or failure — the `finally`
 * is what makes a thrown pack leave nothing behind). The live tree at `repoRoot` is never written
 * to except `outFile` itself.
 */
export async function packFromStaging(repoRoot, outFile, { pack, populate }) {
  const stagingDir = await mkdtemp(join(tmpdir(), "reliquary-tc-mcpb-"));
  try {
    await stageBundleInputs(repoRoot, stagingDir);
    await populate?.(stagingDir);
    await assertStagingRoot(stagingDir);
    await pack(stagingDir, outFile);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
