// Guards the MCP elicitation surface: every form this server sends is built in one place
// (mcp/elicit-form.ts), asks only for a boolean approval, and no URL-mode sender exists.
// A new form field, a second builder, or a URL-mode sender fails here rather than in review.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildConfirmElicitationParams } from "../src/mcp/elicit-form";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const SECRET_WORDS = /pass(word|phrase)|secret|token|credential|api.?key/i;

interface SourceFile {
  rel: string;
  text: string;
}

function loadSourceFiles(dir: string = SRC_DIR): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...loadSourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push({
        rel: relative(SRC_DIR, full).split(sep).join("/"),
        text: readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

function assertConfirmationOnly(params: ReturnType<typeof buildConfirmElicitationParams>): void {
  expect(params.mode).toBe("form");
  const properties = params.requestedSchema.properties;
  expect(Object.keys(properties)).toEqual(["approve"]);
  for (const [key, property] of Object.entries(properties)) {
    expect(key).not.toMatch(SECRET_WORDS);
    expect(property.title).not.toMatch(SECRET_WORDS);
    expect(property.type).toBe("boolean");
  }
}

const CONFIRM_INPUTS: Array<[string, string | undefined]> = [
  ["vault.delete_note", undefined],
  ["vault.move_note", "notes/Quarterly plan.md"],
  ["vault.write_note", "secrets/password-token.md"],
];

describe("elicitation forms", () => {
  it("only mcp/elicit-form.ts builds a requested schema", () => {
    const sources = loadSourceFiles();
    expect(sources.length).toBeGreaterThan(100);
    const builders = sources
      .filter((file) => file.text.includes("requestedSchema"))
      .map((file) => file.rel);
    expect(builders).toEqual(["mcp/elicit-form.ts"]);
  });

  it("no src file sends URL-mode elicitation", () => {
    const sources = loadSourceFiles();
    expect(sources.length).toBeGreaterThan(100);
    // When URL-mode elicitation is added, this case is where its guard goes.
    const urlSenders = sources
      .filter((file) => /mode:\s*"url"/.test(file.text))
      .map((file) => file.rel);
    expect(urlSenders).toEqual([]);
  });

  it("the confirmation form asks only for a boolean approval", () => {
    for (const [name, path] of CONFIRM_INPUTS) {
      assertConfirmationOnly(buildConfirmElicitationParams(name, path));
    }
  });
});
