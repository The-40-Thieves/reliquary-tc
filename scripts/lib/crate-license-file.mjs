// The licence file for the Rust crates compiled into the native module.
//
// The module is one compiled library, so the crates inside it leave no trace a user can read. The
// list comes from `cargo metadata`, which resolves Cargo.lock: starting at the module's own crate
// and following ordinary dependencies only. Build scripts, test and benchmark dependencies and
// procedural macros run at build time and are not in the library, so they are left out. No
// platform is selected: the file covers every target the module is built for, and one platform's
// build holds a subset.
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ACCEPTED_LICENSES,
  licenseTextsIn,
  overrideFileName,
  readOverride,
  renderLicenseFile,
} from "./third-party-licenses.mjs";

export const NATIVE_LICENSE_FILE = "THIRD-PARTY-LICENSES.txt";

/**
 * Put the module's licence file into every per-platform package folder under `<nativeDir>/npm`
 * and list it in that package's `files`, so the package that carries the compiled module carries
 * the texts too. Returns the package names. No folder, or no licence file, is an error.
 */
export function addLicenseToPlatformPackages(nativeDir) {
  const source = join(nativeDir, NATIVE_LICENSE_FILE);
  if (!existsSync(source)) throw new Error(`platform packages: ${source} does not exist`);
  const root = join(nativeDir, "npm");
  const dirs = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  if (dirs.length === 0) throw new Error(`platform packages: no package folder under ${root}`);
  return dirs.map((entry) => {
    const dir = join(root, entry.name);
    const manifestPath = join(dir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files = [...new Set([...(manifest.files ?? []), NATIVE_LICENSE_FILE])];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    copyFileSync(source, join(dir, NATIVE_LICENSE_FILE));
    return manifest.name;
  });
}

/** Crates that publish no licence file, by the reviewed text that covers them. */
export const CRATE_ALIASES = { napi: "napi-rs", "napi-sys": "napi-rs" };

const SUBJECT = {
  intro: "the Rust crates compiled into this package's native module",
  list: "Rust crates compiled into the native module",
};
const STD_NOTE =
  "The Rust standard library, which every build links (MIT OR Apache-2.0): " +
  "https://github.com/rust-lang/rust/blob/master/COPYRIGHT.";
const PLATFORM_NOTE =
  "Nothing is left out per platform: the list covers every target the module is built for, so " +
  "one platform's build contains only some of these crates.";

const isLinked = (dep) => dep.dep_kinds.some((kind) => kind.kind === null);
const isMacro = (pkg) => pkg.targets.every((target) => target.kind.includes("proc-macro"));

/**
 * The crates compiled into the module, from `cargo metadata --format-version 1` output: every
 * crate reached from the root through ordinary dependencies, without the root itself.
 */
export function linkedCrates(metadata) {
  const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const root = metadata.resolve.root;
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const dep of nodes.get(queue.pop()).deps) {
      if (seen.has(dep.pkg) || !isLinked(dep) || isMacro(byId.get(dep.pkg))) continue;
      seen.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
  seen.delete(root);
  return [...seen].map((id) => byId.get(id));
}

/**
 * A crate's licence is acceptable when it is on the accepted list, or offers a choice (`A OR B`,
 * or the older `A/B`) and one of the choices is. Nothing else is read out of the expression.
 */
export function crateLicenseProblem(id, license) {
  if (typeof license !== "string" || license.trim() === "") return `${id} declares no licence`;
  const choices = [license, ...license.replaceAll("/", " OR ").split(" OR ")];
  if (choices.some((choice) => ACCEPTED_LICENSES.has(choice.trim()))) return undefined;
  return `${id} is licensed "${license}", which is not accepted (scripts/lib/third-party-licenses.mjs)`;
}

function readCrate(pkg, overridesDir, problems) {
  const id = `${pkg.name}@${pkg.version}`;
  const texts = licenseTextsIn(dirname(pkg.manifest_path));
  const key = CRATE_ALIASES[pkg.name] ?? pkg.name;
  const override = readOverride(overridesDir, key);
  if (texts.length > 0 && override && key === pkg.name) {
    problems.push(`${id} ships its own licence text; remove the override ${override.file}`);
  }
  if (texts.length === 0 && override) texts.push(override);
  if (texts.length === 0) {
    problems.push(
      `${id} ships no licence text; add a reviewed copy as ${overrideFileName(key)} in the overrides folder`,
    );
  }
  const bad = crateLicenseProblem(id, pkg.license);
  if (bad) problems.push(bad);
  return { name: pkg.name, version: pkg.version, license: pkg.license, texts };
}

/**
 * The licence file's text for the native module, or an Error listing every problem. `metadata` is
 * parsed `cargo metadata` output with the crate sources on disk; `project` is `{ name, license,
 * notice }`.
 */
export function buildCrateLicenseText({ metadata, overridesDir, project }) {
  const problems = [];
  const packages = linkedCrates(metadata)
    .map((pkg) => readCrate(pkg, overridesDir, problems))
    .sort((a, b) => (`${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1));
  if (packages.length === 0) problems.push("cargo metadata lists no crate under the module");
  if (problems.length > 0) {
    throw new Error(
      `cannot write the licence file for the native module:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return renderLicenseFile({
    artifact: "the reliquary-tc native module",
    project,
    packages,
    notes: [STD_NOTE, PLATFORM_NOTE],
    subject: SUBJECT,
  });
}
