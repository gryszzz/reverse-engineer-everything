import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import {
  asDot,
  asSemanticText,
  asText,
  createSemanticEvidenceSearcher,
  exploreEvidence,
  exploreSemanticEvidence,
  readEvidence,
  readSemanticEvidence,
} from "./evidence-explorer.mjs";

const directory = mkdtempSync(join(tmpdir(), "rel-explorer-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const saved = () => ({
  operation: "analyze_javascript_application",
  evidence_id: "ev_sample",
  normalized_result: {
    root_artifact_sha256: "a".repeat(64),
    graph: {
      graph_id: "app",
      coverage: { status: "complete" },
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
          source_node_id: "cli",
          target_node_id: "search",
          relation: "imports",
          evidence: {
            location: {
              available: true,
              value: {
                kind: "source-range",
                source: "cli.mjs",
                start: { line: 2, column: 0 },
                end: { line: 2, column: 20 },
              },
            },
            state: "inferred",
            confidence: "high",
            authority: "static-relationship-inference",
          },
        },
        {
          source_node_id: "cli",
          target_node_id: "unknown",
          relation: "contains",
          evidence: { location: { available: false } },
        },
      ],
    },
    semantic_graph: {
      graph_id: "semantic",
      application_graph_id: "app",
      root_artifact_sha256: "a".repeat(64),
      coverage: { status: "unknown" },
      nodes: [
        { node_id: "source-1", kind: "binding", label: "menuButton" },
        { node_id: "handler", kind: "function", label: "click handler" },
      ],
      relations: [
        {
          relation_id: "semantic-relation-1",
          relation: "captures",
          source_node_id: "source-1",
          target_node_id: "handler",
          resolution: "resolved",
          evidence: {
            context_id: "semantic-context-1",
            location: {
              available: true,
              value: {
                kind: "source-range",
                source: "script.js",
                start: { line: 7, column: 0 },
                end: { line: 7, column: 20 },
              },
            },
          },
        },
      ],
      evidence_contexts: [
        {
          context_id: "semantic-context-1",
          state: "inferred",
          confidence: "high",
          authority: "static-relationship-inference",
          extractor: { name: "rea-javascript-semantic-analysis" },
          limitations: [],
        },
      ],
    },
  },
});

test("shows recorded graph links without claiming observed execution", () => {
  const result = exploreEvidence(saved());
  assert.equal(result.matching, 2);
  assert.equal(result.edges[0].source.label, "cli.mjs");
  assert.equal(result.edges[0].target.label, "search.mjs");
  assert.equal(JSON.parse(result.edges[0].location).start.line, 2);
  assert.equal(result.edges[0].confidence, "high");
  assert.equal(result.edges[1].location, null);
  assert.match(asText(result), /not runtime execution/);
  assert.match(asText(result), /not provided/);
});

test("supports bounded investigation filters with explicit truncation", () => {
  assert.equal(exploreEvidence(saved(), { find: "search.mjs" }).matching, 1);
  assert.equal(exploreEvidence(saved(), { find: "inferred" }).matching, 1);
  assert.equal(exploreEvidence(saved(), { find: "evidence" }).matching, 0);
  assert.equal(exploreEvidence(saved(), { find: "confidence" }).matching, 0);
  assert.equal(exploreEvidence(saved(), { find: "absent" }).matching, 0);
  const r = exploreEvidence(saved(), { limit: 1 });
  assert.equal(r.displayed, 1);
  assert.equal(r.matching, 2);
  assert.equal(r.truncated, true);
  assert.match(asDot(r), /digraph REE/);
  assert.match(asDot(r), /"cli" -> "search"/);
  assert.throws(() => exploreEvidence(saved(), { limit: 41 }), /limit must/);
});

test("searches semantic relations separately and preserves their source Evidence", () => {
  const result = exploreSemanticEvidence(saved(), { find: "menu", limit: 1 });
  const search = createSemanticEvidenceSearcher(saved());
  assert.equal(
    result.status,
    "saved-static-semantic-evidence-not-runtime-proof",
  );
  assert.equal(result.evidence_id, "ev_sample");
  assert.equal(result.semantic_graph_id, "semantic");
  assert.equal(result.counts.nodes, 2);
  assert.equal(result.counts.relations, 1);
  assert.equal(result.matching, 1);
  assert.equal(result.relations[0].source.label, "menuButton");
  assert.equal(result.relations[0].target.label, "click handler");
  assert.equal(result.relations[0].relation, "captures");
  assert.equal(result.relations[0].resolution, "resolved");
  assert.equal(result.relations[0].state, "inferred");
  assert.equal(result.relations[0].confidence, "high");
  assert.equal(result.relations[0].authority, "static-relationship-inference");
  assert.equal(JSON.parse(result.relations[0].location).source, "script.js");
  assert.equal(exploreEvidence(saved(), { find: "menu" }).matching, 0);
  assert.equal(search({ find: "menu" }).matching, 1);
  assert.equal(
    search({ find: "script.js" }).relations[0].relation_id,
    "semantic-relation-1",
  );
  assert.match(asSemanticText(result), /script\.js:7:0/u);
  assert.match(
    asSemanticText(result),
    /do not establish execution or behavior/u,
  );
  assert.equal(
    exploreSemanticEvidence(saved(), { find: "aria-expanded" }).matching,
    0,
  );
});

test("semantic search matches identifier words and summarizes large coverage", () => {
  const record = saved();
  const graph = record.normalized_result.semantic_graph;
  graph.coverage = {
    status: "unknown",
    truncated: false,
    omitted_nodes: 0,
    omitted_relations: 0,
    families: [
      {
        family: "call-flow",
        status: "partial",
        retained_relations: 1,
        omitted_relations: 0,
        unknown_ids: ["unknown-1", "unknown-2"],
      },
    ],
  };
  graph.nodes.push({ node_id: "closest", kind: "binding", label: "closest" });
  graph.relations.push({
    relation_id: "semantic-relation-2",
    relation: "reads-property",
    source_node_id: "handler",
    target_node_id: "closest",
    resolution: "candidate",
    evidence: {
      context_id: "semantic-context-1",
      location: { available: false },
    },
  });

  const search = createSemanticEvidenceSearcher(record);
  const menu = search({ find: "menu" });
  assert.equal(menu.matching, 1);
  assert.equal(search({ find: "close" }).matching, 0);
  assert.equal(search({ find: "closest" }).matching, 1);
  assert.equal(menu.coverage.families[0].unknown_count, 2);
  assert.equal("unknown_ids" in menu.coverage.families[0], false);
  assert.equal(JSON.stringify(menu.coverage).includes("unknown-1"), false);
});

test("missing semantic relationships remain unavailable rather than an empty search", () => {
  const record = saved();
  delete record.normalized_result.semantic_graph.nodes;
  delete record.normalized_result.semantic_graph.relations;
  const result = exploreSemanticEvidence(record, { find: "menu" });
  assert.equal(result.status, "semantic-graph-unavailable");
  assert.equal(result.matching, null);
  assert.match(asSemanticText(result), /does not expose semantic relations/u);
});

test("rejects false-success and inconsistent evidence", () => {
  const failed = saved();
  failed.error = { code: "failed" };
  assert.throws(() => exploreEvidence(failed), /REA returned an error/);
  const broken = saved();
  broken.normalized_result.semantic_graph.application_graph_id = "wrong";
  assert.throws(() => exploreEvidence(broken), /not bound/);
});

test("read-only CLI emits JSON and DOT from a saved local file", () => {
  const file = join(directory, "evidence.json");
  const record = saved();
  record.normalized_result.semantic_graph.coverage = {
    status: "unknown",
    families: [
      {
        family: "call-flow",
        status: "partial",
        unknown_ids: ["full-evidence-unknown-id"],
      },
    ],
  };
  writeFileSync(file, JSON.stringify(record));
  assert.equal(readEvidence(file).edges.length, 2);
  const executable = fileURLToPath(
    new URL("./evidence-explorer.mjs", import.meta.url),
  );
  const run = (...args) =>
    spawnSync(process.execPath, [executable, file, ...args], {
      encoding: "utf8",
    });
  const json = run("--find", "search.mjs", "--json");
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).matching, 1);
  const semantic = run("--semantic", "--find", "menu", "--json");
  assert.equal(semantic.status, 0, semantic.stderr);
  const semanticResult = JSON.parse(semantic.stdout);
  assert.equal(semanticResult.matching, 1);
  assert.equal(semanticResult.relations[0].relation_id, "semantic-relation-1");
  assert.equal(semanticResult.coverage.families[0].unknown_count, 1);
  assert.doesNotMatch(semantic.stdout, /full-evidence-unknown-id|unknown_ids/u);
  assert.match(run("--dot").stdout, /digraph REE/);
  const semanticDot = run("--semantic", "--dot");
  assert.equal(semanticDot.status, 2);
  assert.match(semanticDot.stderr, /application graph only/u);
  assert.equal(run("--unauthorized").status, 2);
});

test("rejects oversized Evidence files before reading or parsing them", () => {
  const file = join(directory, "oversized-evidence.json");
  writeFileSync(file, "");
  truncateSync(file, 64 * 1024 * 1024 + 1);

  assert.throws(
    () => readEvidence(file),
    /Evidence must be a regular JSON file of at most 64 MiB/u,
  );
  assert.throws(
    () => readSemanticEvidence(file),
    /Evidence must be a regular JSON file of at most 64 MiB/u,
  );
});
