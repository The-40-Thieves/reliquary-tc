// inspect_acl answers what enforcement would: each case here asks the tool and the real gate
// (read_note or enforcePathAcl) the same question and expects the same answer.

import { linkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAdminTools } from "../src/tools/m6/admin-tools";
import { enforcePathAcl } from "../src/vault/acl-path";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

type Register = NonNullable<Parameters<typeof makeM6Vault>[0]>["register"];
const register: Register = (r, d) => {
  for (const t of buildAdminTools(d)) r.register(t);
};

function data<T = Record<string, unknown>>(r: Awaited<ReturnType<M6Vault["call"]>>): T {
  expect(r.ok).toBe(true);
  return (r as { data: unknown }).data as T;
}

let v: M6Vault | undefined;
afterEach(() => v?.cleanup());

describe("inspect_acl parity with enforcement", () => {
  it("matches read_note for hard-linked and single-link notes", async (context) => {
    v = makeM6Vault({ files: { "a.md": "hello", "plain.md": "hello" }, register });
    try {
      linkSync(join(v.root, "a.md"), join(v.root, "alias.md"));
    } catch (error) {
      if (
        ["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        context.skip();
        return;
      }
      throw error;
    }
    for (const [path, allowed] of [
      ["alias.md", false],
      ["plain.md", true],
    ] as const) {
      const out = data<{ allowed: boolean; denied_by?: string }>(
        await v.call("inspect_acl", { vault: "test", path, op: "read", scopes: ["*"] }),
      );
      const read = await v.call("read_note", { vault: "test", path });
      expect(out.allowed).toBe(allowed);
      if (!allowed) expect(out.denied_by).toBe("hard_link");
      expect(read.ok).toBe(allowed);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a written alias inside an immutable folder",
    async () => {
      v = makeM6Vault({
        files: { "target/a.md": "hello", "raw/placeholder.md": "x" },
        acl: { immutablePaths: ["raw/**"] },
        register,
      });
      symlinkSync(join(v.root, "target", "a.md"), join(v.root, "raw", "alias.md"));
      const vault = v;
      expect(() => enforcePathAcl(vault.acl, "write", "raw/alias.md", vault.root, ["*"])).toThrow();
      const out = data<{ allowed: boolean }>(
        await v.call("inspect_acl", {
          vault: "test",
          path: "raw/alias.md",
          op: "write",
          scopes: ["*"],
        }),
      );
      expect(out.allowed).toBe(false);
    },
  );

  it("rejects a new invalid write name like enforcement", async () => {
    v = makeM6Vault({ register });
    const vault = v;
    expect(() => enforcePathAcl(vault.acl, "write", "bad:name.md", vault.root, ["*"])).toThrow();
    const badName = { vault: "test", path: "bad:name.md", op: "write", scopes: ["*"] };
    expect(data(await v.call("inspect_acl", badName))).toMatchObject({
      allowed: false,
      denied_by: "invalid_write_path",
    });
    // A read-only vault refuses the write before its name is looked at: the kill switch wins.
    v.cleanup();
    v = makeM6Vault({ acl: { readOnly: true }, register });
    expect(data(await v.call("inspect_acl", badName))).toMatchObject({
      allowed: false,
      denied_by: "read_only",
      kill_switch: true,
    });
  });
});
