// The licence file packed at the root of the MCPB bundle, and the check that it was packed.
//
// One bundle runs on every platform, so it carries more than a binary does: the server's two built
// bundles with their JavaScript dependencies inlined, the local embedder as one bundled file, the
// sqlite-vec loader and every platform's library, and ONNX Runtime's native and WebAssembly files.
// The package list comes from what was built, not from the lockfile:
//
//   server      the `sources` of each built bundle's source map, written beside it by the same
//               build, so the list describes exactly the file that ships (the packer leaves
//               the maps themselves out of the bundle);
//   embedder    the input list of the build scripts/bundle-mcpb.ts runs;
//   copied in   sqlite-vec and ONNX Runtime, named by the caller because they are files, not
//               modules of either build.
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ORT_NOTE, OVERRIDE_ALIASES, OVERRIDES_DIR } from "./binary-license-file.mjs";
import { buildLicenseFile } from "./third-party-licenses.mjs";

export const MCPB_LICENSE_FILE = "THIRD-PARTY-LICENSES.txt";

const SUBJECT = {
  intro: "the third-party software in the bundle this file is part of",
  list: "Third-party packages in this bundle",
};

/**
 * Every source of every built bundle directly in `distDir`, as absolute paths. A bundle with no
 * source map, or a map with no sources, is an error: the list would silently come up short.
 */
export function sourceMapInputs(distDir) {
  const bundles = readdirSync(distDir)
    .filter((name) => name.endsWith(".js"))
    .sort();
  if (bundles.length === 0) throw new Error(`mcpb-license-file: no built .js in ${distDir}`);
  const inputs = [];
  for (const name of bundles) {
    const map = join(distDir, `${name}.map`);
    if (!existsSync(map)) {
      throw new Error(
        `mcpb-license-file: ${name} has no source map; the licence list is read from ${name}.map`,
      );
    }
    const { sources } = JSON.parse(readFileSync(map, "utf8"));
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error(`mcpb-license-file: ${name}.map lists no sources`);
    }
    for (const source of sources) inputs.push(resolve(distDir, source));
  }
  return inputs;
}

const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/** The packages copied into the bundle as files: `{ name, version, license, override }` each. */
function copiedIn({ sqliteVec, ortDirs }) {
  const vec = [sqliteVec.dir, ...sqliteVec.platformPackages.map((p) => p.dir)].map((dir) => {
    const { name, version } = manifestOf(dir);
    // sqlite-vec's manifests say "MIT OR Apache"; its repository carries both licence files.
    return { name, version, license: "MIT OR Apache-2.0", override: "sqlite-vec" };
  });
  const ort = ortDirs.map((dir) => {
    const { name, version, license } = manifestOf(dir);
    return { name, version, license, override: OVERRIDE_ALIASES[name] ?? name };
  });
  return [...vec, ...ort];
}

/**
 * The licence file's text for the bundle. `embedderInputs` are the embedder build's input paths,
 * relative to `embedderBaseDir`; `sqliteVec` is `{ dir, platformPackages: [{ dir }] }` and
 * `ortDirs` the ONNX Runtime package folders whose files are copied in. Throws when the list
 * cannot be completed.
 */
export function buildMcpbLicenseText({
  repoRoot,
  artifact,
  serverDist,
  embedderInputs,
  embedderBaseDir,
  sqliteVec,
  ortDirs,
  overridesDir = OVERRIDES_DIR,
}) {
  return buildLicenseFile({
    artifact,
    inputs: [
      ...sourceMapInputs(serverDist),
      ...embedderInputs.map((input) => resolve(embedderBaseDir, input)),
    ],
    baseDir: repoRoot,
    overridesDir,
    overrideAliases: OVERRIDE_ALIASES,
    extras: copiedIn({ sqliteVec, ortDirs }),
    notes: [ORT_NOTE],
    subject: SUBJECT,
    project: {
      name: "Reliquary-TC",
      license: readFileSync(join(repoRoot, "LICENSE"), "utf8"),
      notice: readFileSync(join(repoRoot, "NOTICE"), "utf8"),
    },
  });
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
// The end record is 22 bytes plus a comment of at most 65535.
const END_SEARCH = 22 + 0xffff;

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  readSync(fd, buffer, 0, length, position);
  return buffer;
}

function findEndRecord(tail) {
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tail.readUInt32LE(at) === END_OF_DIRECTORY) return at;
  }
  return -1;
}

/**
 * The entry names of a zip archive (an .mcpb is one), read from its central directory without
 * loading the archive. Zip64 archives are refused, not misread.
 */
export function listZipEntries(file) {
  const fd = openSync(file, "r");
  try {
    const { size } = fstatSync(fd);
    const tail = readAt(fd, Math.max(0, size - END_SEARCH), Math.min(size, END_SEARCH));
    const end = findEndRecord(tail);
    if (end === -1) throw new Error(`mcpb-license-file: no zip directory in ${file}`);
    const count = tail.readUInt16LE(end + 10);
    const offset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || offset === 0xffffffff) {
      throw new Error(`mcpb-license-file: ${file} is a zip64 archive, which is not supported`);
    }
    const directory = readAt(fd, offset, tail.readUInt32LE(end + 12));
    const names = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (directory.readUInt32LE(at) !== DIRECTORY_ENTRY) {
        throw new Error(`mcpb-license-file: damaged zip directory in ${file}`);
      }
      const nameLength = directory.readUInt16LE(at + 28);
      names.push(directory.toString("utf8", at + 46, at + 46 + nameLength));
      at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    }
    return names;
  } finally {
    closeSync(fd);
  }
}

/** Throws unless the packed bundle's root holds the project's LICENSE, NOTICE and the licence file. */
export function assertLicenceFilesPacked(entryNames) {
  const names = new Set(entryNames);
  const missing = ["LICENSE", "NOTICE", MCPB_LICENSE_FILE].filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`the packed bundle is missing ${missing.join(", ")} at its root`);
  }
}
