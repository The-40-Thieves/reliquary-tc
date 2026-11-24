// What a binary's licence file adds to the bundler's package list: the libraries baked in as
// bytes by earlier build steps, read back from the generated modules those steps write.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import {
  embeddedParts,
  licenseFilePath,
  OVERRIDE_ALIASES,
  OVERRIDES_DIR,
  writeBinaryLicenseFile,
} from "./lib/binary-license-file.mjs";
import { SQLITE_VEC_TARGETS } from "./lib/sqlite-vec-targets.mjs";
import { overrideFileName } from "./lib/third-party-licenses.mjs";

const REPO = resolve(import.meta.dirname, "..");
const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// A server directory whose two generated modules hold `vec` and `sqlite` as their embedded value.
function serverDir({ vec = "", sqlite = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blf-test-"));
  roots.push(root);
  const files = {
    "src/search/vec-embedded.ts": `export const EMBEDDED_VEC_BASE64 = ${JSON.stringify(vec)};\n`,
    "src/db/sqlite-embedded.ts": `export const EMBEDDED_SQLITE_BASE64 = ${JSON.stringify(sqlite)};\n`,
    "node_modules/sqlite-vec/package.json": JSON.stringify({
      name: "sqlite-vec",
      version: "0.1.9",
    }),
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

test("the committed placeholders are the empty form this module reads as 'nothing embedded'", () => {
  const { extras, notes } = embeddedParts({
    target: "bun-linux-x64",
    serverDir: join(REPO, "packages", "server"),
  });
  assert.deepEqual(extras, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Bun runtime/);
});

test("a build that embedded sqlite-vec lists that target's platform package", () => {
  for (const [target, { pkg }] of Object.entries(SQLITE_VEC_TARGETS)) {
    const { extras } = embeddedParts({ target, serverDir: serverDir({ vec: "AAAA" }) });
    assert.deepEqual(extras, [
      { name: pkg, version: "0.1.9", license: "MIT OR Apache-2.0", override: "sqlite-vec" },
    ]);
  }
});

test("sqlite-vec embedded for a target with no platform package is an error, not a silent gap", () => {
  assert.throws(
    () => embeddedParts({ target: "bun-plan9-x64", serverDir: serverDir({ vec: "AAAA" }) }),
    /sqlite-vec is embedded for unknown bun-plan9-x64/,
  );
});

test("the SQLite note appears only in a build that embedded SQLite", () => {
  const without = embeddedParts({ target: "bun-darwin-arm64", serverDir: serverDir() });
  const withIt = embeddedParts({
    target: "bun-darwin-arm64",
    serverDir: serverDir({ sqlite: "AAAA" }),
  });
  assert.ok(!without.notes.some((n) => n.includes("SQLite")));
  assert.ok(withIt.notes.some((n) => /SQLite.*public domain/.test(n)));
});

test("the licence file is named for the target, so the windows file carries no .exe", () => {
  assert.equal(
    licenseFilePath(join("dist", "reliquary-tc-bun-windows-x64")),
    join("dist", "reliquary-tc-bun-windows-x64-licenses.txt"),
  );
});

test("every reviewed text in the overrides folder is non-empty and every alias points at one", () => {
  const texts = readdirSync(OVERRIDES_DIR).filter((f) => f.endsWith(".txt"));
  assert.ok(texts.length >= 3, `expected the reviewed texts, found ${texts.length}`);
  for (const f of texts) {
    assert.ok(
      readFileSync(join(OVERRIDES_DIR, f), "utf8").trim().length > 500,
      `${f} is too short`,
    );
  }
  for (const key of [...Object.values(OVERRIDE_ALIASES), "sqlite-vec"]) {
    assert.ok(existsSync(join(OVERRIDES_DIR, overrideFileName(key))), `no text for ${key}`);
  }
});

test("a written file holds the project's texts, the bundled package and the embedded library", () => {
  const cwd = mkdtempSync(join(tmpdir(), "blf-cwd-"));
  roots.push(cwd);
  const files = {
    "node_modules/dep/package.json": JSON.stringify({
      name: "dep",
      version: "1.0.0",
      license: "MIT",
    }),
    "node_modules/dep/LICENSE": "DEP LICENCE TEXT\n",
    "node_modules/dep/index.js": "",
    LICENSE: "PROJECT LICENCE\n",
    NOTICE: "PROJECT NOTICE\n",
    "packages/server/src/search/vec-embedded.ts": 'export const EMBEDDED_VEC_BASE64 = "AAAA";\n',
    "packages/server/src/db/sqlite-embedded.ts": 'export const EMBEDDED_SQLITE_BASE64 = "";\n',
    "packages/server/node_modules/sqlite-vec/package.json": JSON.stringify({ version: "0.1.9" }),
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), body);
  }
  const outfile = join(cwd, "out", "reliquary-tc-bun-linux-x64");
  mkdirSync(dirname(outfile), { recursive: true });
  const path = writeBinaryLicenseFile({
    target: "bun-linux-x64",
    outfile,
    inputs: ["node_modules/dep/index.js", "packages/server/src/cli.ts"],
    cwd,
    repoRoot: cwd,
  });
  assert.equal(path, `${outfile}-licenses.txt`);
  const text = readFileSync(path, "utf8");
  for (const want of [
    "Licence notices for reliquary-tc-bun-linux-x64",
    "PROJECT NOTICE",
    "PROJECT LICENCE",
    "dep@1.0.0 (MIT)",
    "DEP LICENCE TEXT",
    "sqlite-vec-linux-x64@0.1.9 (MIT OR Apache-2.0)",
    "Copyright (c) 2024 Alex Garcia",
  ]) {
    assert.ok(text.includes(want), `missing: ${want}`);
  }
});

test("a build whose package list cannot be completed writes no file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "blf-cwd-"));
  roots.push(cwd);
  const files = {
    "node_modules/bare/package.json": JSON.stringify({
      name: "bare",
      version: "1.0.0",
      license: "MIT",
    }),
    "node_modules/bare/index.js": "",
    LICENSE: "x\n",
    NOTICE: "x\n",
    "packages/server/src/search/vec-embedded.ts": 'export const EMBEDDED_VEC_BASE64 = "";\n',
    "packages/server/src/db/sqlite-embedded.ts": 'export const EMBEDDED_SQLITE_BASE64 = "";\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), body);
  }
  const outfile = join(cwd, "reliquary-tc-bun-linux-x64");
  assert.throws(
    () =>
      writeBinaryLicenseFile({
        target: "bun-linux-x64",
        outfile,
        inputs: ["node_modules/bare/index.js"],
        cwd,
        repoRoot: cwd,
      }),
    /bare@1\.0\.0 ships no licence text/,
  );
  assert.equal(existsSync(`${outfile}-licenses.txt`), false);
});

test("build-binary.ts asks the bundler for its input list and writes the licence file from it", () => {
  const src = readFileSync(join(REPO, "scripts", "build-binary.ts"), "utf8");
  assert.match(src, /^ {4}metafile: true,$/m);
  assert.match(src, /writeBinaryLicenseFile\(\{/);
  assert.match(src, /inputs: Object\.keys\(result\.metafile\.inputs\)/);
  // A build that returned no input list must stop, not ship a binary with no licence file.
  assert.match(src, /if \(!result\.metafile\) throw new Error/);
});
