// A caller that may write a file but not read it keeps the write, and the response leaves out every
// field worked out from the bytes it may not read: an existing attachment's size, the byte count of
// a periodic append (it tells whether the note ended in a newline), and the event count of a session
// trace kept inside the vault. A caller that may read gets each field as before.
import type { ToolResult } from "@the-40-thieves/reliquary-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { insertSession } from "../src/workspace/sessions";
import { type M3Vault, makeM3Vault } from "./m3-helpers";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

const WRITE_ONLY_ACL = { readPaths: ["Public/**"], writePaths: ["**"], deletePaths: ["**"] };
const READER_ACL = { writePaths: ["**"], deletePaths: ["**"] };
const PNG_B64 = Buffer.from("new bytes").toString("base64");

const dataOf = (r: ToolResult): Record<string, unknown> => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as Record<string, unknown>;
};
const detailsOf = (r: ToolResult): Record<string, unknown> => {
  if (r.ok) throw new Error("expected a confirmation request");
  expect(r.error.code).toBe("elicit_required");
  return r.error.details as Record<string, unknown>;
};
const scopes = (...s: string[]) => ({ grantedScopes: new Set(s) });
// The two ways a caller may not read a file, kept apart so each half of the check is exercised: the
// scope is missing while the path is open, or the scope is held while the path is denied.
const nonReaders = (...readScopes: string[]) => [
  { why: "lacks the read scope", acl: READER_ACL, held: [] as string[] },
  { why: "holds the read scope but is denied the path", acl: WRITE_ONLY_ACL, held: readScopes },
];

let m3: M3Vault | undefined;
let m5: M5Vault | undefined;
afterEach(() => {
  m3?.cleanup();
  m5?.cleanup();
  m3 = undefined;
  m5 = undefined;
});

describe("write_attachment over an existing file", () => {
  const input = { vault: "test", path: "Private/a.png", content: PNG_B64, overwrite: true };

  describe.each(nonReaders("read:attachments"))("a caller that $why", ({ acl, held }) => {
    it.each(["OLD", "A LONGER OLD FILE"])("is not told its size (%s)", async (old) => {
      m3 = makeM3Vault({ files: { "Private/a.png": old }, acl });
      const who = scopes("write:attachments", ...held);
      const asked = detailsOf(await m3.call("write_attachment", input, who));
      expect(asked.previous_size).toBeNull();
      const elicitToken = issueElicitToken(m3.db, {
        vaultId: "test",
        toolName: "write_attachment",
        argsHash: asked.args_hash as string,
        caller: "test",
      });
      const done = dataOf(await m3.call("write_attachment", input, { ...who, elicitToken }));
      expect(done).toMatchObject({ overwritten: true });
      expect(m3.read("Private/a.png")).toBe("new bytes");
    });
  });

  it("a caller that may read it is told its size", async () => {
    m3 = makeM3Vault({ files: { "Private/a.png": "OLD" }, acl: READER_ACL });
    const who = scopes("write:attachments", "read:attachments");
    expect(detailsOf(await m3.call("write_attachment", input, who)).previous_size).toBe(3);
  });
});

describe("delete_attachment", () => {
  const input = { vault: "test", path: "Private/a.png" };

  it.each(nonReaders("read:attachments"))(
    "a caller that $why deletes it and is not told its size",
    async ({ acl, held }) => {
      m3 = makeM3Vault({ files: { "Private/a.png": "OLD" }, acl });
      const who = scopes("delete:attachments", ...held);
      const done = dataOf(await m3.callConfirmed("delete_attachment", input, who));
      expect(done).toMatchObject({ deleted: true, size: null });
      expect(m3.exists("Private/a.png")).toBe(false);
    },
  );

  it("a caller that may read it is told its size", async () => {
    m3 = makeM3Vault({ files: { "Private/a.png": "OLD" }, acl: READER_ACL });
    const done = dataOf(
      await m3.callConfirmed(
        "delete_attachment",
        input,
        scopes("delete:attachments", "read:attachments"),
      ),
    );
    expect(done).toMatchObject({ deleted: true, size: 3 });
  });
});

describe("append_to_periodic_note onto an existing note", () => {
  const input = { vault: "test", period: "daily", date: "2026-06-18", content: "x" };
  const strip = (d: Record<string, unknown>) => ({ ...d, updated_at: null });

  it.each(nonReaders("read:periodic", "read:notes"))(
    "a caller that $why appends, and the reply does not depend on its bytes",
    async ({ acl, held }) => {
      const who = scopes("write:periodic", ...held);
      const replies: Record<string, unknown>[] = [];
      for (const existing of ["PIN 4821", "PIN 4821\n"]) {
        m3?.cleanup();
        m3 = makeM3Vault({ files: { "2026-06-18.md": existing }, acl });
        const done = dataOf(await m3.call("append_to_periodic_note", input, who));
        expect(done).not.toHaveProperty("appended_bytes");
        expect(m3.read("2026-06-18.md")).toContain("x");
        replies.push(strip(done));
      }
      expect(replies[0]).toEqual(replies[1]);
    },
  );

  it("a caller that may not read still gets the count for a note the call creates", async () => {
    m3 = makeM3Vault({ acl: WRITE_ONLY_ACL });
    const done = dataOf(await m3.call("append_to_periodic_note", input, scopes("write:periodic")));
    expect(done).toMatchObject({ created: true });
    expect(typeof done.appended_bytes).toBe("number");
  });

  it.each(["read:periodic", "read:notes"])(
    "a caller that may read it under %s gets the count",
    async (readScope) => {
      m3 = makeM3Vault({ files: { "2026-06-18.md": "PIN 4821" }, acl: READER_ACL });
      const done = dataOf(
        await m3.call("append_to_periodic_note", input, scopes("write:periodic", readScope)),
      );
      expect(typeof done.appended_bytes).toBe("number");
    },
  );
});

describe("end_session on a session whose trace is inside the vault", () => {
  const TRACE = "Private/trace.jsonl";
  const seed = (acl: typeof WRITE_ONLY_ACL | typeof READER_ACL, events: number): M5Vault => {
    const lines = Array.from({ length: events }, (_, i) => JSON.stringify({ ts: i, type: "e" }));
    const v = makeM5Vault({ files: { [TRACE]: `${lines.join("\n")}\n` }, acl });
    insertSession(v.db, {
      id: "legacy",
      vaultId: v.id,
      caller: "test",
      principal: "test",
      startedAt: 1,
      tracePath: TRACE,
      traceStore: "vault",
    });
    return v;
  };
  const input = { vault: "test", session_id: "legacy" };

  describe.each(nonReaders("read:workspace"))("a caller that $why", ({ acl, held }) => {
    it.each([1, 4])("ends it and is not told its event count (%i events)", async (events) => {
      m5 = seed(acl, events);
      const who = scopes("write:workspace", ...held);
      const done = dataOf(await m5.call("end_session", input, who));
      expect(done).toMatchObject({ session_id: "legacy", trace_path: TRACE });
      expect(done).not.toHaveProperty("event_count");
    });
  });

  it("a caller that may read the trace is told its event count", async () => {
    m5 = seed(READER_ACL, 4);
    const done = dataOf(
      await m5.call("end_session", input, scopes("write:workspace", "read:workspace")),
    );
    expect(done.event_count).toBe(5);
  });
});
