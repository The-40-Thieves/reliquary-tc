#!/usr/bin/env node
// Print the Docker image's licence file. Run by the Dockerfile's build stage, from the repository
// root, once everything the runtime stage copies is in place:
//
//   bun scripts/write-image-license-file.mjs --tree <node_modules> [--tree ...] > <file>
//
// Each --tree is a node_modules folder the image copies. The text goes to standard output and the
// caller redirects it, so this script names no file to write. Exits non-zero, printing no text,
// when a package in one of the trees has no licence text or a licence that is not on the accepted
// list.
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildImageLicenseFile } from "./lib/image-license-file.mjs";

const { values } = parseArgs({
  options: {
    tree: { type: "string", multiple: true },
  },
});
if (!values.tree?.length) {
  console.error("usage: write-image-license-file.mjs --tree <node_modules> [--tree ...] > <file>");
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "..");
try {
  const { text, packages } = buildImageLicenseFile({
    trees: values.tree.map((tree) => resolve(tree)),
    serverDist: join(repoRoot, "packages", "server", "dist"),
    repoRoot,
  });
  process.stdout.write(text);
  console.error(`listed ${packages} third-party licences`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
