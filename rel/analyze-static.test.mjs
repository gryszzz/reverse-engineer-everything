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
import { questionSearchTerms } from "./question-guidance.mjs";

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
  assert.match(report, /--find 'search'/u);
  assert.match(report, /No match means no recorded relationship matched/u);
  assert.match(report, /did not launch the target/u);
  assert.match(report, /does not show that the feature or behavior is absent/u);
  assert.match(report, /No automatic Evidence preview was available/u);
});

test("report exposes bounded literal Evidence matches with provenance and limits", () => {
  const report = investigationReport({
    input_path: fixture,
    question: "How does search load?",
    evidence_id: "ev_test",
    artifact_sha256: "a".repeat(64),
    application_graph_id: "jag_test",
    counts: { nodes: 2, edges: 1 },
    relationships: { imports: 1 },
    node_kinds: { module: 2 },
    limitations: [],
    question_evidence_preview: {
      status: "searched",
      queries: [
        {
          term: "search",
          matching: 4,
          displayed: 1,
          truncated: true,
          edges: [
            {
              edge_id: "edge_test",
              relation: "imports",
              source: "entry.mjs",
              target: "search.mjs",
              location: '{"source":"entry.mjs","start":{"line":7,"column":0}}',
              state: "inferred",
              confidence: "high",
              authority: "static-relationship-inference",
            },
          ],
        },
      ],
    },
  });
  assert.match(report, /4 recorded relationships matched; showing 1/u);
  assert.match(report, /`entry\.mjs` --\[imports\]--> `search\.mjs`/u);
  assert.match(report, /`entry\.mjs:7`/u);
  assert.match(report, /`static-relationship-inference`/u);
  assert.match(report, /edge `edge_test`/u);
  assert.match(report, /Additional matches are available/u);
  assert.match(report, /not semantic answers or proof of runtime execution/u);
});

test("large Evidence skips automatic previews without losing saved Evidence", () => {
  const report = investigationReport({
    input_path: fixture,
    question: "How does search work?",
    evidence_id: "ev_test",
    artifact_sha256: "a".repeat(64),
    application_graph_id: "jag_test",
    counts: { nodes: 1, edges: 0 },
    relationships: {},
    node_kinds: {},
    limitations: [],
    question_evidence_preview: {
      status: "skipped-evidence-exceeds-explorer-limit",
      evidence_bytes: 100,
      max_evidence_bytes: 64,
      queries: [],
    },
  });
  assert.match(report, /Automatic preview skipped/u);
  assert.match(report, /Use REA's bounded analysis views/u);
  assert.match(report, /exceeds the local explorer limit/u);
});

test("report keeps coverage compact and avoids repeating limitations as unknowns", () => {
  const record = {
    input_path: "/tmp/fixture",
    question: "How does behavior work?",
    evidence_id: "ev_test",
    artifact_sha256: "a".repeat(64),
    application_graph_id: "jag_test",
    graph_coverage: { status: "complete", truncated: false, omitted_count: 0 },
    semantic_coverage: {
      status: "unknown",
      families: [{ unknown_count: 3 }],
    },
    counts: { nodes: 1, edges: 0 },
    relationships: {},
    node_kinds: {},
    limitations: ["Known limitation"],
    unknowns: ["Known limitation", "Unresolved path", "Unresolved path"],
  };
  const report = investigationReport(record);
  assert.match(report, /Graph coverage: status complete; not truncated/u);
  assert.match(
    report,
    /Semantic coverage: status unknown; 3 family-level unknowns/u,
  );
  assert.equal(report.split("Known limitation").length - 1, 1);
  assert.equal(report.split("Unresolved path").length - 1, 1);
  assert.doesNotMatch(report, /families.*unknown_count/u);
});

test("untrusted question text stays escaped in the Markdown report", () => {
  const record = {
    input_path: "/tmp/fixture",
    question: "Read <script> [private](https://example.org)",
    evidence_id: "ev_test",
    artifact_sha256: "a".repeat(64),
    application_graph_id: "jag_test",
    counts: { nodes: 1, edges: 0 },
    relationships: {},
    node_kinds: {},
    limitations: [],
  };
  const report = investigationReport(record);
  assert.doesNotMatch(report, /<script>|\[private\]\(https:/u);
  assert.match(report, /\\\[private\\\]/u);
});

test("question terms are bounded, deduplicated and safe to place in shell examples", () => {
  assert.deepEqual(
    questionSearchTerms(
      "How does settings load settings? Is <script> used? Also config/path_name and preferences",
    ),
    ["settings", "load", "script", "used", "config/path_name"],
  );
  assert.deepEqual(questionSearchTerms("¿Dónde está café?"), [
    "dónde",
    "está",
    "café",
  ]);
  assert.deepEqual(
    questionSearchTerms(
      "How does the static route present source Evidence to a newcomer?",
    ),
    ["evidence"],
  );
  assert.deepEqual(
    questionSearchTerms(
      "Which static relationships explain the source-owned search demo?",
    ),
    ["search"],
  );
  assert.deepEqual(questionSearchTerms(null), []);
  assert.deepEqual(questionSearchTerms("a".repeat(161)), []);
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
    [
      cli,
      "analyze",
      fixture,
      "--authorized",
      "--out",
      output,
      "--question",
      "How does example import helper.mjs?",
    ],
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
  assert.deepEqual(summary.question_search_terms, [
    "example",
    "import",
    "helper.mjs",
  ]);
  assert.equal(summary.question_evidence_preview.status, "searched");
  const importMatches = summary.question_evidence_preview.queries.find(
    (query) => query.term === "import",
  );
  assert.ok(importMatches.matching >= 1);
  const helperImport = importMatches.edges.find(
    (edge) =>
      edge.relation === "imports" &&
      edge.source === "example.mjs" &&
      edge.target === "helper.mjs",
  );
  assert.ok(helperImport, "The bounded preview should show the helper import");
  assert.match(helperImport.location, /example\.mjs/);
  const markdown = readFileSync(join(output, "REE_EVIDENCE_REPORT.md"), "utf8");
  assert.match(markdown, /--find 'helper\.mjs'/u);
  assert.match(markdown, /did not launch the target/u);
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
