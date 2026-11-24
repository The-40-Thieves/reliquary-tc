#!/usr/bin/env node
// Release step: copy packages/native/THIRD-PARTY-LICENSES.txt into each per-platform package
// folder `napi create-npm-dirs` made, and list it in that package's `files`. Run from the
// repository root after the folders exist and before they are published.
import { join, resolve } from "node:path";
import { addLicenseToPlatformPackages } from "./lib/crate-license-file.mjs";

try {
  const nativeDir = join(resolve(import.meta.dirname, ".."), "packages", "native");
  for (const name of addLicenseToPlatformPackages(nativeDir)) {
    console.log(`licence file -> ${name}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
