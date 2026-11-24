// The licence file that ships beside each standalone binary is built from the files the bundler
// actually put into that binary. These tests pin the collector's rules on fixture trees: which
// inputs count as a third-party package, where a licence text comes from, and every case in which
// it must refuse to write a file rather than write an incomplete one.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  buildLicenseFile,
  collectThirdParty,
  overrideFileName,
  packageDirsFromInputs,
} from "./lib/third-party-licenses.mjs";

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// Build a fixture tree from { "relative/path": "contents" } and return its root.
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "tpl-test-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}
const pkg = (name, version, license) => JSON.stringify({ name, version, license });
const MIT_A = "MIT License\n\nCopyright (c) Alpha\n";
const PROJECT = { name: "Example", license: "PROJECT LICENCE TEXT\n", notice: "PROJECT NOTICE\n" };

const baseTree = () =>
  tree({
    "src/cli.ts": "",
    "node_modules/alpha/package.json": pkg("alpha", "1.0.0", "MIT"),
    "node_modules/alpha/LICENSE": MIT_A,
    "node_modules/alpha/dist/index.js": "",
    "node_modules/@scope/beta/package.json": pkg("@scope/beta", "2.1.0", "Apache-2.0"),
    "node_modules/@scope/beta/LICENSE.md": "Apache text\n",
    "node_modules/@scope/beta/NOTICE": "Beta notice\n",
    "node_modules/@scope/beta/lib/a.js": "",
    "packages/own/node_modules/gamma/package.json": pkg("gamma", "0.3.0", "ISC"),
    "packages/own/node_modules/gamma/license.txt": "ISC text\n",
    "packages/own/node_modules/gamma/index.js": "",
  });
const BASE_INPUTS = [
  "src/cli.ts",
  "node_modules/alpha/dist/index.js",
  "node_modules/@scope/beta/lib/a.js",
  "packages/own/node_modules/gamma/index.js",
];

test("inputs map to one directory per package: scoped, nested roots, and nothing first-party", () => {
  const root = baseTree();
  const dirs = packageDirsFromInputs(
    [...BASE_INPUTS, "node_modules/alpha/dist/other.js", "obtc-stub:sharp"],
    root,
  );
  assert.deepEqual(dirs, [
    join(root, "node_modules", "@scope", "beta"),
    join(root, "node_modules", "alpha"),
    join(root, "packages", "own", "node_modules", "gamma"),
  ]);
});

test("a package nested under another package's node_modules resolves to the inner package", () => {
  const root = tree({
    "node_modules/outer/node_modules/inner/package.json": pkg("inner", "1.0.0", "MIT"),
    "node_modules/outer/node_modules/inner/x.js": "",
  });
  assert.deepEqual(packageDirsFromInputs(["node_modules/outer/node_modules/inner/x.js"], root), [
    join(root, "node_modules", "outer", "node_modules", "inner"),
  ]);
});

test("every bundled package is collected with its name, version, licence and text files", () => {
  const root = baseTree();
  const { packages, problems } = collectThirdParty({ inputs: BASE_INPUTS, baseDir: root });
  assert.deepEqual(problems, []);
  assert.deepEqual(
    packages.map((p) => [p.name, p.version, p.license, p.texts.map((t) => t.file)]),
    [
      ["@scope/beta", "2.1.0", "Apache-2.0", ["LICENSE.md", "NOTICE"]],
      ["alpha", "1.0.0", "MIT", ["LICENSE"]],
      ["gamma", "0.3.0", "ISC", ["license.txt"]],
    ],
  );
  assert.equal(packages[1].texts[0].text, MIT_A);
});

test("a bundled package with no licence text is a problem that names it", () => {
  const root = tree({
    "node_modules/bare/package.json": pkg("bare", "1.0.0", "MIT"),
    "node_modules/bare/index.js": "",
  });
  const { problems } = collectThirdParty({ inputs: ["node_modules/bare/index.js"], baseDir: root });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /bare@1\.0\.0 ships no licence text/);
});

test("a licence that is not on the accepted list is a problem, and so is a missing one", () => {
  const root = tree({
    "node_modules/copyleft/package.json": pkg("copyleft", "1.0.0", "GPL-3.0-only"),
    "node_modules/copyleft/LICENSE": "GPL\n",
    "node_modules/copyleft/index.js": "",
    "node_modules/unstated/package.json": JSON.stringify({ name: "unstated", version: "1.0.0" }),
    "node_modules/unstated/LICENSE": "something\n",
    "node_modules/unstated/index.js": "",
  });
  const { problems } = collectThirdParty({
    inputs: ["node_modules/copyleft/index.js", "node_modules/unstated/index.js"],
    baseDir: root,
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /copyleft@1\.0\.0 is licensed "GPL-3\.0-only", which is not accepted/);
  assert.match(problems[1], /unstated@1\.0\.0 declares no licence/);
});

test("a graph with no third-party package at all is a problem, not an empty success", () => {
  const root = tree({ "src/cli.ts": "" });
  const { problems } = collectThirdParty({ inputs: ["src/cli.ts"], baseDir: root });
  assert.deepEqual(problems, ["no third-party package was found in the build's inputs"]);
});

test("an input under node_modules with no package.json is a problem", () => {
  const root = tree({ "node_modules/ghost/index.js": "" });
  const { problems } = collectThirdParty({
    inputs: ["node_modules/ghost/index.js"],
    baseDir: root,
  });
  assert.match(problems[0], /ghost has no package\.json/);
});

test("a reviewed override supplies the text for a package that ships none", () => {
  const root = tree({
    "node_modules/@scope/bare/package.json": pkg("@scope/bare", "1.0.0", "MIT"),
    "node_modules/@scope/bare/index.js": "",
    "overrides/@scope__bare.txt": "Reviewed MIT text\n",
  });
  assert.equal(overrideFileName("@scope/bare"), "@scope__bare.txt");
  const { packages, problems } = collectThirdParty({
    inputs: ["node_modules/@scope/bare/index.js"],
    baseDir: root,
    overridesDir: join(root, "overrides"),
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(packages[0].texts, [{ file: "@scope__bare.txt", text: "Reviewed MIT text\n" }]);
});

test("an override for a package that ships its own text is a problem: the table must not go stale", () => {
  const root = baseTree();
  writeFileSync(join(root, "alpha.txt"), "stale\n");
  const { problems } = collectThirdParty({
    inputs: BASE_INPUTS,
    baseDir: root,
    overridesDir: root,
  });
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /alpha@1\.0\.0 ships its own licence text; remove the override alpha\.txt/,
  );
});

test("an embedded file that is not in the module graph is listed through an explicit extra", () => {
  const root = baseTree();
  writeFileSync(join(root, "vec.txt"), "vec licence\n");
  const extras = [
    { name: "vec-linux-x64", version: "0.1.9", license: "MIT OR Apache-2.0", override: "vec" },
  ];
  const { packages, problems } = collectThirdParty({
    inputs: BASE_INPUTS,
    baseDir: root,
    overridesDir: root,
    extras,
  });
  assert.deepEqual(problems, []);
  const vec = packages.find((p) => p.name === "vec-linux-x64");
  assert.deepEqual(vec, {
    name: "vec-linux-x64",
    version: "0.1.9",
    license: "MIT OR Apache-2.0",
    texts: [{ file: "vec.txt", text: "vec licence\n" }],
  });
});

test("an extra whose override text is absent is a problem", () => {
  const root = baseTree();
  const { problems } = collectThirdParty({
    inputs: BASE_INPUTS,
    baseDir: root,
    overridesDir: root,
    extras: [{ name: "vec-linux-x64", version: "0.1.9", license: "MIT", override: "vec" }],
  });
  assert.match(problems[0], /vec-linux-x64@0\.1\.9 ships no licence text/);
});

test("the file is the same whatever order the bundler lists its inputs in", () => {
  const root = baseTree();
  const opts = {
    artifact: "example-linux-x64",
    baseDir: root,
    project: PROJECT,
    notes: ["A note."],
  };
  const a = buildLicenseFile({ ...opts, inputs: BASE_INPUTS });
  const b = buildLicenseFile({ ...opts, inputs: [...BASE_INPUTS].reverse() });
  assert.equal(a, b);
  assert.ok(!a.includes("\r"));
});

test("the file carries the project's own notice and licence, every package, and the notes", () => {
  const root = baseTree();
  const text = buildLicenseFile({
    artifact: "example-linux-x64",
    baseDir: root,
    inputs: BASE_INPUTS,
    project: PROJECT,
    notes: ["The runtime is covered elsewhere."],
  });
  assert.match(text, /^Licence notices for example-linux-x64\n/);
  for (const want of [
    "PROJECT NOTICE",
    "PROJECT LICENCE TEXT",
    "@scope/beta@2.1.0 (Apache-2.0)",
    "alpha@1.0.0 (MIT)",
    "gamma@0.3.0 (ISC)",
    "Copyright (c) Alpha",
    "Beta notice",
    "ISC text",
    "The runtime is covered elsewhere.",
  ]) {
    assert.ok(text.includes(want), `missing: ${want}`);
  }
  // sorted by package name
  assert.ok(text.indexOf("@scope/beta@2.1.0") < text.indexOf("alpha@1.0.0"));
  assert.ok(text.indexOf("alpha@1.0.0") < text.indexOf("gamma@0.3.0"));
});

test("packages that share one identical text are listed together above a single copy of it", () => {
  const root = tree({
    "node_modules/one/package.json": pkg("one", "1.0.0", "Apache-2.0"),
    "node_modules/one/LICENSE": "SHARED APACHE TEXT\n",
    "node_modules/one/i.js": "",
    "node_modules/two/package.json": pkg("two", "1.0.0", "Apache-2.0"),
    "node_modules/two/LICENSE": "SHARED APACHE TEXT\r\n",
    "node_modules/two/i.js": "",
  });
  const text = buildLicenseFile({
    artifact: "x",
    baseDir: root,
    inputs: ["node_modules/one/i.js", "node_modules/two/i.js"],
    project: PROJECT,
  });
  assert.equal(text.split("SHARED APACHE TEXT").length - 1, 1);
  assert.match(text, /one@1\.0\.0 \(Apache-2\.0\)\ntwo@1\.0\.0 \(Apache-2\.0\)\n/);
});

test("any problem stops the file from being written, and the error lists every one", () => {
  const root = tree({
    "node_modules/bare/package.json": pkg("bare", "1.0.0", "MIT"),
    "node_modules/bare/index.js": "",
    "node_modules/copyleft/package.json": pkg("copyleft", "1.0.0", "GPL-3.0-only"),
    "node_modules/copyleft/LICENSE": "GPL\n",
    "node_modules/copyleft/index.js": "",
  });
  assert.throws(
    () =>
      buildLicenseFile({
        artifact: "x",
        baseDir: root,
        inputs: ["node_modules/bare/index.js", "node_modules/copyleft/index.js"],
        project: PROJECT,
      }),
    (e) =>
      /bare@1\.0\.0 ships no licence text/.test(e.message) && /copyleft@1\.0\.0/.test(e.message),
  );
});
