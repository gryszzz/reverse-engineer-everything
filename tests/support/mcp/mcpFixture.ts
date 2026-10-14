import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { test as base } from "vitest";

/** Client identity used during an in-memory MCP negotiation. */
export interface McpClientIdentity {
  readonly name: string;
  readonly version: string;
}

/** Registry for production MCP servers and SDK clients owned by one test. */
export interface TestMcp {
  connect(server: McpServer, identity?: McpClientIdentity): Promise<Client>;
  close(): Promise<void>;
}

const DEFAULT_CLIENT_IDENTITY: McpClientIdentity = {
  name: "rea-vitest",
  version: "1.0.0",
};

/** Create an MCP connection registry for a fixture composition root. */
export const createTestMcp = (): TestMcp => {
  const connections: { readonly client: Client; readonly server: McpServer }[] =
    [];

  return {
    connect: async (server, identity = DEFAULT_CLIENT_IDENTITY) => {
      const client = new Client(identity);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
      } catch (cause) {
        await Promise.allSettled([client.close(), server.close()]);
        throw cause;
      }
      connections.push({ client, server });
      return client;
    },
    close: async () => {
      const results = await Promise.allSettled(
        [...connections].reverse().map(async ({ client, server }) => {
          try {
            await client.close();
          } finally {
            await server.close();
          }
        }),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    },
  };
};

/** Vitest API extended with production-server/in-memory-client MCP wiring. */
export const mcpTest = base.extend<{ mcp: TestMcp }>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest parses fixture dependencies from object destructuring.
  mcp: async ({}, use) => {
    const mcp = createTestMcp();
    try {
      await use(mcp);
    } finally {
      await mcp.close();
    }
  },
});
