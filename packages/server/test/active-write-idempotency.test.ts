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

describe("active-file idempotency", () => {
  it.each(["patch_active_file", "delete_active_file"])(
    "binds %s to the resolved file",
    async (tool) => {
      const root = makeTempDir("active-idempotency-");
      const db = openMemoryDb();
      try {
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
        const registry = new ToolRegistry({
          rootResolver: () => root,
          verifyElicit: elicitVerifier,
        });
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
        const args =
          tool === "patch_active_file"
            ? {
                vault: "test",
                operation: "append",
                anchor: { type: "heading", heading: "Notes" },
                content: "added",
                options: { idempotency_key: "active" },
              }
            : { vault: "test", idempotency_key: "active" };
        let first = await registry.dispatch(tool, args, ctx);
        if (!first.ok && first.error.code === "elicit_required") {
          const token = issueElicitToken(db, {
            vaultId: "test",
            toolName: tool,
            argsHash: (first.error.details as { args_hash: string }).args_hash,
            caller: "test",
          });
          first = await registry.dispatch(tool, args, { ...ctx, elicitToken: token });
        }
        expect(first.ok, JSON.stringify(first)).toBe(true);
        writeFileSync(join(root, "a.md"), "replacement");
        const replay = await registry.dispatch(tool, args, ctx);
        expect(replay.meta?.idempotent_replay).toBe(true);
        expect(replay.ok && replay.data).toEqual(first.ok && first.data);
        expect(readFileSync(join(root, "a.md"), "utf8")).toBe("replacement");
        const changed =
          tool === "patch_active_file"
            ? { ...args, content: "other" }
            : { ...args, permanent: true };
        const changedResult = await registry.dispatch(tool, changed, ctx);
        expect(changedResult.ok ? null : changedResult.error.code).toBe("idempotency_key_mismatch");
        focus("b.md");
        const mismatch = await registry.dispatch(tool, args, ctx);
        expect(mismatch.ok ? null : mismatch.error.code).toBe("idempotency_key_mismatch");
      } finally {
        db.close();
        rmTemp(root);
      }
    },
  );
});
