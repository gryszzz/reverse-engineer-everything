import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("retains every static finding through public module views when application expansion exceeds memory, then accepts more work", async () => {
  const root = await createTestTempDirectory("rea-js-resource-boundary-");
  const nextRoot = await createTestTempDirectory("rea-js-resource-recovery-");
  await writeFile(join(nextRoot, "main.js"), "export const recovered = 9;\n");
  const source = Array.from(
    { length: 4000 },
    (_, index) =>
      `import { observed as binding${String(index)} } from "./target.js";`,
  ).join("\n");
  const path = join(root, "main.js");
  await writeFile(path, source);
  await writeFile(join(root, "target.js"), "export const observed = 7;\n");
  const digest = createHash("sha256").update(source).digest("hex");
  const { client, transport, diagnostics } = createResourceClient();
  try {
    await client.connect(transport);
    const response = await client.callTool(
      {
        name: "analyze_javascript_application",
        arguments: {
          input_path: root,
          format: "directory",
          max_heap_mb: 128,
          detail: "summary",
        },
      },
      { timeout: 60000 },
    );
    expect(response.isError).not.toBe(true);
    const summary = z
      .object({
        normalized_result: z.object({
          parent_evidence_id: z.string(),
          summary: z.object({
            coverage: z.object({
              application: z.object({ status: z.string() }),
            }),
          }),
        }),
      })
      .parse(response.structuredContent).normalized_result;
    expect(summary.summary.coverage.application.status).toBe("partial");
    const retained = {
      kind: "retained-evidence",
      evidence_id: summary.parent_evidence_id,
    };
    const pageResponse = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: retained,
        view: { kind: "page", collection: "modules", offset: 0, limit: 100 },
      },
    });
    expect(pageResponse.isError).not.toBe(true);
    const page = z
      .object({
        normalized_result: z.object({
          items: z.array(
            z.object({
              node_id: z.string(),
              kind: z.string(),
              path: z.string().nullable(),
            }),
          ),
        }),
      })
      .parse(pageResponse.structuredContent).normalized_result;
    const module = page.items.find(
      (item) => item.kind === "javascript-asset" && item.path === "main.js",
    );
    if (module === undefined)
      throw new Error("The analyzed file disappeared from public module views");
    const itemResponse = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: retained,
        view: {
          kind: "item",
          collection: "modules",
          selector: { node_id: module.node_id },
        },
      },
    });
    expect(itemResponse.isError).not.toBe(true);
    const item = z
      .object({
        normalized_result: z.object({
          item: z.object({
            identity: z.object({ sha256: z.string() }),
            observations: z.array(
              z.object({
                properties: z.object({
                  static_analysis: z
                    .object({
                      parse_status: z.string(),
                      references: z.array(
                        z.object({
                          specifier: z.string(),
                          location: z.object({
                            start: z.object({ line: z.number() }),
                          }),
                        }),
                      ),
                    })
                    .optional(),
                }),
              }),
            ),
          }),
        }),
      })
      .parse(itemResponse.structuredContent).normalized_result.item;
    expect(item.identity.sha256).toBe(digest);
    const facts = item.observations.find(
      (observation) => observation.properties.static_analysis !== undefined,
    )?.properties.static_analysis;
    if (facts === undefined)
      throw new Error("Completed static observations were discarded");
    expect(facts.parse_status).toBe("complete");
    expect(
      facts.references.map((reference) => [
        reference.specifier,
        reference.location.start.line,
      ]),
    ).toEqual(
      Array.from({ length: 4000 }, (_, index) => ["./target.js", index + 1]),
    );
    await client.ping();
    const next = await client.callTool({
      name: "analyze_javascript_application",
      arguments: {
        input_path: nextRoot,
        format: "directory",
        max_heap_mb: 128,
        detail: "summary",
      },
    });
    expect(next.isError).not.toBe(true);
    await client.ping();
    expect(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ).toBe(digest);
    expect(diagnostics()).not.toMatch(/FATAL ERROR:.*heap/iu);
  } finally {
    await client.close();
    await transport.close();
  }
}, 90000);

it("returns a directly usable partial analysis reference for an oversized timeout observation", async () => {
  const root = await createTestTempDirectory("rea-js-large-timeout-");
  for (let offset = 0; offset < 1500; offset += 50)
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        writeFile(
          join(root, `file-${String(offset + index)}.js`),
          "export const observed = 7;\n",
        ),
      ),
    );
  const nextRoot = await createTestTempDirectory("rea-js-timeout-recovery-");
  await writeFile(join(nextRoot, "main.js"), "export const recovered = 9;\n");
  const { client, transport, diagnostics } = createResourceClient();
  try {
    await client.connect(transport);
    const response = await client.callTool(
      {
        name: "analyze_javascript_application",
        arguments: {
          input_path: root,
          format: "directory",
          max_heap_mb: 128,
          analysis_timeout_ms: 1,
        },
      },
      { timeout: 60000 },
    );
    expect(response.isError).toBe(true);
    const text = response.content.find((item) => item.type === "text");
    if (text?.type !== "text")
      throw new Error("Missing actionable timeout response");
    const projected = z
      .object({
        error: z.object({
          code: z.string(),
          details: z.object({
            partial_observation: z.object({
              kind: z.literal("retained-evidence"),
              evidence_id: z.string(),
            }),
          }),
        }),
      })
      .parse(JSON.parse(text.text));
    expect(projected.error.code).toBe("provider_timeout");
    const summaryResponse = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: projected.error.details.partial_observation,
        view: { kind: "summary" },
      },
    });
    expect(summaryResponse.isError).not.toBe(true);
    const summary = z
      .object({
        normalized_result: z.object({
          summary: z.object({
            statistics: z.object({
              relevant_files: z.number(),
              parsed_javascript_files: z.number(),
              parse_failures: z.number(),
            }),
            coverage: z.object({ semantic_unknowns: z.number() }),
          }),
        }),
      })
      .parse(summaryResponse.structuredContent).normalized_result.summary;
    expect(summary.statistics).toEqual({
      relevant_files: 1500,
      parsed_javascript_files: 0,
      parse_failures: 0,
    });
    expect(summary.coverage.semantic_unknowns).toBeGreaterThan(1500);
    await verifyRepeatedSourcePaths(
      client,
      projected.error.details.partial_observation,
    );
    await client.ping();
    const next = await client.callTool({
      name: "analyze_javascript_application",
      arguments: {
        input_path: nextRoot,
        format: "directory",
        max_heap_mb: 128,
        detail: "summary",
      },
    });
    expect(next.isError).not.toBe(true);
    await client.ping();
    expect(diagnostics()).not.toMatch(/FATAL ERROR:.*heap/iu);
  } finally {
    await client.close();
    await transport.close();
  }
}, 90000);

const createResourceClient = () => {
  const client = new Client({ name: "javascript-resources", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("scripts/rea.mjs"), "mcp"],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      NODE_OPTIONS: "--max-old-space-size=512 --max-semi-space-size=8",
    },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    if (diagnostics.length < 262144) diagnostics += chunk.toString();
  });
  return { client, transport, diagnostics: () => diagnostics };
};

const verifyRepeatedSourcePaths = async (
  client: Client,
  source: { readonly kind: "retained-evidence"; readonly evidence_id: string },
): Promise<void> => {
  const page = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source,
      view: { kind: "page", collection: "modules", offset: 0, limit: 4 },
    },
  });
  expect(page.isError).not.toBe(true);
  const modules = z
    .object({
      normalized_result: z.object({
        items: z.array(z.object({ kind: z.string(), node_id: z.string() })),
      }),
    })
    .parse(page.structuredContent);
  const asset = modules.normalized_result.items.find(
    ({ kind }) => kind === "javascript-asset",
  );
  if (asset === undefined)
    throw new Error(
      "Identical source files disappeared from the retained graph",
    );
  const item = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source,
      view: {
        kind: "item",
        collection: "modules",
        selector: { node_id: asset.node_id },
      },
    },
  });
  expect(item.isError).not.toBe(true);
  const observations = z
    .object({
      normalized_result: z.object({
        item: z.object({
          observations: z.array(z.object({ label: z.string() })),
        }),
      }),
    })
    .parse(item.structuredContent).normalized_result.item.observations;
  expect(observations.map(({ label }) => label).sort()).toEqual(
    Array.from(
      { length: 1500 },
      (_, index) => `file-${String(index)}.js`,
    ).sort(),
  );
};
