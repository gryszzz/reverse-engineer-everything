import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { compareEdgeIds, compareSummaries } from "./diff.mjs";
import { projectApplicationGraph, relationshipBasis } from "./graph.mjs";
import { renderStudioReport } from "./report.mjs";
import { runLocalResearch } from "./research.mjs";
import { readRecordedSource } from "./source.mjs";

const directory = mkdtempSync(join(tmpdir(), "ree-studio-graph-"));
after(() => rmSync(directory, { recursive: true, force: true }));

function evidence() {
  return {
    operation: "analyze_javascript_application",
    evidence_id: `ev_${"a".repeat(64)}`,
    limitations: ["Static relationships do not prove execution."],
    normalized_result: {
      root_artifact_sha256: "b".repeat(64),
      statistics: { parsed_javascript_files: 2, parse_failures: 0 },
      limitations: [],
      graph: {
        graph_id: "graph",
        coverage: { status: "complete", truncated: false },
        limitations: [],
        nodes: [
          {
            node_id: "cli",
            kind: "javascript-module",
            identity: { strategy: "canonical-path", path: "cli.mjs" },
            observations: [],
          },
          {
            node_id: "search",
            kind: "javascript-module",
            identity: { strategy: "canonical-path", path: "search.mjs" },
            observations: [],
          },
        ],
        edges: [
          {
            edge_id: "edge-import",
            source_node_id: "cli",
            target_node_id: "search",
            relation: "imports",
            evidence: {
              state: "inferred",
              confidence: "high",
              authority: "static-relationship-inference",
              location: {
                available: true,
                value: {
                  kind: "source-range",
                  source: "cli.mjs",
                  start: { line: 1, column: 0 },
                },
              },
              limitations: [],
            },
          },
          {
            edge_id: "edge-observed",
            source_node_id: "cli",
            target_node_id: "cli",
            relation: "contains",
            evidence: {
              state: "observed",
              confidence: "observed",
              authority: "runtime-observation",
              location: { available: false },
            },
          },
        ],
      },
      semantic_graph: {
        graph_id: "semantic",
        application_graph_id: "graph",
        root_artifact_sha256: "b".repeat(64),
        coverage: { status: "unknown", truncated: false },
        nodes: [],
        relations: [],
        evidence_contexts: [],
      },
    },
  };
}

test("the graph window is a subset of stored edges and keeps their basis", () => {
  const record = evidence();
  const window = projectApplicationGraph(record, { limit: 10 });
  const ids = new Set(
    record.normalized_result.graph.edges.map((edge) => edge.edge_id),
  );
  assert.equal(window.edges.length, 2);
  assert.equal(
    window.edges.every((edge) => ids.has(edge.edge_id)),
    true,
  );
  assert.equal(
    window.edges.find((edge) => edge.edge_id === "edge-import").basis,
    "inferred",
  );
  assert.match(
    window.edges[0].interpretation,
    /not a captured execution|still static/,
  );
  const inferred = projectApplicationGraph(record, { basis: "inferred" });
  assert.deepEqual(
    inferred.edges.map((edge) => edge.edge_id),
    ["edge-import"],
  );
  assert.equal(
    relationshipBasis({ confidence: "observed", state: "observed" }),
    "observed",
  );
  assert.equal(
    window.execution_note.includes("not observed executions") ||
      window.execution_note.includes("not invented"),
    true,
  );
});

test("source excerpts stay inside the analyzed directory", () => {
  const target = join(directory, "app");
  mkdirSync(target);
  writeFileSync(join(target, "cli.mjs"), 'import "./search.mjs";\n');
  const record = evidence();
  const excerpt = readRecordedSource(record, "edge-import", target);
  assert.equal(excerpt.available, true);
  assert.match(
    excerpt.lines.find((line) => line.highlighted).text,
    /search\.mjs/,
  );
  assert.throws(() => {
    const escaped = evidence();
    escaped.normalized_result.graph.edges[0].evidence.location.value.source =
      "../secret";
    readRecordedSource(escaped, "edge-import", target);
  }, /outside the analyzed target/);
});

test("local research restates tool results and refuses remote calls", () => {
  const session = runLocalResearch({
    enabled: true,
    project: {
      question: "Which files import search?",
      artifacts: [
        {
          path: "/owned",
          intake: {
            kind: "javascript",
            label: "JavaScript / Electron",
            capability: "static-supported",
            basis: "directory markers",
          },
        },
      ],
    },
    record: evidence(),
  });
  assert.equal(session.remote_calls, "refused");
  assert.ok(session.tool_calls <= 8);
  assert.equal(
    session.facts.some((item) => item.fact.includes(`ev_${"a".repeat(64)}`)),
    true,
  );
  assert.equal(session.hypotheses.length, 0);
  assert.equal(
    session.stages.find((stage) => stage.id === "VERIFIER").status,
    "not-run",
  );
  const disabled = runLocalResearch({
    enabled: false,
    project: { artifacts: [] },
  });
  assert.equal(disabled.stages.length, 0);
});

test("diff and report use retained counts without adding edges", () => {
  const diff = compareSummaries(
    {
      evidence_id: "ev_left",
      counts: { nodes: 2, edges: 2 },
      relationships: { imports: 1 },
    },
    {
      evidence_id: "ev_right",
      counts: { nodes: 2, edges: 3 },
      relationships: { imports: 2 },
    },
  );
  assert.deepEqual(diff.relationship_deltas, [
    { relation: "imports", left: 1, right: 2 },
  ]);
  const edges = compareEdgeIds(["edge-import"], ["edge-import", "edge-new"]);
  assert.deepEqual(edges.only_right, ["edge-new"]);
  assert.equal(edges.only_left.length, 0);
  const report = renderStudioReport({
    name: "Sample",
    question: null,
    mode: "simple",
    artifacts: [],
    runs: [],
    experiments: [],
    research_sessions: [],
  });
  assert.match(report, /No static analysis has been run/);
  assert.doesNotMatch(report, /ev_[a-f0-9]{64}/u);
});
