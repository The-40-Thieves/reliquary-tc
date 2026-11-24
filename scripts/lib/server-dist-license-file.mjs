// The licence file the server build writes into packages/server/dist.
//
// dist/cli.js and dist/index.js have their JavaScript dependencies built in, and dist is what the
// npm package and the Docker image ship, so a file written here travels with both. The package
// list is the `sources` of the source map the build writes beside each bundle: the map comes from
// the same build step as the file, so it describes exactly what was built in.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OVERRIDE_ALIASES, OVERRIDES_DIR } from "./binary-license-file.mjs";
import { buildLicenseFile, collectThirdParty } from "./third-party-licenses.mjs";

export const DIST_LICENSE_FILE = "THIRD-PARTY-LICENSES.txt";

const SUBJECT = {
  intro: "the third-party software built into the .js files beside this one",
  list: "Third-party packages built into these files",
};
const INSTALLED_NOTE =
  "The packages a package manager installs beside this build (sqlite-vec, the optional local " +
  "embedder and others). They are not built into these files and carry their own licences.";

/**
 * Every source of every built bundle directly in `distDir`, as absolute paths. A bundle with no
 * source map, or a map with no sources, is an error: the list would silently come up short.
 */
export function sourceMapInputs(distDir) {
  const bundles = readdirSync(distDir)
    .filter((name) => name.endsWith(".js"))
    .sort();
  if (bundles.length === 0) throw new Error(`licence list: no built .js in ${distDir}`);
  const inputs = [];
  for (const name of bundles) {
    const map = join(distDir, `${name}.map`);
    if (!existsSync(map)) {
      throw new Error(`licence list: ${name} has no source map; the list is read from ${name}.map`);
    }
    const { sources } = JSON.parse(readFileSync(map, "utf8"));
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error(`licence list: ${name}.map lists no sources`);
    }
    for (const source of sources) inputs.push(resolve(distDir, source));
  }
  return inputs;
}

/**
 * Write `<distDir>/THIRD-PARTY-LICENSES.txt` and return `{ path, packages }`. Throws when the list
 * cannot be completed, and then leaves no file behind, not even one from an earlier build.
 */
export function writeServerDistLicenseFile({ distDir, repoRoot, overridesDir = OVERRIDES_DIR }) {
  const path = join(distDir, DIST_LICENSE_FILE);
  rmSync(path, { force: true });
  const source = {
    inputs: sourceMapInputs(distDir),
    baseDir: repoRoot,
    overridesDir,
    overrideAliases: OVERRIDE_ALIASES,
  };
  const text = buildLicenseFile({
    ...source,
    artifact: "the reliquary-tc server build",
    notes: [INSTALLED_NOTE],
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
