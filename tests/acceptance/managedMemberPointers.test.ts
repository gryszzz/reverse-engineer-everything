import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect } from "vitest";

import { parseEvidence } from "../../src/domain/evidence.js";
import { buildManagedMemberPointerFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "CLI and stdio MCP retain physical member identities through reordered pointers",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-member-pointers-");
    const path = join(root, "reordered.dll");
    const bytes = buildManagedMemberPointerFixture();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path, bytes);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "managed-pointer-parity", version: "1" });
    try {
      await client.connect(transport);
      for (const name of [
        "inspect_managed_artifact",
        "inspect_managed_members",
      ] as const) {
        const cliResult = await cli.run({
          arguments: [name.replaceAll("_", "-"), path, "--json"],
        });
        expect(cliResult.exitCode, cliResult.stderr).toBe(0);
        const cliEvidence = parseEvidence(cliResult.json);
        const response = await client.callTool({ name, arguments: { path } });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        const mcpEvidence = parseEvidence(response.structuredContent);
        expect(mcpEvidence.normalized_result).toEqual(
          cliEvidence.normalized_result,
        );
        expect(mcpEvidence.subject?.digest.sha256).toBe(sha256);
        expect(cliEvidence.subject?.digest.sha256).toBe(sha256);
        expect(mcpEvidence.normalized_result).toMatchObject({
          coverage: { state: "complete", issues: [] },
        });
        if (name === "inspect_managed_artifact") {
          expect(mcpEvidence.normalized_result).toMatchObject({
            attributes: [
              expect.objectContaining({
                constructor_token: "0x06000001",
                type_name: "Fixture.B",
              }),
            ],
          });
        } else {
          expect(mcpEvidence.normalized_result).toMatchObject({
            fields: [
              expect.objectContaining({
                token: "0x04000001",
                declaring_type: "Fixture.B",
              }),
              expect.objectContaining({
                token: "0x04000002",
                declaring_type: "Fixture.A",
              }),
            ],
            methods: [
              expect.objectContaining({
                token: "0x06000001",
                declaring_type: "Fixture.B",
              }),
              expect.objectContaining({
                token: "0x06000002",
                declaring_type: "Fixture.A",
              }),
            ],
          });
        }
      }
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
  },
);
