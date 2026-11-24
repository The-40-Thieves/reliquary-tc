#!/usr/bin/env node
// Write the Docker image's licence file. Run by the Dockerfile's build stage, from the repository
// root, once everything the runtime stage copies is in place:
//
//   bun scripts/write-image-license-file.mjs --out <file> --tree <node_modules> [--tree ...]
//
// Each --tree is a node_modules folder the image copies. Exits non-zero, writing nothing, when a
// package in one of them has no licence text or a licence that is not on the accepted list.
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { writeImageLicenseFile } from "./lib/image-license-file.mjs";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    tree: { type: "string", multiple: true },
  },
});
if (!values.out || !values.tree?.length) {
  console.error(
    "usage: write-image-license-file.mjs --out <file> --tree <node_modules> [--tree ...]",
  );
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "..");
try {
  const { path, packages } = writeImageLicenseFile({
    outFile: resolve(values.out),
    trees: values.tree.map((tree) => resolve(tree)),
    serverDist: join(repoRoot, "packages", "server", "dist"),
    repoRoot,
  });
  console.log(`wrote ${packages} third-party licences -> ${path}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
