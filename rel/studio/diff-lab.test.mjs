import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareLab, factsFromEvidence } from "./diff.mjs";
import { diffArtifactPair } from "./diff-lab.mjs";

test("missing function and string identities stay unknown", () => {
  const result = compareLab(
    {
      label: "left",
      evidence_id: "ev_left",
      files: ["a.mjs"],
      evidence_files: ["a.mjs"],
      functions: null,
      dependencies: ["edge-1"],
      strings: null,
    },
    {
      label: "right",
      evidence_id: "ev_right",
      files: ["a.mjs", "b.mjs"],
      evidence_files: ["a.mjs"],
      functions: null,
      dependencies: ["edge-1", "edge-2"],
      strings: null,
    },
  );
  assert.equal(result.kind, "diff-lab");
  assert.deepEqual(result.structural.only_right, ["b.mjs"]);
  assert.equal(result.functions.status, "unknown");
  assert.equal(result.strings.status, "unknown");
  assert.deepEqual(result.dependencies.only_right, ["edge-2"]);
  assert.equal(result.behavior.status, "unknown");
  assert.match(result.behavior.reason, /do not establish a behavior change/);
});

test("a graph without function nodes does not become an empty function diff", () => {
  const facts = factsFromEvidence({
    evidence_id: "ev_js",
    normalized_result: {
      graph: {
        nodes: [
          {
            node_id: "n1",
            kind: "javascript-module",
            identity: { strategy: "canonical-path", path: "search.mjs" },
          },
        ],
        edges: [{ edge_id: "e1", relation: "imports" }],
      },
    },
  });
  assert.equal(facts.functions, null);
  assert.equal(facts.strings, null);
  assert.deepEqual(facts.evidence_files, ["search.mjs"]);
  assert.deepEqual(facts.dependencies, ["e1"]);
});

test("two owned C files produce a text diff and unknown behavior", () => {
  const root = fileURLToPath(
    new URL("../../experiments/ree-investigation-boundary/", import.meta.url),
  );
  const result = diffArtifactPair({
    left: { path: `${root}authority.c`, label: "authority.c" },
    right: { path: `${root}candidate.c`, label: "candidate.c" },
  });
  assert.equal(result.behavior.status, "unknown");
  assert.equal(result.text.status, "shown");
  assert.match(result.text.lines.join("\n"), /floor/);
  assert.match(result.text.note, /behavior is unknown/);
  assert.equal(result.functions.status, "unknown");
});
