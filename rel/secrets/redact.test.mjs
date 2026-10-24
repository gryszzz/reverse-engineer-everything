import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emitHandoff } from "../handoff/emit.mjs";
import { redactText, redactValue } from "./redact.mjs";
import { findingsInText, formatFinding } from "../../scripts/secret-scan.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test("redactText hides stripe keys and runtime secret values", () => {
  const live = "sk_" + "live_" + "abcdefghij";
  const restricted = "rk_" + "live_" + "abcdefghij";
  const webhook = "whsec_" + "abcdefghijklmnop";
  const runtime = "runtime-" + "secret-value";
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = runtime;
  try {
    const text = redactText(
      `key ${live} restricted ${restricted} hook ${webhook} env ${runtime} price price_existing`,
    );
    assert.equal(text.includes(live), false);
    assert.equal(text.includes(restricted), false);
    assert.equal(text.includes(webhook), false);
    assert.equal(text.includes(runtime), false);
    assert.equal(text.includes("price_existing"), true);
    assert.match(text, /\[redacted\]/);
    const walked = redactValue({
      nested: { note: live },
      items: [webhook],
      count: 1,
    });
    assert.equal(JSON.stringify(walked).includes(live), false);
    assert.equal(JSON.stringify(walked).includes(webhook), false);
    assert.equal(walked.count, 1);
  } finally {
    if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previous;
  }
});

test("secret scan fails on long keys and keeps the match out of the report", () => {
  const live = "rk_" + "live_" + "examplekeyvalue";
  const short = "sk_test_mock";
  const root = mkdtempSync(join(tmpdir(), "ree-scan-"));
  try {
    writeFileSync(join(root, "short.txt"), short + "\n");
    assert.deepEqual(findingsInText(short), []);
    const found = findingsInText("prefix " + live + " suffix");
    assert.equal(found.length, 1);
    assert.equal(found[0].rule, "stripe-key");
    assert.equal(
      formatFinding({ file: "short.txt", ...found[0] }).includes(live),
      false,
    );
    writeFileSync(join(root, "leak.txt"), "token " + live + "\n");
    const run = spawnSync(process.execPath, ["scripts/secret-scan.mjs", root], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    const report = `${run.stdout}${run.stderr}`;
    assert.match(report, /leak\.txt:1:stripe-key: \[redacted\]/);
    assert.equal(report.includes(live), false);
    const clean = spawnSync(
      process.execPath,
      ["scripts/secret-scan.mjs", join(root, "short.txt")],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(clean.status, 0, clean.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff files redact a key that arrived in the spec", () => {
  const live = "sk_" + "live_" + "abcdefghij";
  const root = mkdtempSync(join(tmpdir(), "ree-handoff-"));
  const blast = join(root, "blast");
  mkdirSync(blast);
  const project = join(root, "product");
  mkdirSync(project);
  writeFileSync(
    join(project, "provenance.json"),
    JSON.stringify({
      build_id: "bld_0123456789abcdef",
      product_name: "Harbor Kit",
      left_out: [],
      generator_limits: [],
    }),
  );
  writeFileSync(
    join(project, "behavior-spec.json"),
    JSON.stringify({
      target: { name: "Example Target" },
      limitations: [],
      pricing: { plans: [] },
      similarity: { flagged: false },
      clean_room_statement: "Clean room " + live,
    }),
  );
  writeFileSync(join(project, "package.json"), "{}\n");
  writeFileSync(join(project, "package-lock.json"), "{}\n");
  try {
    const emitted = emitHandoff({
      projectDir: project,
      blastDir: blast,
      verify: {
        schema_version: "ree.verify.v1",
        exit_code: 0,
        implemented: 0,
        unimplemented: 0,
        failed: 0,
        not_run: 0,
        total: 0,
        ratio: null,
        features: [],
      },
    });
    const handoff = readFileSync(
      join(emitted.directory, "handoff.json"),
      "utf8",
    );
    const guard = readFileSync(
      join(emitted.directory, "guard/submission.json"),
      "utf8",
    );
    assert.equal(handoff.includes(live), false);
    assert.equal(guard.includes(live), false);
    assert.match(handoff, /\[redacted\]/);
    assert.match(guard, /\[redacted\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("studio logs redact key material", async () => {
  await import("../studio/server.mjs");
  const live = "sk_" + "live_" + "abcdefghij";
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, callback) => {
    chunks.push(String(chunk));
    return original(chunk, encoding, callback);
  };
  try {
    console.error("failed " + live);
  } finally {
    process.stderr.write = original;
  }
  const logged = chunks.join("");
  assert.equal(logged.includes(live), false);
  assert.match(logged, /\[redacted\]/);
});
