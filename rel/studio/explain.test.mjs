import assert from "node:assert/strict";
import { test } from "node:test";
import { explainSubject } from "./public/explain.js";

test("a finding with no Evidence id is not stated as a fact", () => {
  const result = explainSubject({
    kind: "finding",
    text: "This feature starts in settings.",
  });
  assert.equal(result.source, "local-template");
  assert.equal(result.model, null);
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.hypotheses, []);
  assert.deepEqual(result.evidence_ids, []);
  assert.match(result.unknowns[0], /cites no Evidence id/);
  assert.match(result.unknowns[1], /withheld/);
});

test("an edge explanation quotes only stored relationship fields", () => {
  const result = explainSubject({
    kind: "edge",
    relation: "imports",
    source: { label: "cli.mjs" },
    target: { label: "search.mjs" },
    state: "inferred",
    confidence: "inferred",
    authority: "static-relationship-inference",
    basis: "inferred",
    interpretation: "Static inference. This is not a captured execution.",
    evidence_id: "ev_abc",
    limitations: ["Import resolution did not execute the module."],
  });
  assert.match(result.facts[0], /cli\.mjs -\[imports\]-> search\.mjs/);
  assert.ok(result.facts.some((fact) => fact.includes("ev_abc")));
  assert.deepEqual(result.evidence_ids, ["ev_abc"]);
  assert.match(result.unknowns[0], /not an observed execution/);
  assert.match(result.text, /not an observed execution/);
  assert.deepEqual(result.hypotheses, []);
});

test("a function name without a body stays unknown", () => {
  const result = explainSubject({
    kind: "function",
    label: "rank",
    id: "fn_rank",
    evidence_id: "ev_rank",
  });
  assert.match(result.facts[0], /function “rank”/);
  assert.ok(result.unknowns.some((item) => /behavior is unknown/.test(item)));
  assert.equal(result.model, null);
});

test("a module explanation does not claim the source was copied", () => {
  const result = explainSubject({
    kind: "module",
    label: "search.mjs",
    node_kind: "javascript-module",
    evidence_id: "ev_mod",
  });
  assert.match(result.facts.join(" "), /javascript-module/);
  assert.ok(
    result.unknowns.some((item) => /not a copy of its source/.test(item)),
  );
});

test("an unknown selection explains nothing", () => {
  const result = explainSubject({ kind: "behavior", label: "invented" });
  assert.deepEqual(result.facts, []);
  assert.match(result.unknowns[0], /No explainable subject/);
});
