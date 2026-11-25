import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { buildResourceUri } from "../src/mcp/resources";
import { createMcpServer } from "../src/mcp/server";
import type { JobQueue } from "../src/scheduler/job-queue";
import { buildSearchMentionsTool } from "../src/tools/m2/search-mentions-tool";
import { VaultRegistry } from "../src/vault/registry";
import { linkedClient } from "./mcp-linked-client";
import { makeTempDir, rmTemp } from "./tmp";

const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

/** A registry holding only the mentions tool over `ids` temp vaults, each with one note; every
 *  vault is visible to the caller, as a VaultRegistry-backed registry resolves it in production. */
function registryWithMentions(ids: string[] = ["main"]): {
  registry: ToolRegistry;
  vaultRegistry: VaultRegistry;
} {
  const vaults = ids.map((id) => {
    const root = makeTempDir("obtc-mentions-cap-");
    dirs.push(root);
    writeFileSync(join(root, "Hello.md"), "# Hello\n");
    return { id, path: root };
  });
  const vaultRegistry = new VaultRegistry(vaults);
  const registry = new ToolRegistry({ rootResolver: () => undefined, visibleVaultIds: () => ids });
  registry.register(buildSearchMentionsTool({ vaultRegistry }, (id) => registry.aclFor(id)));
  return { registry, vaultRegistry };
}

const context = (): CallerContext => ({
  caller: "t",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: "main",
  db: {} as never,
});

/** Connect a client to a triad-mode server; the options under test are spread in. */
async function connect(
  extra: Partial<Parameters<typeof createMcpServer>[0]> = {},
  vaultIds?: string[],
) {
  const { registry, vaultRegistry } = registryWithMentions(vaultIds);
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    vaultRegistry,
    facadeMode: "triad",
    ...extra,
  });
  return linkedClient(server);
}

const fakeQueue = {} as unknown as JobQueue;

describe("openai/mentions capability, flag off", () => {
  it("advertises no openai/mentions extension and no search_mentions listing", async () => {
    const { client, server } = await connect();
    const caps = client.getServerCapabilities() as Record<string, unknown>;
    expect(caps.extensions).toBeUndefined();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("search_mentions");
    await client.close();
    await server.close();
  });

  it("tools/list and capabilities are byte-identical to a build that never passed the option", async () => {
    const plain = await connect();
    const off = await connect({ openaiMentions: false });
    const plainTools = JSON.stringify((await plain.client.listTools()).tools);
    const offTools = JSON.stringify((await off.client.listTools()).tools);
    expect(offTools).toBe(plainTools);
    expect(JSON.stringify(off.client.getServerCapabilities())).toBe(
      JSON.stringify(plain.client.getServerCapabilities()),
    );
    await plain.client.close();
    await plain.server.close();
    await off.client.close();
    await off.server.close();
  });

  it("with a job queue, the capabilities keep only the Tasks extension", async () => {
    const { client, server } = await connect({ jobQueue: fakeQueue, openaiMentions: false });
    const ext = (client.getServerCapabilities() as { extensions?: Record<string, unknown> })
      .extensions;
    expect(Object.keys(ext ?? {})).toEqual([TASKS_EXTENSION]);
    await client.close();
    await server.close();
  });
});

describe("openai/mentions, domain surface", () => {
  it("lists search_mentions directly beside the domain tools when the flag is on", async () => {
    const { client, server } = await connect({ facadeMode: "domain", openaiMentions: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("search_mentions");
    expect(names).toContain("search");
    await client.close();
    await server.close();
  });

  it("lists only the domain tools when the flag is off", async () => {
    const { client, server } = await connect({ facadeMode: "domain" });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("search_mentions");
    expect(names).toEqual(["search"]);
    await client.close();
    await server.close();
  });
});

describe("openai/mentions capability, flag on", () => {
  it("is not advertised to a caller who cannot see search_mentions", async () => {
    const visibility = { grantedScopes: new Set(["write:notes"]) };
    const { client, server } = await connect({ openaiMentions: true, visibility });
    const ext = (client.getServerCapabilities() as { extensions?: Record<string, unknown> })
      .extensions;
    expect(ext?.["openai/mentions"]).toBeUndefined();
    await client.close();
    await server.close();
  });

  it("advertises searchTool: search_mentions under extensions", async () => {
    const { client, server } = await connect({ openaiMentions: true });
    const ext = (client.getServerCapabilities() as { extensions?: Record<string, unknown> })
      .extensions;
    expect(ext?.["openai/mentions"]).toEqual({ searchTool: "search_mentions" });
    await client.close();
    await server.close();
  });

  it("keeps the Tasks extension beside it when a job queue backs it", async () => {
    const { client, server } = await connect({ openaiMentions: true, jobQueue: fakeQueue });
    const ext = (client.getServerCapabilities() as { extensions?: Record<string, unknown> })
      .extensions;
    expect(ext?.["openai/mentions"]).toEqual({ searchTool: "search_mentions" });
    expect(ext?.[TASKS_EXTENSION]).toEqual({});
    await client.close();
    await server.close();
  });

  it("lists search_mentions in triad mode as a read-only, app-visible tool", async () => {
    const { client, server } = await connect({ openaiMentions: true });
    const tool = (await client.listTools()).tools.find((t) => t.name === "search_mentions");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    const meta = tool?._meta as { ui?: { visibility?: string[] } } | undefined;
    expect(meta?.ui?.visibility).toContain("app");
    await client.close();
    await server.close();
  });
});

describe("openai/mentions, a host call", () => {
  // The host sends only {query}; the vault comes from the caller's default, never the arguments.
  it("answers a {query}-only call with no vault argument", async () => {
    const { client, server } = await connect({ openaiMentions: true });
    const res = await client.callTool({ name: "search_mentions", arguments: { query: "hello" } });
    expect(res.isError).toBeFalsy();
    const items = (res.structuredContent as { items: Array<{ type: string; name: string }> }).items;
    expect(items.map((i) => [i.type, i.name])).toEqual([["resource_link", "Hello"]]);
    // The links live only in structuredContent; the content a text-only client sees is one text
    // block that still names the note.
    const blocks = res.content as Array<{ type: string; text?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["text"]);
    expect(blocks[0]?.text).toContain(buildResourceUri("main", "Hello.md"));
    await client.close();
    await server.close();
  });

  it("answers an empty query with the most recent notes", async () => {
    const { client, server } = await connect({ openaiMentions: true });
    const res = await client.callTool({ name: "search_mentions", arguments: { query: "" } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { items: unknown[] }).items).toHaveLength(1);
    await client.close();
    await server.close();
  });
});

describe("openai/mentions, a host call with several vaults", () => {
  it("answers a {query}-only call when the caller can see two vaults", async () => {
    const { client, server } = await connect({ openaiMentions: true }, ["main", "work"]);
    const res = await client.callTool({ name: "search_mentions", arguments: { query: "hello" } });
    expect(res.isError).toBeFalsy();
    const items = (res.structuredContent as { items: Array<{ uri: string }> }).items;
    expect(items.map((i) => i.uri).sort()).toEqual([
      buildResourceUri("main", "Hello.md"),
      buildResourceUri("work", "Hello.md"),
    ]);
    await client.close();
    await server.close();
  });
});
