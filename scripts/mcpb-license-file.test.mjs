// The licence file packed into the MCPB bundle (scripts/lib/mcpb-license-file.mjs).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  assertLicenceFilesPacked,
  buildMcpbLicenseText,
  listZipEntries,
  MCPB_LICENSE_FILE,
} from "./lib/mcpb-license-file.mjs";
import { sourceMapInputs } from "./lib/server-dist-license-file.mjs";

const REPO = join(import.meta.dirname, "..");

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "mcpb-licence-"));
  for (const [path, body] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

const pkg = (name, license = "MIT", version = "1.0.0") => ({ name, version, license });
const DIST = "packages/server/dist";

/** A repo with a built server, one bundled package, the embedder's packages and sqlite-vec. */
function fixture(extra = {}) {
  return tree({
    LICENSE: "PROJECT LICENCE\n",
    NOTICE: "PROJECT NOTICE\n",
    [`${DIST}/cli.js`]: "//\n",
    [`${DIST}/cli.js.map`]: {
      sources: ["../src/cli.ts", "../../../node_modules/dep/index.js"],
    },
    "node_modules/dep/package.json": pkg("dep"),
    "node_modules/dep/LICENSE": "DEP LICENCE TEXT\n",
    "embedder/node_modules/model-lib/package.json": pkg("model-lib", "Apache-2.0"),
    "embedder/node_modules/model-lib/LICENSE": "MODEL LIB LICENCE TEXT\n",
    "embedder/node_modules/onnxruntime-node/package.json": pkg("onnxruntime-node"),
    "vec/sqlite-vec/package.json": pkg("sqlite-vec", "MIT OR Apache", "0.1.9"),
    "vec/sqlite-vec-linux-x64/package.json": pkg("sqlite-vec-linux-x64", "MIT OR Apache", "0.1.9"),
    "overrides/sqlite-vec.txt": "SQLITE VEC LICENCE TEXT\n",
    "overrides/onnxruntime.txt": "ORT LICENCE TEXT\n",
    ...extra,
  });
}

function build(root) {
  return buildMcpbLicenseText({
    repoRoot: root,
    artifact: "reliquary-tc.mcpb",
    serverDist: join(root, DIST),
    embedderInputs: ["embedder/node_modules/model-lib/index.js", "embedder/dist/index.js"],
    embedderBaseDir: root,
    sqliteVec: {
      dir: join(root, "vec", "sqlite-vec"),
      platformPackages: [
        { name: "sqlite-vec-linux-x64", dir: join(root, "vec", "sqlite-vec-linux-x64") },
      ],
    },
    ortDirs: [join(root, "embedder", "node_modules", "onnxruntime-node")],
    overridesDir: join(root, "overrides"),
  });
}

test("sourceMapInputs resolves every source of every built bundle against the dist folder", () => {
  const root = tree({
    "dist/cli.js": "//\n",
    "dist/cli.js.map": { sources: ["../src/cli.ts", "../node_modules/a/index.js"] },
    "dist/index.js": "//\n",
    "dist/index.js.map": { sources: ["../node_modules/b/index.js"] },
    "dist/plugin/main.js": "//\n",
  });
  try {
    assert.deepEqual(sourceMapInputs(join(root, "dist")), [
      join(root, "src", "cli.ts"),
      join(root, "node_modules", "a", "index.js"),
      join(root, "node_modules", "b", "index.js"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sourceMapInputs refuses a bundle without a source map, and a dist without bundles", () => {
  const root = tree({ "dist/cli.js": "//\n", "empty/readme.txt": "x" });
  try {
    assert.throws(() => sourceMapInputs(join(root, "dist")), /cli\.js has no source map/);
    assert.throws(() => sourceMapInputs(join(root, "empty")), /no built \.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sourceMapInputs refuses a source map that lists no sources", () => {
  const root = tree({ "dist/cli.js": "//\n", "dist/cli.js.map": { sources: [] } });
  try {
    assert.throws(() => sourceMapInputs(join(root, "dist")), /cli\.js\.map lists no sources/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the bundle's licence file covers the server, the embedder and the files copied in whole", () => {
  const root = fixture();
  try {
    const text = build(root);
    assert.match(text, /^Licence notices for reliquary-tc\.mcpb\n/);
    for (const expected of [
      "PROJECT LICENCE",
      "PROJECT NOTICE",
      "dep@1.0.0 (MIT)",
      "DEP LICENCE TEXT",
      "model-lib@1.0.0 (Apache-2.0)",
      "MODEL LIB LICENCE TEXT",
      "sqlite-vec@0.1.9 (MIT OR Apache-2.0)",
      "sqlite-vec-linux-x64@0.1.9 (MIT OR Apache-2.0)",
      "SQLITE VEC LICENCE TEXT",
      "onnxruntime-node@1.0.0 (MIT)",
      "ORT LICENCE TEXT",
      "ThirdPartyNotices.txt",
    ]) {
      assert.ok(text.includes(expected), `missing: ${expected}`);
    }
    assert.match(text, /Third-party packages in this bundle \(5\)/);
    assert.doesNotMatch(text, /executable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the bundle's licence file is refused when a bundled package has no licence text", () => {
  const root = fixture();
  try {
    rmSync(join(root, "node_modules", "dep", "LICENSE"));
    assert.throws(() => build(root), /dep@1\.0\.0 ships no licence text/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the bundle's licence file is refused when a copied-in package has no reviewed text", () => {
  const root = fixture();
  try {
    rmSync(join(root, "overrides", "sqlite-vec.txt"));
    assert.throws(() => build(root), /sqlite-vec@0\.1\.9 ships no licence text/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/** A stored (uncompressed) zip of empty entries: enough to carry names in a central directory. */
function zipOf(names, trailer = Buffer.alloc(0)) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name);
    const local = Buffer.concat([u32(0x04034b50), Buffer.alloc(22), u16(n.length), u16(0), n]);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        Buffer.alloc(24),
        u16(n.length),
        Buffer.alloc(12),
        u32(offset),
        n,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50),
    Buffer.alloc(4),
    u16(names.length),
    u16(names.length),
    u32(dir.length),
    u32(offset),
    u16(trailer.length),
    trailer,
  ]);
  return Buffer.concat([...locals, dir, end]);
}

test("listZipEntries reads the names from an archive's central directory", () => {
  const root = tree({});
  try {
    const names = ["LICENSE", "packages/server/dist/cli.js", MCPB_LICENSE_FILE];
    writeFileSync(join(root, "a.zip"), zipOf(names));
    writeFileSync(join(root, "b.zip"), zipOf(names, Buffer.from("a comment")));
    assert.deepEqual(listZipEntries(join(root, "a.zip")), names);
    assert.deepEqual(listZipEntries(join(root, "b.zip")), names);
    writeFileSync(join(root, "c.zip"), "not an archive");
    assert.throws(() => listZipEntries(join(root, "c.zip")), /no zip directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a packed bundle must carry LICENSE, NOTICE and the third-party licence file", () => {
  const all = ["manifest.json", "LICENSE", "NOTICE", MCPB_LICENSE_FILE];
  assert.doesNotThrow(() => assertLicenceFilesPacked(all));
  for (const lost of ["LICENSE", "NOTICE", MCPB_LICENSE_FILE]) {
    assert.throws(
      () => assertLicenceFilesPacked(all.filter((n) => n !== lost)),
      (err) => err.message.includes(lost),
    );
  }
  // A file of the same name deeper in the tree is not the bundle's own.
  assert.throws(() => assertLicenceFilesPacked(["LICENSE", "NOTICE", `docs/${MCPB_LICENSE_FILE}`]));
});

test("bundle-mcpb.ts writes the licence file into the staging folder and checks the packed bundle", () => {
  const src = readFileSync(join(REPO, "scripts", "bundle-mcpb.ts"), "utf8");
  assert.match(src, /metafile: true/);
  assert.match(src, /buildMcpbLicenseText\(/);
  assert.match(src, /join\(stagingDir, MCPB_LICENSE_FILE\)/);
  assert.match(src, /assertLicenceFilesPacked\(listZipEntries\(outFile\)\)/);
});
