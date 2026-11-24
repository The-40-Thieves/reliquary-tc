#!/usr/bin/env node
// Write packages/native/THIRD-PARTY-LICENSES.txt: the licence texts of the Rust crates compiled
// into the native module. The file is committed, because the places that ship the module (the npm
// packages, the Docker image) have no Rust toolchain to make it with. It changes only when the
// module's dependencies do.
//
//   bun scripts/write-native-license-file.mjs           write the file
//   bun scripts/write-native-license-file.mjs --check   fail if the committed file is out of date
//
// Needs cargo, and the network the first time (cargo fetches the crate sources it reads).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OVERRIDES_DIR } from "./lib/binary-license-file.mjs";
import { buildCrateLicenseText } from "./lib/crate-license-file.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const nativeDir = join(repoRoot, "packages", "native");
const outFile = join(nativeDir, "THIRD-PARTY-LICENSES.txt");
const REGENERATE = "bun scripts/write-native-license-file.mjs";

function expectedText() {
  const metadata = execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    cwd: nativeDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return buildCrateLicenseText({
    metadata: JSON.parse(metadata),
    overridesDir: OVERRIDES_DIR,
    project: {
      name: "Reliquary-TC",
      license: readFileSync(join(nativeDir, "LICENSE"), "utf8"),
      notice: readFileSync(join(nativeDir, "NOTICE"), "utf8"),
    },
  });
}

try {
  const text = expectedText();
  if (process.argv.includes("--check")) {
    const current = existsSync(outFile)
      ? readFileSync(outFile, "utf8").replaceAll("\r\n", "\n")
      : "";
    if (current !== text) {
      console.error(`packages/native/THIRD-PARTY-LICENSES.txt is out of date. Run: ${REGENERATE}`);
      process.exit(1);
    }
    console.log("packages/native/THIRD-PARTY-LICENSES.txt is current");
  } else {
    writeFileSync(outFile, text);
    console.log(`wrote ${outFile}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
