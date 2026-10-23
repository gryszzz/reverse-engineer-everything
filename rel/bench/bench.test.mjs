import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMarkdown } from "../outside-in/extract-markdown.mjs";
import {
  elfFindings,
  goFindings,
  javascriptFindings,
  peResourceFindings,
  rustFindings,
} from "./extract.mjs";
import { scoreFindings, scorePasses, scoreType } from "./score.mjs";

test("precision is 1 when nothing false is claimed and recall counts misses", () => {
  const empty = scoreType(["a"], []);
  assert.equal(empty.precision, 1);
  assert.equal(empty.recall, 0);
  assert.deepEqual(empty.missed, ["a"]);
  const mixed = scoreType(["a", "b"], ["b", "c"]);
  assert.equal(mixed.precision, 0.5);
  assert.equal(mixed.recall, 0.5);
  assert.deepEqual(mixed.false_claims, ["c"]);
  const unused = scoreType([], []);
  assert.equal(unused.precision, null);
  assert.equal(unused.recall, null);
});

test("a false claim fails even when recall is not gated", () => {
  const scores = scoreFindings(
    { call: ["main.mjs:run->filter.mjs:filterByTag"] },
    { call: ["main.mjs:run->missing.mjs:nope"] },
  );
  const failures = scorePasses(scores, { call: { precision: 1, recall: 0 } });
  assert.ok(failures.some((failure) => failure.includes("false claim")));
});

test("markdown keeps a short paragraph and drops fenced source", () => {
  const extracted = extractMarkdown(
    [
      "## Create a board",
      "",
      "People create a board from the client.",
      "",
      "```js",
      'const token = "SUPER_SECRET_SAMPLE_TOKEN_do_not_copy_9f3a";',
      "```",
    ].join("\n"),
    160,
  );
  assert.equal(extracted.features[0].name, "Create a board");
  assert.equal(
    extracted.features[0].quote.text,
    "People create a board from the client.",
  );
  assert.equal(
    JSON.stringify(extracted).includes("SUPER_SECRET_SAMPLE_TOKEN"),
    false,
  );
  assert.match(extracted.features[0].detail, /Fenced code samples/);
});

test("ELF function symbols use the named STT_FUNC type from layout Evidence", () => {
  const digest = "a".repeat(64);
  const extracted = elfFindings({
    evidence_id: `ev_${"b".repeat(64)}`,
    normalized_result: {
      artifact: { sha256: digest },
      symbols: [
        {
          type: "STT_FUNC",
          name: {
            display: "add_one",
            location: { offset: "0x1", bytes: "0x8" },
          },
          location: { offset: "0x2", bytes: "0x18" },
        },
        {
          type: "STT_OBJECT",
          name: {
            display: "MARKER",
            location: { offset: "0x3", bytes: "0x7" },
          },
          location: { offset: "0x4", bytes: "0x18" },
        },
        {
          type: 2,
          name: { display: "entry", location: { offset: "0x5", bytes: "0x6" } },
          location: { offset: "0x6", bytes: "0x18" },
        },
      ],
      limitations: [],
    },
  });
  assert.deepEqual(extracted.findings.function.sort(), ["add_one", "entry"]);
  assert.deepEqual(extracted.provenance, []);
  assert.deepEqual(extracted.findings.string, []);
  assert.match(extracted.notes.join("\n"), /strings array/);
});

test("Go, Rust, and PE resource findings keep provenance", () => {
  const evidence = `ev_${"e".repeat(64)}`;
  const digest = "f".repeat(64);
  const go = goFindings({
    evidence_id: evidence,
    confidence: "observed",
    limitations: [],
    normalized_result: {
      artifact: { sha256: digest },
      build_info: {
        go_version: "go1.26.0",
        version_location: { offset: 1, bytes: 9 },
        module_location: { offset: 20, bytes: 40 },
        module: {
          path: "example.com/tool/cmd/tool",
          main: { path: "example.com/tool" },
          dependencies: [{ path: "example.com/dependency", version: "v1.2.3" }],
        },
      },
    },
  });
  assert.deepEqual(go.findings.module, [
    "example.com/tool/cmd/tool",
    "example.com/tool",
  ]);
  assert.deepEqual(go.findings.import, ["example.com/dependency v1.2.3"]);
  assert.deepEqual(go.provenance, []);
  const absent = goFindings({
    evidence_id: evidence,
    confidence: "observed",
    limitations: [
      "absent metadata does not establish that the binary is not Go.",
    ],
    normalized_result: {
      artifact: { sha256: digest },
      build_info: null,
      limitations: [],
    },
  });
  assert.equal(absent.findings.module.length, 0);
  assert.match(absent.notes.join(" "), /does not establish/);
  const rust = rustFindings({
    evidence_id: evidence,
    confidence: "observed",
    normalized_result: {
      artifact: { sha256: digest },
      auditable_metadata: {
        file_offset: 1024,
        section_bytes: 20,
        packages: [
          { name: "itoa", version: "1.0.18" },
          { name: "sample", version: "0.1.0" },
        ],
        dependency_edges: [{ from_index: 1, to_index: 0 }],
      },
      rustc_commit: {
        evidence_kind: "observed",
        hashes: [{ hash: "a".repeat(40), file_offset: 8 }],
      },
    },
  });
  assert.deepEqual(rust.findings.import, ["sample->itoa"]);
  assert.match(rust.provenance[0].problems.join(" "), /inferred/);
  const resources = peResourceFindings({
    evidence_id: evidence,
    confidence: "observed",
    normalized_result: {
      artifact: { sha256: digest },
      resources: [
        {
          type: { kind: "id", id: 10 },
          name: { kind: "name", name: "7" },
          language: { kind: "id", id: 1033 },
          payload: {
            location: { offset: 4, bytes: 5 },
            sha256: digest,
          },
        },
      ],
    },
  });
  assert.deepEqual(resources.findings.resource, ['10/"7"/1033']);
  assert.deepEqual(resources.provenance, []);
});

test("ELF string literals keep file offsets and behavior facts stay inferred", () => {
  const digest = "c".repeat(64);
  const parent = `ev_${"d".repeat(64)}`;
  const context = {
    context_id: "ctx-inferred",
    state: "inferred",
    confidence: "high",
    authority: "static-relationship-inference",
    artifact: { available: true, sha256: digest },
    limitations: ["static candidate"],
  };
  const observed = {
    ...context,
    context_id: "ctx-observed",
    state: "observed",
    authority: "ast-static-analysis",
    limitations: [],
  };
  const located = { available: true, value: { kind: "source-range" } };
  const extracted = javascriptFindings({
    evidence_id: parent,
    normalized_result: {
      semantic_graph: {
        evidence_contexts: [context, observed],
        nodes: [
          {
            node_id: "fn",
            kind: "function",
            identity: { module_path: "app.mjs" },
            properties: { name: "run" },
            evidence: { context_id: context.context_id, location: located },
          },
          {
            node_id: "behavior",
            kind: "expression",
            function_node_id: "fn",
            properties: { behavior: "return", detail: "null" },
            evidence: { context_id: context.context_id, location: located },
          },
          {
            node_id: "observed-behavior",
            kind: "expression",
            function_node_id: "fn",
            properties: { behavior: "network", detail: "fetch" },
            evidence: { context_id: observed.context_id, location: located },
          },
        ],
        relations: [],
      },
    },
  });
  assert.deepEqual(extracted.findings.behavior.sort(), [
    "app.mjs:run network fetch",
    "app.mjs:run return null",
  ]);
  assert.deepEqual(
    extracted.provenance.filter((item) => item.type === "behavior"),
    [
      {
        type: "behavior",
        key: "app.mjs:run network fetch",
        problems: ["behavior is marked observed"],
      },
    ],
  );
  const elf = elfFindings({
    evidence_id: parent,
    normalized_result: {
      artifact: { sha256: digest },
      symbols: [],
      strings: [
        {
          value: "ree-bench-marker",
          location: { offset: "0x2000", bytes: "0x11" },
        },
        { value: "missing-range" },
      ],
    },
  });
  assert.deepEqual(elf.findings.string, ["ree-bench-marker", "missing-range"]);
  assert.deepEqual(elf.provenance, [
    {
      type: "string",
      key: "missing-range",
      problems: ["string literal has no file offset"],
    },
  ]);
  assert.deepEqual(elf.notes, []);
});
