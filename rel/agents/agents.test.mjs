import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(
  new URL("../outside-in/fixtures/product/", import.meta.url),
);
const ree = join(root, "ree.mjs");

function run(args) {
  const child = spawnSync(process.execPath, [ree, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return child;
}

function runJson(args) {
  const child = run(args);
  let parsed = null;
  try {
    parsed = JSON.parse(child.stdout);
  } catch {
    parsed = null;
  }
  return { ...child, json: parsed };
}

test("agents help keeps the REA attribution and the old commands stay listed", () => {
  const agents = run(["agents", "--help"]);
  assert.equal(agents.status, 0);
  assert.match(agents.stdout, /morluto's REA engine \(MIT\)/);
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /node ree\.mjs agents/);
  assert.match(help.stdout, /node ree\.mjs pipeline/);
  assert.match(help.stdout, /node ree\.mjs rebuild/);
  assert.match(help.stdout, /node ree\.mjs outside-in/);
  const docs = readFileSync(join(root, "docs/agents.md"), "utf8");
  assert.match(docs, /morluto's REA engine \(MIT\)/);
  assert.match(docs, /ree_analyze/);
  assert.match(docs, /does not replace the inherited REA MCP/);
});

test(
  "a fixture runs analyze, findings, spec, rebuild, verify, package, and board post",
  { timeout: 120000 },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ree-agents-"));
    const runDir = join(scratch, "run");
    const productDir = join(scratch, "product");
    const boardDir = join(scratch, "board");
    try {
      const analyzed = runJson([
        "agents",
        "analyze",
        "--fixture",
        fixture,
        "--out",
        runDir,
        "--json",
      ]);
      assert.equal(analyzed.status, 0, analyzed.stderr);
      assert.equal(analyzed.json.schema_version, "ree.agent.v1");
      assert.equal(analyzed.json.step, "analyze");
      assert.equal(analyzed.json.ok, true);
      assert.equal(analyzed.json.result.rebuild, true);
      assert.ok(analyzed.json.result.feature_count > 0);

      const findings = runJson([
        "agents",
        "findings",
        "--run",
        runDir,
        "--json",
      ]);
      assert.equal(findings.status, 0, findings.stderr);
      assert.equal(
        findings.json.result.schema_version,
        "ree.pipeline.findings.v1",
      );
      assert.ok(findings.json.result.features.length > 0);

      const spec = runJson(["agents", "spec", "--run", runDir, "--json"]);
      assert.equal(spec.status, 0, spec.stderr);
      assert.equal(spec.json.result.target_name, "Widget Cloud");
      assert.equal(
        spec.json.result.feature_count,
        findings.json.result.features.length,
      );

      const rebuilt = runJson([
        "agents",
        "rebuild",
        "--spec",
        spec.json.result.path,
        "--name",
        "Desk Kit",
        "--out",
        productDir,
        "--json",
      ]);
      assert.equal(rebuilt.status, 0, rebuilt.stderr + rebuilt.stdout);
      assert.equal(typeof rebuilt.json.result.build_id, "string");
      assert.equal(rebuilt.json.result.package_path, null);

      const verified = runJson([
        "agents",
        "verify",
        "--project",
        productDir,
        "--json",
      ]);
      assert.equal(verified.status, 0, verified.stderr);
      assert.equal(verified.json.result.exit_code, 0);
      assert.equal(verified.json.result.failed, 0);
      assert.ok(verified.json.result.implemented > 0);

      const packed = runJson([
        "agents",
        "package",
        "--project",
        productDir,
        "--json",
      ]);
      assert.equal(packed.status, 0, packed.stderr);
      assert.match(packed.json.result.package_path, /product\.tgz$/);

      const posted = runJson([
        "agents",
        "board-post",
        "--spec",
        spec.json.result.path,
        "--data",
        boardDir,
        "--json",
      ]);
      assert.equal(posted.status, 0, posted.stderr);
      assert.equal(posted.json.result.posted.target_name, "Widget Cloud");
      assert.match(posted.json.result.note, /Guard was not called/);
      assert.match(posted.json.result.note, /Blast was not notified/);

      const empty = join(scratch, "empty.json");
      writeFileSync(empty, JSON.stringify({ features: [] }));
      const refused = runJson([
        "agents",
        "rebuild",
        "--spec",
        empty,
        "--name",
        "Desk Kit",
        "--out",
        join(scratch, "refused"),
        "--json",
      ]);
      assert.equal(refused.status, 2);
      assert.equal(refused.json.ok, false);
      assert.match(refused.json.error, /does not support a rebuild/);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [ree, "agents", "mcp"],
        cwd: root,
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => undefined);
      const client = new Client({ name: "ree-agents-test", version: "1" });
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        const names = listed.tools.map((tool) => tool.name).sort();
        assert.deepEqual(names, [
          "ree_analyze",
          "ree_board_post",
          "ree_findings",
          "ree_package",
          "ree_rebuild",
          "ree_spec",
          "ree_verify",
        ]);
        const called = await client.callTool({
          name: "ree_findings",
          arguments: { runDir },
        });
        const body = JSON.parse(called.content[0].text);
        assert.equal(body.schema_version, "ree.agent.v1");
        assert.equal(body.step, "findings");
        assert.equal(body.ok, true);
        assert.equal(
          body.result.features.length,
          findings.json.result.features.length,
        );
      } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
