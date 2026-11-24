import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import {
  CapabilityCache,
  createBridgeClient,
  type FakeRoute,
  fakeBridgeTransport,
} from "../src/bridge";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { ToolRegistry } from "../src/mcp/registry";
import { registerM1Tools } from "../src/tools/m1";
import { registerM4Tools } from "../src/tools/m4";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

/** A two-note vault behind a fake bridge whose active file `focus` switches. */
function harness() {
  const root = makeTempDir("active-idempotency-");
  const db = openMemoryDb();
  provisionCacheDb(db);
  for (const file of ["a.md", "b.md"]) writeFileSync(join(root, file), "## Notes\nbody\n");
  const vaultRegistry = new VaultRegistry([{ id: "test", path: root }]);
  const routes: Record<string, FakeRoute> = {};
  const focus = (path: string) => {
    routes["GET /obsidian-tc/v1/files/active"] = {
      body: { ok: true, result: { path, extension: "md" } },
    };
  };
  focus("a.md");
  const client = createBridgeClient({
    baseUrl: "http://127.0.0.1:27124",
    apiKey: "test",
    fetchFn: fakeBridgeTransport({ routes }),
  });
  const capabilities = new CapabilityCache();
  capabilities.set("test", { companion: "reachable", plugins: {} });
  const registry = new ToolRegistry({ rootResolver: () => root, verifyElicit: elicitVerifier });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "none", model: "none" },
  });
  registerM4Tools(registry, { vaultRegistry, capabilities, bridgeFor: () => client });
  const ctx = {
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "test",
    db,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  };
  /** Dispatch, answering a confirmation request with a token issued for it. */
  const confirmed = async (tool: string, args: Record<string, unknown>) => {
    const asked = await registry.dispatch(tool, args, ctx);
    if (asked.ok || asked.error.code !== "elicit_required") return asked;
    const elicitToken = issueElicitToken(db, {
      vaultId: "test",
      toolName: tool,
      argsHash: (asked.error.details as { args_hash: string }).args_hash,
      caller: "test",
    });
    return registry.dispatch(tool, args, { ...ctx, elicitToken });
  };
  const cleanup = () => {
    db.close();
    rmTemp(root);
  };
  return { root, registry, ctx, focus, confirmed, cleanup };
}

const CASES = [
  {
    tool: "patch_active_file",
    args: {
      vault: "test",
      operation: "append",
      anchor: { type: "heading", heading: "Notes" },
      content: "added",
      options: { idempotency_key: "active" },
    },
    changed: { content: "other" },
  },
  {
    tool: "delete_active_file",
    args: { vault: "test", idempotency_key: "active" },
    changed: { permanent: true },
  },
];

describe("active-file idempotency", () => {
  it.each(CASES)("binds $tool to the resolved file", async ({ tool, args, changed }) => {
    const h = harness();
    try {
      const first = await h.confirmed(tool, args);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      writeFileSync(join(h.root, "a.md"), "replacement");
      const replay = await h.registry.dispatch(tool, args, h.ctx);
      expect(replay.meta?.idempotent_replay).toBe(true);
      expect(replay.ok && replay.data).toEqual(first.ok && first.data);
      expect(readFileSync(join(h.root, "a.md"), "utf8")).toBe("replacement");
      const changedResult = await h.registry.dispatch(tool, { ...args, ...changed }, h.ctx);
      expect(changedResult.ok ? null : changedResult.error.code).toBe("idempotency_key_mismatch");
      h.focus("b.md");
      const mismatch = await h.registry.dispatch(tool, args, h.ctx);
      expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
    } finally {
      h.cleanup();
    }
  });
});
