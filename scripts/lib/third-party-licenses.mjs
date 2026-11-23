// Build the licence file that ships beside a standalone binary.
//
// A compiled binary carries its dependencies inside one executable, so nothing a user downloads
// holds their licence texts. The list of what went in comes from the bundler itself: the build's
// metafile names every source file it bundled, and each one under node_modules maps to the package
// it belongs to. That makes the list exact per target (a stubbed or tree-shaken package is absent,
// a platform package is present only where it was bundled) with no lockfile walk and no guess about
// which optional packages another operating system would have installed.
//
// It refuses rather than degrades: a package with no licence text, an unstated or unaccepted
// licence, or a build with no third-party package at all is an error, never a shorter file.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Licence expressions a bundled package may declare, exactly as written in its package.json. A new
 * expression is a decision for a person, so an unknown one fails the build instead of passing.
 */
export const ACCEPTED_LICENSES = new Set([
  "(MIT OR CC0-1.0)",
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MIT OR Apache-2.0",
]);

// Files in a package root that carry its licence terms or the notices its licence asks to be kept.
const TEXT_FILE = /^(?:licen[sc]e|copying|notice|third[-_ ]?party[-_ ]?notices)/i;
const MARKER = "/node_modules/";

/** Reviewed texts for packages that publish none: one `<name>.txt` each, `/` written as `__`. */
export function overrideFileName(name) {
  return `${name.replaceAll("/", "__")}.txt`;
}

const lf = (text) => text.replaceAll("\r\n", "\n");

/**
 * The package directory of every input under a node_modules folder, absolute and sorted. An input
 * elsewhere is the project's own source (or a bundler-internal path) and is not a package.
 */
export function packageDirsFromInputs(inputs, baseDir) {
  const dirs = new Set();
  for (const input of inputs) {
    const abs = (isAbsolute(input) ? input : resolve(baseDir, input)).split(sep).join("/");
    const at = abs.lastIndexOf(MARKER);
    if (at === -1) continue;
    const parts = abs.slice(at + MARKER.length).split("/");
    const name = parts[0].startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
    dirs.add(resolve(abs.slice(0, at + MARKER.length), ...name));
  }
  return [...dirs].sort();
}

function readOverride(overridesDir, key) {
  if (!overridesDir) return undefined;
  const file = overrideFileName(key);
  const path = join(overridesDir, file);
  return existsSync(path) ? { file, text: lf(readFileSync(path, "utf8")) } : undefined;
}

function licenseProblem(id, license, alsoAccepted) {
  if (typeof license !== "string" || license.trim() === "") return `${id} declares no licence`;
  if (ACCEPTED_LICENSES.has(license) || alsoAccepted.includes(license)) return undefined;
  return `${id} is licensed "${license}", which is not accepted (scripts/lib/third-party-licenses.mjs)`;
}

function readPackage(dir, { overridesDir, overrideAliases, alsoAccepted }, problems) {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) {
    problems.push(`${dir.split(sep).join("/")} has no package.json`);
    return undefined;
  }
  const { name, version, license } = JSON.parse(readFileSync(manifest, "utf8"));
  const id = `${name}@${version}`;
  const texts = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && TEXT_FILE.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((file) => ({ file, text: lf(readFileSync(join(dir, file), "utf8")) }));
  const key = overrideAliases[name] ?? name;
  const override = readOverride(overridesDir, key);
  if (texts.length > 0 && override) {
    problems.push(`${id} ships its own licence text; remove the override ${override.file}`);
  }
  if (texts.length === 0 && override) texts.push(override);
  if (texts.length === 0) {
    problems.push(
      `${id} ships no licence text; add a reviewed copy as ${overrideFileName(key)} in the overrides folder`,
    );
  }
  const bad = licenseProblem(id, license, alsoAccepted);
  if (bad) problems.push(bad);
  return { name, version, license, texts };
}

/**
 * Collect every third-party package in a build. `extras` lists what is embedded without being a
 * module in the graph (a native library baked in as bytes): `{ name, version, license, override }`,
 * where `override` names the reviewed text to use. `overrideAliases` maps a package name to the
 * override that covers it, for one text shared by several packages. `alsoAccepted` lists licence
 * expressions accepted for this artifact alone, beyond ACCEPTED_LICENSES. Returns the packages
 * sorted by name and every problem found; an empty `problems` is the only state in which the list
 * may ship.
 */
export function collectThirdParty({
  inputs,
  baseDir,
  overridesDir,
  overrideAliases = {},
  extras = [],
  alsoAccepted = [],
}) {
  const problems = [];
  const packages = [];
  for (const dir of packageDirsFromInputs(inputs, baseDir)) {
    const found = readPackage(dir, { overridesDir, overrideAliases, alsoAccepted }, problems);
    if (found) packages.push(found);
  }
  if (packages.length === 0 && problems.length === 0) {
    problems.push("no third-party package was found in the build's inputs");
  }
  for (const { name, version, license, override } of extras) {
    const id = `${name}@${version}`;
    const text = readOverride(overridesDir, override);
    if (!text) {
      problems.push(
        `${id} ships no licence text; add a reviewed copy as ${overrideFileName(override)} in the overrides folder`,
      );
    }
    const bad = licenseProblem(id, license, alsoAccepted);
    if (bad) problems.push(bad);
    packages.push({ name, version, license, texts: text ? [text] : [] });
  }
  const seen = new Map();
  for (const p of packages) seen.set(`${p.name}@${p.version}`, p);
  const unique = [...seen.values()].sort((a, b) =>
    `${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1,
  );
  return { packages: unique, problems };
}

const RULE = "=".repeat(78);
const heading = (title) => `${RULE}\n${title}\n${RULE}\n`;
const label = (p) => `${p.name}@${p.version} (${p.license})`;
const block = (text) => `${text.trim()}\n`;

/** How the file names what it describes: a compiled executable unless the caller says otherwise. */
const EXECUTABLE = {
  intro: "the third-party software bundled into this file's executable",
  list: "Third-party packages bundled into this executable",
};

function render({ artifact, project, packages, notes, subject }) {
  // Packages whose texts are byte-identical share one copy, listed under all their names.
  const groups = new Map();
  for (const p of packages) {
    const body = p.texts.map((t) => block(t.text)).join("\n");
    groups.set(body, [...(groups.get(body) ?? []), p]);
  }
  const out = [
    `Licence notices for ${artifact}\n`,
    `${project.name} and ${subject.intro}.\n`,
    heading(project.name),
    block(project.notice),
    block(project.license),
    heading(`${subject.list} (${packages.length})`),
    `${packages.map(label).join("\n")}\n`,
  ];
  for (const [body, members] of groups) {
    out.push(`${"-".repeat(78)}\n${members.map(label).join("\n")}\n${"-".repeat(78)}\n`, body);
  }
  if (notes.length > 0) {
    out.push(heading("Not reproduced in this file"), `${notes.map((n) => `- ${n}`).join("\n")}\n`);
  }
  return out.join("\n");
}

/**
 * The licence file's text for one artifact, or an Error listing every problem. `project` is
 * `{ name, license, notice }` (the project's own texts); `notes` name what the file leaves out;
 * `subject` is `{ intro, list }`, the two phrases that name the artifact's kind.
 */
export function buildLicenseFile({
  artifact,
  inputs,
  baseDir,
  overridesDir,
  overrideAliases,
  extras,
  alsoAccepted,
  project,
  notes = [],
  subject = EXECUTABLE,
}) {
  const { packages, problems } = collectThirdParty({
    inputs,
    baseDir,
    overridesDir,
    overrideAliases,
    extras,
    alsoAccepted,
  });
  if (problems.length > 0) {
    throw new Error(
      `cannot write the licence file for ${artifact}:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return render({ artifact, project, packages, notes, subject });
}
