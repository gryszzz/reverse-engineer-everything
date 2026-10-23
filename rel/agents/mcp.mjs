import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  analyzeForAgent,
  packageForAgent,
  postSpecToBoard,
  readFindings,
  readSpec,
  rebuildForAgent,
  verifyForAgent,
} from "./flow.mjs";

export async function serveAgentMcp() {
  const server = new McpServer({
    name: "ree-agents",
    version: "1",
  });
  const tool = (name, description, inputSchema, run) => {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        const value = await run(args);
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                schema_version: "ree.agent.v1",
                step: name,
                ok: false,
                error: message,
              }),
            },
          ],
        };
      }
    });
  };
  tool(
    "ree_analyze",
    "Read a public URL, or an outside-in fixture directory, into findings and a behavior spec. No login and no source fetch.",
    z.object({
      outDir: z.string(),
      url: z.string().optional(),
      name: z.string().optional(),
      fixtureDir: z.string().optional(),
    }),
    (args) => analyzeForAgent(args),
  );
  tool(
    "ree_findings",
    "Read findings.json from an agent run directory.",
    z.object({ runDir: z.string() }),
    (args) => readFindings(args.runDir),
  );
  tool(
    "ree_spec",
    "Read the behavior spec from an agent run directory.",
    z.object({ runDir: z.string() }),
    (args) => readSpec(args.runDir),
  );
  tool(
    "ree_rebuild",
    "Rebuild a product from a behavior spec. The product name must differ from the spec target.",
    z.object({
      specPath: z.string(),
      name: z.string(),
      outDir: z.string(),
    }),
    (args) => rebuildForAgent(args),
  );
  tool(
    "ree_verify",
    "Run the product behavior tests.",
    z.object({ projectDir: z.string() }),
    (args) => verifyForAgent(args.projectDir),
  );
  tool(
    "ree_package",
    "Write product.tgz for a rebuilt product.",
    z.object({ projectDir: z.string() }),
    (args) => packageForAgent(args.projectDir),
  );
  tool(
    "ree_board_post",
    "Post a behavior spec onto the local opportunity board. Guard, Blast, and Scale are not called.",
    z.object({ specPath: z.string(), dataDir: z.string() }),
    (args) => postSpecToBoard(args),
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
