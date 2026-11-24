// The licence file at the root of the Docker image (scripts/lib/image-license-file.mjs). The image
// copies whole node_modules folders, so the list is read from those folders.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { packageDirsInTree, writeImageLicenseFile } from "./lib/image-license-file.mjs";
import { collectThirdParty } from "./lib/third-party-licenses.mjs";

const REPO = join(import.meta.dirname, "..");
const TEXTS = join(REPO, "scripts", "third-party-license-texts");

/** A package folder: its manifest, and a LICENSE unless `text` is false. */
function pkg(dir, name, license, text = true) {
  const files = { [`${dir}/package.json`]: JSON.stringify({ name, version: "1.0.0", license }) };
  if (text) files[`${dir}/LICENSE`] = `TEXT OF ${name}\n`;
  return files;
}

function scratch(files) {
  const root = mkdtempSync(join(tmpdir(), "image-licence-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const withScratch = (files, run) => {
  const root = scratch(files);
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const SERVER = {
  LICENSE: "PROJECT LICENCE\n",
  NOTICE: "PROJECT NOTICE\n",
  "packages/server/dist/cli.js": "//\n",
  "packages/server/dist/cli.js.map": JSON.stringify({
    sources: ["../src/cli.ts", "../../../node_modules/built-in/index.js"],
  }),
  ...pkg("node_modules/built-in", "built-in", "MIT"),
  "overrides/sqlite-vec.txt": "BOTH SQLITE-VEC TEXTS\n",
  "overrides/sharp-libvips.txt": "LIBVIPS NOTICE AND LGPL\n",
};

const write = (root, trees) =>
  writeImageLicenseFile({
    outFile: join(root, "out", "THIRD-PARTY-LICENSES.txt"),
    trees: trees.map((tree) => join(root, tree)),
    serverDist: join(root, "packages", "server", "dist"),
    repoRoot: root,
    overridesDir: join(root, "overrides"),
  });

test("every package folder in a tree is found, however it was installed", () => {
  const files = {
    ...pkg("nm/plain", "plain", "MIT"),
    ...pkg("nm/@scope/scoped", "@scope/scoped", "MIT"),
    ...pkg("nm/plain/node_modules/nested", "nested", "MIT"),
    ...pkg("nm/.bun/stored@1.0.0/node_modules/stored", "stored", "MIT"),
    ...pkg("nm/@the-40-thieves/reliquary-tc-native", "@the-40-thieves/reliquary-tc-native", "x"),
    "nm/.bin/tool": "#!/bin/sh\n",
    "nm/.package-lock.json": "{}",
  };
  withScratch(files, (root) => {
    const names = packageDirsInTree(join(root, "nm")).map((dir) => basename(dir));
    assert.deepEqual(names.sort(), ["nested", "plain", "scoped", "stored"]);
  });
});

test("a tree that is not there is an error, not an empty list", () => {
  withScratch({}, (root) => {
    assert.throws(() => packageDirsInTree(join(root, "nm")), /no node_modules folder at/);
  });
});

test("the image file lists the server build's packages and every copied tree", () => {
  const files = {
    ...SERVER,
    ...pkg("out/node_modules/runtime-dep", "runtime-dep", "MIT"),
    ...pkg("out/node_modules/sqlite-vec", "sqlite-vec", "MIT OR Apache", false),
    ...pkg("out/node_modules/sqlite-vec-linux-x64", "sqlite-vec-linux-x64", "MIT OR Apache", false),
    ...pkg("emb/node_modules/embedder-dep", "embedder-dep", "Apache-2.0"),
    ...pkg(
      "emb/node_modules/@img/sharp-libvips-linux-x64",
      "@img/sharp-libvips-linux-x64",
      "LGPL-3.0-or-later",
      false,
    ),
  };
  withScratch(files, (root) => {
    const result = write(root, ["out/node_modules", "emb/node_modules"]);
    assert.equal(result.packages, 6);
    const text = readFileSync(result.path, "utf8");
    assert.match(text, /^Licence notices for the reliquary-tc Docker image\n/);
    for (const expected of [
      "PROJECT NOTICE",
      "Third-party packages in this image (6)",
      "built-in@1.0.0 (MIT)",
      "runtime-dep@1.0.0 (MIT)",
      "TEXT OF embedder-dep",
      "sqlite-vec-linux-x64@1.0.0 (MIT OR Apache-2.0)",
      "BOTH SQLITE-VEC TEXTS",
      "@img/sharp-libvips-linux-x64@1.0.0 (LGPL-3.0-or-later)",
      "LIBVIPS NOTICE AND LGPL",
      "The base image",
      "Rust crates",
    ]) {
      assert.ok(text.includes(expected), `missing: ${expected}`);
    }
  });
});

test("a copied package with no licence text stops the build and leaves no file", () => {
  const files = { ...SERVER, ...pkg("out/node_modules/bare", "bare", "MIT", false) };
  withScratch(files, (root) => {
    const stale = join(root, "out", "THIRD-PARTY-LICENSES.txt");
    writeFileSync(stale, "STALE\n");
    assert.throws(() => write(root, ["out/node_modules"]), /bare@1\.0\.0 ships no licence text/);
    assert.equal(existsSync(stale), false);
  });
});

test("a copied package under a licence nobody accepted stops the build", () => {
  const files = { ...SERVER, ...pkg("out/node_modules/copyleft", "copyleft", "MPL-2.0") };
  withScratch(files, (root) => {
    assert.throws(() => write(root, ["out/node_modules"]), /"MPL-2\.0", which is not accepted/);
  });
});

test("the LGPL is accepted for the image only", () => {
  const files = pkg("node_modules/lib", "lib", "LGPL-3.0-or-later");
  withScratch(files, (root) => {
    const inputs = [join(root, "node_modules", "lib", "package.json")];
    const elsewhere = collectThirdParty({ inputs, baseDir: root });
    assert.match(elsewhere.problems.join("\n"), /"LGPL-3\.0-or-later", which is not accepted/);
    const allowed = collectThirdParty({
      inputs,
      baseDir: root,
      alsoAccepted: ["LGPL-3.0-or-later"],
    });
    assert.deepEqual(allowed.problems, []);
  });
});

test("the reviewed texts the image needs are in the repository", () => {
  const libvips = readFileSync(join(TEXTS, "sharp-libvips.txt"), "utf8");
  for (const expected of [
    "| libvips       | LGPLv3",
    "GNU LESSER GENERAL PUBLIC LICENSE",
    "GNU GENERAL PUBLIC LICENSE",
  ]) {
    assert.ok(libvips.includes(expected), `sharp-libvips.txt is missing: ${expected}`);
  }
  assert.match(readFileSync(join(TEXTS, "guid-typescript.txt"), "utf8"), /^ISC License$/m);
});

test("the Dockerfile drops development packages, then writes and copies the file", () => {
  const dockerfile = readFileSync(join(REPO, "Dockerfile"), "utf8");
  const prune = dockerfile.indexOf("bun install --frozen-lockfile --ignore-scripts --production");
  const generate = dockerfile.indexOf("bun scripts/write-image-license-file.mjs");
  const runtime = dockerfile.indexOf("AS runtime");
  assert.ok(prune !== -1, "the embedder is not reinstalled without development packages");
  assert.ok(generate > prune, "the file is written before the development packages are gone");
  assert.ok(runtime > generate, "the file is not written in the build stage");
  for (const tree of ["--tree /out/node_modules", "--tree packages/embedder-local/node_modules"]) {
    assert.ok(dockerfile.includes(tree), `the generator is not given ${tree}`);
  }
  assert.match(dockerfile, /COPY --from=build .*\/out\/THIRD-PARTY-LICENSES\.txt \/app\/\n/);
});

test("the image build in CI checks the file is in the image", () => {
  const yml = readFileSync(join(REPO, ".github", "workflows", "ci-docker.yml"), "utf8");
  assert.match(yml, /--entrypoint grep reliquary-tc:ci .* \/app\/THIRD-PARTY-LICENSES\.txt/);
  assert.ok(yml.includes('- "scripts/write-image-license-file.mjs"'));
});
