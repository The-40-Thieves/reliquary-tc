// The licence file for the Rust crates compiled into the native module
// (scripts/lib/crate-license-file.mjs), and the places that ship it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addLicenseToPlatformPackages,
  buildCrateLicenseText,
  crateLicenseProblem,
  linkedCrates,
  NATIVE_LICENSE_FILE,
} from "./lib/crate-license-file.mjs";

const REPO = join(import.meta.dirname, "..");
const NATIVE = join(REPO, "packages", "native");
const PROJECT = { name: "Project", license: "PROJECT LICENCE\n", notice: "PROJECT NOTICE\n" };

const LIB = [{ kind: ["lib"] }];
const MACRO = [{ kind: ["proc-macro"] }];
const NORMAL = [{ kind: null, target: null }];

/**
 * `cargo metadata` output for a made-up crate graph, with each crate's folder on disk under
 * `root`. A crate is `[name, license, targets, deps]`; a dep is `[name, dep_kinds]`.
 */
function metadataFor(root, crates) {
  const id = (name) => `registry#${name}@1.0.0`;
  const packages = crates.map(([name, license, targets]) => {
    mkdirSync(join(root, name), { recursive: true });
    return {
      id: id(name),
      name,
      version: "1.0.0",
      license,
      targets,
      manifest_path: join(root, name, "Cargo.toml"),
    };
  });
  const nodes = crates.map(([name, , , deps = []]) => ({
    id: id(name),
    deps: deps.map(([dep, dep_kinds]) => ({ pkg: id(dep), dep_kinds })),
  }));
  return { packages, resolve: { root: id(crates[0][0]), nodes } };
}

const withRoot = (run) => {
  const root = mkdtempSync(join(tmpdir(), "crate-licence-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const GRAPH = [
  [
    "module",
    "Apache-2.0",
    LIB,
    [
      ["direct", NORMAL],
      ["bench-only", [{ kind: "dev", target: null }]],
      ["build-only", [{ kind: "build", target: null }]],
      ["derive", NORMAL],
      ["unix-only", [{ kind: null, target: "cfg(unix)" }]],
    ],
  ],
  ["direct", "MIT OR Apache-2.0", LIB, [["indirect", NORMAL]]],
  ["indirect", "MIT", LIB],
  ["bench-only", "MPL-2.0", LIB],
  ["build-only", "MIT", LIB],
  ["derive", "MIT", MACRO, [["macro-helper", NORMAL]]],
  ["macro-helper", "MIT", LIB],
  ["unix-only", "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT", LIB],
];

test("only crates reached through ordinary dependencies are in the module", () => {
  withRoot((root) => {
    const names = linkedCrates(metadataFor(root, GRAPH)).map((pkg) => pkg.name);
    assert.deepEqual(names.sort(), ["direct", "indirect", "unix-only"]);
  });
});

test("a licence that offers an accepted choice passes, and nothing else does", () => {
  for (const ok of ["MIT", "Apache-2.0 OR MIT", "MIT/Apache-2.0", "Unlicense OR MIT"]) {
    assert.equal(crateLicenseProblem("c@1", ok), undefined, ok);
  }
  for (const bad of [
    "MPL-2.0",
    "GPL-3.0-only OR LGPL-3.0-only",
    "MIT AND MPL-2.0",
    "",
    undefined,
  ]) {
    assert.ok(crateLicenseProblem("c@1", bad), String(bad));
  }
});

test("the file carries each linked crate's own licence text", () => {
  withRoot((root) => {
    const metadata = metadataFor(root, GRAPH);
    for (const name of ["direct", "indirect", "unix-only", "bench-only"]) {
      writeFileSync(join(root, name, "LICENSE-MIT"), `TEXT OF ${name}\n`);
    }
    const text = buildCrateLicenseText({ metadata, overridesDir: root, project: PROJECT });
    assert.match(text, /^Licence notices for the reliquary-tc native module\n/);
    for (const expected of [
      "PROJECT NOTICE",
      "Rust crates compiled into the native module (3)",
      "direct@1.0.0 (MIT OR Apache-2.0)",
      "TEXT OF indirect",
      "TEXT OF unix-only",
      "Rust standard library",
    ]) {
      assert.ok(text.includes(expected), `missing: ${expected}`);
    }
    assert.ok(!text.includes("bench-only"), "a benchmark dependency is listed");
  });
});

test("a crate with no licence text, or an unaccepted licence, stops the file", () => {
  withRoot((root) => {
    const graph = [
      [
        "module",
        "Apache-2.0",
        LIB,
        [
          ["bare", NORMAL],
          ["copyleft", NORMAL],
        ],
      ],
      ["bare", "MIT", LIB],
      ["copyleft", "MPL-2.0", LIB],
    ];
    const metadata = metadataFor(root, graph);
    writeFileSync(join(root, "copyleft", "LICENSE"), "MPL\n");
    assert.throws(
      () => buildCrateLicenseText({ metadata, overridesDir: root, project: PROJECT }),
      (error) =>
        /bare@1\.0\.0 ships no licence text; add a reviewed copy as bare\.txt/.test(
          error.message,
        ) && /copyleft@1\.0\.0 is licensed "MPL-2\.0", which is not accepted/.test(error.message),
    );
  });
});

test("a crate that publishes no text takes the reviewed one filed for it", () => {
  withRoot((root) => {
    const metadata = metadataFor(root, [
      ["module", "Apache-2.0", LIB, [["napi", NORMAL]]],
      ["napi", "MIT", LIB],
    ]);
    writeFileSync(join(root, "napi-rs.txt"), "REVIEWED NAPI TEXT\n");
    const text = buildCrateLicenseText({ metadata, overridesDir: root, project: PROJECT });
    assert.ok(text.includes("REVIEWED NAPI TEXT"));
  });
});

test("the release step puts the file into every platform package and its files list", () => {
  withRoot((root) => {
    writeFileSync(join(root, NATIVE_LICENSE_FILE), "CRATE TEXTS\n");
    for (const triple of ["linux-x64-gnu", "win32-x64-msvc"]) {
      mkdirSync(join(root, "npm", triple), { recursive: true });
      writeFileSync(
        join(root, "npm", triple, "package.json"),
        JSON.stringify({ name: `native-${triple}`, files: [`native.${triple}.node`] }),
      );
    }
    const names = addLicenseToPlatformPackages(root);
    assert.deepEqual(names.sort(), ["native-linux-x64-gnu", "native-win32-x64-msvc"]);
    const dir = join(root, "npm", "linux-x64-gnu");
    assert.equal(readFileSync(join(dir, NATIVE_LICENSE_FILE), "utf8"), "CRATE TEXTS\n");
    const { files } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.deepEqual(files, ["native.linux-x64-gnu.node", NATIVE_LICENSE_FILE]);
    // A second run changes nothing.
    addLicenseToPlatformPackages(root);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).files, files);
  });
});

test("the release step refuses to run with no platform package or no file", () => {
  withRoot((root) => {
    assert.throws(() => addLicenseToPlatformPackages(root), /does not exist/);
    writeFileSync(join(root, NATIVE_LICENSE_FILE), "CRATE TEXTS\n");
    assert.throws(() => addLicenseToPlatformPackages(root), /no package folder under/);
  });
});

test("every crate the committed file names is at that version in Cargo.lock", () => {
  const file = join(NATIVE, NATIVE_LICENSE_FILE);
  assert.ok(existsSync(file), "packages/native/THIRD-PARTY-LICENSES.txt is not committed");
  const text = readFileSync(file, "utf8");
  const list = text.split(/^Rust crates compiled into the native module \(\d+\)\n=+\n\n/m)[1];
  const named = list.split("\n\n")[0].split("\n");
  assert.ok(named.length >= 10, `only ${named.length} crates listed`);
  const lock = readFileSync(join(NATIVE, "Cargo.lock"), "utf8").replaceAll("\r\n", "\n");
  for (const line of named) {
    const [, name, version] = /^(\S+)@(\S+) \(/.exec(line);
    assert.ok(
      lock.includes(`name = "${name}"\nversion = "${version}"\n`),
      `${name}@${version} is not in Cargo.lock; run bun scripts/write-native-license-file.mjs`,
    );
  }
});

test("the npm packages, the image and CI all carry or check the file", () => {
  const read = (...path) => readFileSync(join(REPO, ...path), "utf8");
  assert.ok(
    JSON.parse(read("packages", "native", "package.json")).files.includes(NATIVE_LICENSE_FILE),
  );
  const publish = read(".github", "workflows", "publish.yml");
  const add = publish.indexOf("node scripts/add-native-license-to-platform-packages.mjs");
  assert.ok(add !== -1, "publish.yml does not add the file to the platform packages");
  assert.ok(
    add < publish.indexOf("napi pre-publish -t npm"),
    "added after the packages are published",
  );
  assert.ok(
    add > publish.indexOf("napi create-npm-dirs"),
    "added before the package folders exist",
  );
  assert.match(read("Dockerfile"), /packages\/native\/THIRD-PARTY-LICENSES\.txt "\$dest\/"/);
  assert.ok(
    read(".github", "workflows", "ci-native.yml").includes(
      "node scripts/write-native-license-file.mjs --check",
    ),
  );
  assert.ok(
    read(".github", "workflows", "ci-docker.yml").includes("reliquary-tc-native/THIRD-PARTY"),
  );
});
