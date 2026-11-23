// What a standalone binary embeds beyond its module graph, and the licence file written beside it.
//
// scripts/build-binary.ts hands over the bundler's input list; scripts/lib/third-party-licenses.mjs
// turns it into packages. Two things never appear in that list because they are baked in as bytes
// by earlier steps (scripts/gen-embedded-vec.mjs, scripts/gen-embedded-sqlite.mjs), so they are
// read back from the generated modules those steps wrote: empty in source control, non-empty only
// in a build that embedded something.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SQLITE_VEC_TARGETS } from "./sqlite-vec-targets.mjs";
import { buildLicenseFile } from "./third-party-licenses.mjs";

/** Reviewed licence texts for the packages that publish none (see that folder's README). */
export const OVERRIDES_DIR = join(import.meta.dirname, "..", "third-party-license-texts");

/** Packages that share one reviewed text: ONNX Runtime publishes three packages and one licence. */
export const OVERRIDE_ALIASES = {
  "onnxruntime-common": "onnxruntime",
  "onnxruntime-node": "onnxruntime",
  "onnxruntime-web": "onnxruntime",
};

const ORT_NOTE =
  "The libraries compiled into ONNX Runtime's native and WebAssembly builds. Its notices for " +
  "them are at https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt.";
const BUN_NOTE =
  "The Bun runtime this executable is built on, and the libraries compiled into Bun. Their " +
  "licences are listed at https://bun.sh/docs/project/licensing.";
const SQLITE_NOTE =
  "SQLite, embedded as a library on macOS, is in the public domain: " +
  "https://www.sqlite.org/copyright.html.";

const embeds = (file, constant) =>
  !readFileSync(file, "utf8").includes(`export const ${constant} = "";`);

/**
 * The extras and notes for one target: the sqlite-vec platform library when this build embedded
 * one, the SQLite note when this build embedded SQLite, and the runtime note always.
 */
export function embeddedParts({ target, serverDir }) {
  const extras = [];
  const notes = [BUN_NOTE];
  if (embeds(join(serverDir, "src", "search", "vec-embedded.ts"), "EMBEDDED_VEC_BASE64")) {
    const entry = SQLITE_VEC_TARGETS[target];
    if (!entry)
      throw new Error(`binary-license-file: sqlite-vec is embedded for unknown ${target}`);
    const manifest = join(serverDir, "node_modules", "sqlite-vec", "package.json");
    extras.push({
      name: entry.pkg,
      version: JSON.parse(readFileSync(manifest, "utf8")).version,
      // sqlite-vec's manifest says "MIT OR Apache"; its repository carries both licence files.
      license: "MIT OR Apache-2.0",
      override: "sqlite-vec",
    });
  }
  if (embeds(join(serverDir, "src", "db", "sqlite-embedded.ts"), "EMBEDDED_SQLITE_BASE64")) {
    notes.push(SQLITE_NOTE);
  }
  return { extras, notes };
}

/** `<outfile>-licenses.txt`: named for the target, so the windows file carries no `.exe`. */
export const licenseFilePath = (outfile) => `${outfile}-licenses.txt`;

/**
 * Write the licence file for the binary at `outfile`. `inputs` are the build metafile's input
 * paths, relative to `cwd`. Throws, writing nothing, when the list cannot be completed.
 */
export function writeBinaryLicenseFile({ target, outfile, inputs, cwd, repoRoot }) {
  const { extras, notes } = embeddedParts({
    target,
    serverDir: join(repoRoot, "packages", "server"),
  });
  if (inputs.some((i) => /[\\/]node_modules[\\/]onnxruntime-/.test(i))) notes.push(ORT_NOTE);
  const text = buildLicenseFile({
    artifact: basename(outfile),
    inputs,
    baseDir: cwd,
    overridesDir: OVERRIDES_DIR,
    overrideAliases: OVERRIDE_ALIASES,
    extras,
    notes,
    project: {
      name: "Reliquary-TC",
      license: readFileSync(join(repoRoot, "LICENSE"), "utf8"),
      notice: readFileSync(join(repoRoot, "NOTICE"), "utf8"),
    },
  });
  const path = licenseFilePath(outfile);
  writeFileSync(path, text);
  return path;
}
