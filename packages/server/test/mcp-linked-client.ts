import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { createMcpServer } from "../src/mcp/server";

type McpServer = ReturnType<typeof createMcpServer>;

/** Connect a fresh client to `server` over an in-memory transport pair. */
export async function linkedClient(
  server: McpServer,
): Promise<{ client: Client; server: McpServer }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientSide);
  return { client, server };
}
