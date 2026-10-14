import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = fileURLToPath(new URL("../", import.meta.url));

test("trusted Codex project configuration points to the fork", () => {
  const file = readFileSync(resolve(root, ".codex/config.toml"), "utf8");
  assert.match(file, /\[mcp_servers\.rea\]/);
  assert.match(file, /args = \["scripts\/rea\.mjs", "mcp"\]/);
  assert.match(file, /cwd = "\."/);
});

test(
  "the fork's locally built MCP server can complete a real tool-discovery handshake",
  { timeout: 30000 },
  async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(root, "scripts/rea.mjs"), "mcp"],
      cwd: root,
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client({
      name: "rel-codex-project-smoke",
      version: "0.1.0",
    });
    try {
      await client.connect(transport);
      const response = await client.listTools();
      assert.ok(
        Array.isArray(response.tools),
        "Server must advertise an MCP tool list",
      );
      assert.ok(
        response.tools.some(
          (tool) => tool.name === "analyze_javascript_application",
        ),
        "Missing real REA JavaScript analysis tool",
      );
      assert.ok(
        response.tools.some((tool) => tool.name === "inspect_analysis_view"),
        "Missing real REA evidence-view tool",
      );
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  },
);
