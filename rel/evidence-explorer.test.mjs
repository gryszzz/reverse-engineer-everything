import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import {
  asDot,
  asText,
  exploreEvidence,
  readEvidence,
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
  assert.equal(exploreEvidence(saved(), { find: "absent" }).matching, 0);
  const r = exploreEvidence(saved(), { limit: 1 });
  assert.equal(r.displayed, 1);
  assert.equal(r.matching, 2);
  assert.equal(r.truncated, true);
  assert.match(asDot(r), /digraph REE/);
  assert.match(asDot(r), /"cli" -> "search"/);
  assert.throws(() => exploreEvidence(saved(), { limit: 41 }), /limit must/);
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
  writeFileSync(file, JSON.stringify(saved()));
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
  assert.match(run("--dot").stdout, /digraph REE/);
  assert.equal(run("--unauthorized").status, 2);
});
