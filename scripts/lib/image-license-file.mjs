// The licence file at the root of the Docker image.
//
// The image holds more than the server build: a node_modules folder beside it with the packages
// the build resolves at run time, and the local embedder with the packages it runs on. Those are
// copied in as folders, so the list is read from the folders themselves: every package directory
// in each tree, however it got there. The server build's own list (its source maps) is added so
// one file covers the image.
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ORT_NOTE, OVERRIDE_ALIASES, OVERRIDES_DIR } from "./binary-license-file.mjs";
import { sourceMapInputs } from "./server-dist-license-file.mjs";
import { buildLicenseFile, collectThirdParty } from "./third-party-licenses.mjs";

/** The project's own packages are covered by its LICENSE and NOTICE, not listed as third-party. */
const OWN_SCOPE = "@the-40-thieves/";

/**
 * Accepted for the image alone: sharp's prebuilt libvips, a shared library the image carries as a
 * separate file. A binary or bundle that pulled it in would still fail.
 */
const IMAGE_ONLY_LICENSES = ["LGPL-3.0-or-later"];

// One reviewed text covers every platform's prebuilt libvips package.
const IMAGE_ALIASES = {
  ...OVERRIDE_ALIASES,
  "@img/sharp-libvips-linux-arm64": "sharp-libvips",
  "@img/sharp-libvips-linux-x64": "sharp-libvips",
  "@img/sharp-libvips-linuxmusl-arm64": "sharp-libvips",
  "@img/sharp-libvips-linuxmusl-x64": "sharp-libvips",
};

const SUBJECT = {
  intro: "the third-party packages in the image this file is part of",
  list: "Third-party packages in this image",
};
const BASE_NOTE =
  "The base image: the Bun runtime (https://bun.sh/docs/project/licensing) and the Debian " +
  "packages under it, whose notices are in /usr/share/doc/*/copyright in the image.";
const NATIVE_NOTE =
  "The Rust crates compiled into the project's native module. Their texts are in " +
  "THIRD-PARTY-LICENSES.txt beside it (packages/server/node_modules/@the-40-thieves/" +
  "reliquary-tc-native).";
const LIBVIPS_NOTE =
  "The licence texts of the libraries inside the prebuilt libvips that are not under the LGPL. " +
  "Its notice above names each one and where its terms are.";

const isDir = (path) => existsSync(path) && statSync(path).isDirectory();
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

function visitPackage(dir, found, seen) {
  if (!isDir(dir)) return;
  const real = realpathSync(dir);
  if (seen.has(real)) return;
  seen.add(real);
  found.push(dir);
  walkModules(join(dir, "node_modules"), found, seen);
}

function walkStore(store, found, seen) {
  for (const entry of readdirSync(store).sort()) {
    walkModules(join(store, entry, "node_modules"), found, seen);
  }
}

function walkScope(scope, found, seen) {
  for (const entry of readdirSync(scope).sort()) visitPackage(join(scope, entry), found, seen);
}

function walkModules(modules, found, seen) {
  if (!isDir(modules)) return;
  for (const entry of readdirSync(modules).sort()) {
    const path = join(modules, entry);
    // Bun's isolated installs keep every package under .bun/<name>@<version>/node_modules.
    if (entry === ".bun") walkStore(path, found, seen);
    else if (entry.startsWith(".") || !isDir(path)) continue;
    else if (entry.startsWith("@")) walkScope(path, found, seen);
    else visitPackage(path, found, seen);
  }
}

const isOwn = (dir) =>
  existsSync(join(dir, "package.json")) && String(manifestOf(dir).name).startsWith(OWN_SCOPE);

/**
 * Every third-party package directory in a node_modules folder: nested folders and Bun's store
 * included, each real directory once, the project's own packages left out. A missing folder is an
 * error, because the image copies it and an empty list would pass for a complete one.
 */
export function packageDirsInTree(modules) {
  if (!isDir(modules)) throw new Error(`licence list: no node_modules folder at ${modules}`);
  const found = [];
  walkModules(modules, found, new Set());
  return found.filter((dir) => !isOwn(dir));
}

// sqlite-vec's manifests say "MIT OR Apache" and its packages ship no text; its repository
// carries both licence files, which the reviewed copy reproduces.
const isSqliteVec = (dir) =>
  existsSync(join(dir, "package.json")) && /^sqlite-vec(?:-|$)/.test(manifestOf(dir).name);

function sqliteVecExtra(dir) {
  const { name, version } = manifestOf(dir);
  return { name, version, license: "MIT OR Apache-2.0", override: "sqlite-vec" };
}

const IMAGE_LICENSE_FILE = "THIRD-PARTY-LICENSES.txt";

/**
 * The path this script may remove and write: a file of the one fixed name, in the folder the
 * caller named. The caller's path comes from the command line, so it never picks the file name,
 * and something of that name that is not a regular file (a folder, a link) is left alone.
 */
function licenseFileAt(requested) {
  const asked = resolve(requested);
  const path = join(dirname(asked), IMAGE_LICENSE_FILE);
  if (path !== asked)
    throw new Error(`licence list: the output must be named ${IMAGE_LICENSE_FILE}, got ${asked}`);
  if (lstatSync(path, { throwIfNoEntry: false })?.isFile() === false)
    throw new Error(`licence list: ${path} exists and is not a regular file`);
  return path;
}

/**
 * Write the image's licence file to `outFile` and return `{ path, packages }`. `trees` are the
 * node_modules folders the image copies; `serverDist` is the built server. Throws when the list
 * cannot be completed, and then leaves no file behind.
 */
export function writeImageLicenseFile({
  outFile,
  trees,
  serverDist,
  repoRoot,
  overridesDir = OVERRIDES_DIR,
}) {
  const path = licenseFileAt(outFile);
  rmSync(path, { force: true });
  const dirs = trees.flatMap(packageDirsInTree);
  const source = {
    inputs: [
      ...sourceMapInputs(serverDist),
      ...dirs.filter((dir) => !isSqliteVec(dir)).map((dir) => join(dir, "package.json")),
    ],
    baseDir: repoRoot,
    overridesDir,
    overrideAliases: IMAGE_ALIASES,
    extras: dirs.filter(isSqliteVec).map(sqliteVecExtra),
    alsoAccepted: IMAGE_ONLY_LICENSES,
  };
  const text = buildLicenseFile({
    ...source,
    artifact: "the reliquary-tc Docker image",
    notes: [BASE_NOTE, NATIVE_NOTE, ORT_NOTE, LIBVIPS_NOTE],
    subject: SUBJECT,
    project: {
      name: "Reliquary-TC",
      license: readFileSync(join(repoRoot, "LICENSE"), "utf8"),
      notice: readFileSync(join(repoRoot, "NOTICE"), "utf8"),
    },
  });
  writeFileSync(path, text);
  return { path, packages: collectThirdParty(source).packages.length };
}
