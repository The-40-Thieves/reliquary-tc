// The server the stdio era tests build for either era: one tool with a fixed result, a fixed caller
// context, and the resources surface when a vault root is given. The resourceSubscribe rule is the
// one production applies (runtime/server-runtime.ts): no resource subscriptions on 2026-07-28 stdio.

import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

export interface StdioTestServerOptions {
  tool: string;
  result: Record<string, unknown>;
  vaultRoot?: string;
}

export function stdioTestBuilder(opts: StdioTestServerOptions) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry({ rootResolver: () => undefined });
  registry.register({
    name: opts.tool,
    description: "test-only: a tool for tools/list to report",
    inputSchema: z.object({}),
    requiredScopes: [],
    handler: () => opts.result,
  } as never);
  const vaultRegistry =
    opts.vaultRoot === undefined
      ? undefined
      : new VaultRegistry([{ id: "v1", path: opts.vaultRoot }]);
  return (era: "legacy" | "modern") =>
    createMcpServer({
      name: "reliquary-tc",
      version: "0.0.0-test",
      registry,
      context: (): CallerContext => ({
        caller: "stdio",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "v1",
        db,
      }),
      visibility: { grantedScopes: new Set(["*"]) },
      ...(vaultRegistry ? { vaultRegistry } : {}),
      era,
      resourceSubscribe: era !== "modern",
    });
}
