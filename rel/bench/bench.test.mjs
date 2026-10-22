import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMarkdown } from "../outside-in/extract-markdown.mjs";
import { elfFindings } from "./extract.mjs";
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
});
