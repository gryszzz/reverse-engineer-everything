import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownReport, summarizeEvidence } from "./report.mjs";

const fixture = () => ({
  evidence_id: "ev_fixture",
  operation: "analyze_javascript_application",
  provider: { id: "rea.javascript-application" },
  normalized_result: {
    root_artifact_sha256: "a".repeat(64),
    statistics: { modules: 3, parsed_javascript_files: 3, parse_failures: 0 },
    graph: {
      graph_id: "jag_fixture",
      coverage: { status: "complete" },
      nodes: [{ kind: "javascript-module" }, { kind: "javascript-module" }],
      edges: [{ relation: "imports" }],
      limitations: [],
    },
    semantic_graph: {
      graph_id: "jsg_fixture",
      application_graph_id: "jag_fixture",
      root_artifact_sha256: "a".repeat(64),
    },
  },
});

test("evidence becomes a bounded, explicitly static report", () => {
  const summary = summarizeEvidence(fixture());
  assert.equal(summary.counts.nodes, 2);
  assert.equal(summary.counts.edges, 1);
  assert.equal(summary.relationships.imports, 1);
  assert.equal(summary.counts.parse_failures, 0);
  assert.match(markdownReport(summary), /not runtime proof/);
});

test("fail closed on error payload and missing or mismatched graphs", () => {
  assert.throws(() => summarizeEvidence({ error: "failed" }), /error/);
  const missing = fixture();
  delete missing.normalized_result.graph;
  assert.throws(() => summarizeEvidence(missing), /Missing REA/);
  const mismatch = fixture();
  mismatch.normalized_result.semantic_graph.application_graph_id = "another";
  assert.throws(() => summarizeEvidence(mismatch), /not bound/);
  const differentArtifact = fixture();
  differentArtifact.normalized_result.semantic_graph.root_artifact_sha256 =
    "f".repeat(64);
  assert.throws(() => summarizeEvidence(differentArtifact), /does not match/);
});
