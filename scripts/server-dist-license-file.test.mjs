// The licence file the server build writes into dist (scripts/lib/server-dist-license-file.mjs).
// dist is what the npm package and the Docker image ship, so the file travels with both.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DIST_LICENSE_FILE, writeServerDistLicenseFile } from "./lib/server-dist-license-file.mjs";

const REPO = join(import.meta.dirname, "..");

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "dist-licence-"));
  for (const [path, body] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

const DIST = "packages/server/dist";

function fixture() {
  return tree({
    LICENSE: "PROJECT LICENCE\n",
    NOTICE: "PROJECT NOTICE\n",
    [`${DIST}/cli.js`]: "//\n",
    [`${DIST}/cli.js.map`]: {
      sources: ["../src/cli.ts", "../../../node_modules/dep/index.js"],
    },
    "node_modules/dep/package.json": { name: "dep", version: "1.0.0", license: "MIT" },
    "node_modules/dep/LICENSE": "DEP LICENCE TEXT\n",
  });
}

const write = (root) =>
  writeServerDistLicenseFile({
    distDir: join(root, DIST),
    repoRoot: root,
    overridesDir: join(root, "overrides"),
  });

test("the server build writes a licence file into dist, from the bundles' source maps", () => {
  const root = fixture();
  try {
    const result = write(root);
    assert.equal(result.path, join(root, DIST, DIST_LICENSE_FILE));
    assert.equal(result.packages, 1);
    const text = readFileSync(result.path, "utf8");
    assert.match(text, /^Licence notices for the reliquary-tc server build\n/);
    for (const expected of [
      "PROJECT LICENCE",
      "PROJECT NOTICE",
      "dep@1.0.0 (MIT)",
      "DEP LICENCE",
    ]) {
      assert.ok(text.includes(expected), `missing: ${expected}`);
    }
    assert.match(text, /Third-party packages built into these files \(1\)/);
    assert.match(text, /installs beside this build/);
    assert.doesNotMatch(text, /executable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bundled package with no licence text stops the build and leaves no file", () => {
  const root = fixture();
  try {
    rmSync(join(root, "node_modules", "dep", "LICENSE"));
    assert.throws(() => write(root), /dep@1\.0\.0 ships no licence text/);
    assert.equal(existsSync(join(root, DIST, DIST_LICENSE_FILE)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rebuild replaces the licence file and never reads the old one as a bundle", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, DIST, DIST_LICENSE_FILE), "STALE\n");
    const result = write(root);
    assert.doesNotMatch(readFileSync(result.path, "utf8"), /STALE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the server build script writes the file after it has finished the source maps", () => {
  const src = readFileSync(join(REPO, "packages", "server", "scripts", "copy-assets.mjs"), "utf8");
  const call = src.indexOf("writeServerDistLicenseFile({");
  assert.ok(call !== -1, "copy-assets.mjs does not write the licence file");
  assert.ok(call > src.indexOf("prepended node shebang"), "written before the map is final");
});

test("the install smoke checks the licence file in the tarball npm would publish", () => {
  const yml = readFileSync(join(REPO, ".github", "workflows", "ci-install-smoke.yml"), "utf8");
  assert.ok(yml.includes(`test -s .tarball-check/package/dist/${DIST_LICENSE_FILE}`));
});
