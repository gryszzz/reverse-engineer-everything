import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  realpathSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  investigationReport,
  planStaticAnalysis,
  repository,
} from "./analyze-static.mjs";
import { summarizeAnalysisView } from "./evidence-summary.mjs";

const home = mkdtempSync(join(tmpdir(), "rel-generic-test-"));
const fixture = join(home, "owned-fixture");
mkdirSync(fixture);
writeFileSync(
  join(fixture, "example.mjs"),
  'import { answer } from "./helper.mjs";\nexport { answer };\n',
);
writeFileSync(join(fixture, "helper.mjs"), "export const answer = 42;\n");
const sourceFile = join(fixture, "example.mjs");
const webCapture = join(home, "test.har");
writeFileSync(webCapture, "{}");
const cli = fileURLToPath(new URL("../ree.mjs", import.meta.url));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

test("authorization must be explicit even for a source-owned fixture", () => {
  assert.throws(
    () => planStaticAnalysis(fixture, join(home, "output"), false),
    /--authorized/,
  );
});

test("regular JavaScript source file is not an extracted application", () => {
  assert.throws(
    () => planStaticAnalysis(sourceFile, join(home, "output"), true),
    /directory or ASAR/,
  );
});

test("the beginner command does not run websites or unknown file formats", () => {
  assert.throws(
    () => planStaticAnalysis("https://example.org", join(home, "output"), true),
    /static JavaScript/,
  );
  assert.throws(
    () => planStaticAnalysis(webCapture, join(home, "output"), true),
    /static JavaScript/,
  );
});

test("output may not be placed in the target, nor contain the target", () => {
  assert.throws(
    () => planStaticAnalysis(fixture, join(fixture, "evidence"), true),
    /outside/,
  );
  assert.throws(() => planStaticAnalysis(fixture, home, true), /outside/);
});

test("output may not be placed inside the REE repository", () => {
  assert.throws(
    () => planStaticAnalysis(fixture, join(repository, "evidence"), true),
    /outside/,
  );
});

test("existing output is not overwritten", () => {
  const prior = join(home, "prior");
  mkdirSync(prior);
  assert.throws(
    () => planStaticAnalysis(fixture, prior, true),
    /already exists/,
  );
});

test("symlinked targets are rejected before analysis", () => {
  const link = join(home, "linked");
  symlinkSync(fixture, link);
  assert.throws(
    () => planStaticAnalysis(link, join(home, "output"), true),
    /Symbolic/,
  );
});

test("valid static analysis gets an exact canonical plan after build", () => {
  const plan = planStaticAnalysis(fixture, join(home, "fresh-results"), true);
  assert.equal(plan.format, "directory");
  assert.equal(plan.target, realpathSync(fixture));
  assert.equal(plan.output, join(realpathSync(home), "fresh-results"));
});

test("plain-English report does not confuse static data with runtime proof", () => {
  const record = {
    input_path: fixture,
    question: "How is a search implemented?",
    evidence_id: "ev_local",
    artifact_sha256: "a".repeat(64),
    application_graph_id: "jag_local",
    provider: "rea-js",
    graph_coverage: { status: "partial" },
    semantic_coverage: { status: "unknown" },
    counts: { nodes: 4, edges: 1, files_parsed: 1, parse_failures: 0 },
    relationships: { imports: 1 },
    node_kinds: { module: 2 },
    limitations: ["Source maps unavailable"],
  };
  const report = investigationReport(record);
  assert.match(report, /Question:\*\* How is a search implemented/);
  assert.match(report, /unknown/);
  assert.match(report, /does not prove runtime behavior/);
  assert.match(report, /Source maps unavailable/);
});

test("Codex status command is informational and has no configuration side effects", () => {
  const output = execFileSync(process.execPath, [cli, "codex"], {
    encoding: "utf8",
  });
  assert.match(output, /Codex workspace configuration/);
  assert.match(output, /Only this REE fork/);
});

test("arbitrary analysis without authorization is refused", () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [cli, "analyze", fixture, "--out", join(home, "blocked")],
        { stdio: "pipe", encoding: "utf8" },
      ),
    /--authorized/,
  );
});

test("real REE command retains complete Evidence once and reports the authenticated summary", () => {
  const output = join(home, "real-analysis");
  execFileSync(
    process.execPath,
    [cli, "analyze", fixture, "--authorized", "--out", output],
    { stdio: "pipe" },
  );
  const read = (name) => JSON.parse(readFileSync(join(output, name), "utf8"));
  const full = read("evidence.json");
  const view = read("view-evidence.json");
  const summary = read("summary.json");
  assert.equal(summary.evidence_id, full.evidence_id);
  assert.equal(summary.view_evidence_id, view.evidence_id);
  assert.equal(summary.counts.nodes, full.normalized_result.graph.nodes.length);
  assert.equal(summary.counts.edges, full.normalized_result.graph.edges.length);
  assert.equal(
    summary.application_graph_id,
    full.normalized_result.graph.graph_id,
  );
  assert.equal(
    summary.semantic_graph_id,
    full.normalized_result.semantic_graph.graph_id,
  );
  assert.equal(
    summary.artifact_sha256,
    full.normalized_result.root_artifact_sha256,
  );
  assert.deepEqual(
    summary.graph_coverage,
    full.normalized_result.graph.coverage,
  );
  assert.equal(existsSync(join(output, "summary-request.json")), false);
  assert.ok(Array.isArray(summary.unknowns));
  const explored = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(repository, "rel/evidence-explorer.mjs"),
        join(output, "evidence.json"),
        "--find",
        "helper.mjs",
        "--json",
      ],
      { encoding: "utf8" },
    ),
  );
  const imported = explored.edges.find(
    (edge) =>
      edge.relation === "imports" &&
      edge.source.label === "example.mjs" &&
      edge.target.label === "helper.mjs",
  );
  assert.ok(imported, "Real saved graph must expose its import relationship");
  assert.equal(imported.source.label, "example.mjs");
  assert.equal(imported.target.label, "helper.mjs");
  const rawEdge = full.normalized_result.graph.edges.find(
    (edge) => edge.edge_id === imported.edge_id,
  );
  assert.equal(imported.source.id, rawEdge.source_node_id);
  assert.equal(imported.target.id, rawEdge.target_node_id);
  assert.deepEqual(
    JSON.parse(imported.location),
    rawEdge.evidence.location.value,
  );
  assert.equal(JSON.parse(imported.location).source, "example.mjs");
  assert.equal(imported.authority, rawEdge.evidence.authority);
  assert.equal(imported.state, rawEdge.evidence.state);
  assert.equal(imported.confidence, rawEdge.evidence.confidence);
  const original = readFileSync(join(output, "evidence.json"), "utf8");
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [cli, "analyze", fixture, "--authorized", "--out", output],
        { stdio: "pipe" },
      ),
    /already exists/,
  );
  assert.equal(readFileSync(join(output, "evidence.json"), "utf8"), original);

  const wrongParent = structuredClone(view);
  wrongParent.parameters.parent_evidence_id = "other";
  assert.throws(() => summarizeAnalysisView(wrongParent), /not bound/);
  const wrongCounts = structuredClone(view);
  wrongCounts.normalized_result.summary.graph_summary.nodes += 1;
  assert.throws(() => summarizeAnalysisView(wrongCounts), /inconsistent/);
  const wrongArtifact = structuredClone(view);
  wrongArtifact.normalized_result.artifact.sha256 = "different";
  assert.throws(() => summarizeAnalysisView(wrongArtifact), /source artifact/);
  assert.throws(
    () => summarizeAnalysisView({ error: "analysis failed" }),
    /no report/,
  );
});
