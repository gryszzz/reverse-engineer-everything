import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createEvidenceBundle } from "../../../dist/domain/evidenceBundle.js";
import { verifyReconstruction } from "../../../dist/domain/reconstructionVerification.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const fixtureRoot = join(
  repositoryRoot,
  "experiments/ree-investigation-boundary",
);
const cliPath = join(repositoryRoot, "scripts/rea.mjs");
const requestedOutputRoot = process.argv[2];
const outputRoot = requestedOutputRoot
  ? resolve(requestedOutputRoot)
  : await mkdtemp(join(tmpdir(), "ree-c-investigation-"));
if (requestedOutputRoot !== undefined) await mkdir(outputRoot);

const authoritySource = await readFile(join(fixtureRoot, "authority.c"));
const candidateSource = await readFile(join(fixtureRoot, "candidate.c"));
const authorityBinary = join(outputRoot, "authority");
const candidateBinary = join(outputRoot, "candidate");

const run = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${executable} exited ${String(result.status)}:\n${result.stderr}${result.stdout}`,
    );
  return result;
};

const digest = (value) => createHash("sha256").update(value).digest("hex");

const compiler = process.env.CC ?? "clang";
const compilerVersion = run(compiler, ["--version"]).stdout.split("\n", 1)[0];
run(compiler, [
  "-std=c11",
  "-O0",
  "-Wall",
  "-Wextra",
  "-Werror",
  join(fixtureRoot, "authority.c"),
  "-o",
  authorityBinary,
]);
run(compiler, [
  "-std=c11",
  "-O0",
  "-Wall",
  "-Wextra",
  "-Werror",
  join(fixtureRoot, "candidate.c"),
  "-lm",
  "-o",
  candidateBinary,
]);

const domain = {
  unit_price_cents: { minimum: 100, maximum: 200, step: 1 },
  quantity_values: [1, 2, 3, 10],
  selected_boundary: "products with a fractional part of exactly 0.50",
};
const hypothesis =
  "The candidate rounds each product to a whole unit; integer products agree, while half-unit products can diverge.";

const execute = (binary, unitPrice, quantity) =>
  run(binary, [unitPrice, String(quantity)]).stdout.trim();

const control = { unit_price: "199.00", quantity: 3 };
assert.equal(
  execute(authorityBinary, control.unit_price, control.quantity),
  "597.00",
);
assert.equal(
  execute(candidateBinary, control.unit_price, control.quantity),
  "597.00",
);

let selectedProbe;
let candidatesExamined = 0;
for (
  let cents = domain.unit_price_cents.minimum;
  cents <= domain.unit_price_cents.maximum && selectedProbe === undefined;
  cents += domain.unit_price_cents.step
) {
  const unitPrice = (cents / 100).toFixed(2);
  for (const quantity of domain.quantity_values) {
    const product = (cents / 100) * quantity;
    if (Math.abs(product - (Math.floor(product) + 0.5)) > 1e-9) continue;
    candidatesExamined += 1;
    const authorityOutput = execute(authorityBinary, unitPrice, quantity);
    const candidateOutput = execute(candidateBinary, unitPrice, quantity);
    if (authorityOutput !== candidateOutput) {
      selectedProbe = {
        unit_price: unitPrice,
        quantity,
        authority_output: authorityOutput,
        candidate_output: candidateOutput,
      };
      break;
    }
  }
}
assert.ok(selectedProbe, "The declared domain should contain a counterexample");

const capture = async (label, binary, input) => {
  const scenarioPath = join(outputRoot, `${label}.scenario.json`);
  const evidencePath = join(outputRoot, `${label}.capture.json`);
  const logPath = join(outputRoot, `${label}.stderr.log`);
  const scenario = {
    executable: binary,
    arguments: [input.unit_price, String(input.quantity)],
    working_directory: outputRoot,
    environment: {},
    timeout_ms: 5_000,
  };
  await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  const result = run(process.execPath, [
    cliPath,
    "capture-process",
    scenarioPath,
    "--format",
    "json",
  ]);
  await writeFile(evidencePath, result.stdout);
  await writeFile(logPath, result.stderr);
  return JSON.parse(result.stdout);
};

const without = (value, fields) =>
  Object.fromEntries(
    Object.entries(value).filter(([field]) => !fields.includes(field)),
  );

const compare = async (label, left, right) => {
  const evidencePath = join(outputRoot, `${label}.comparison.json`);
  const tracePath = join(outputRoot, `${label}.trace.json`);
  const original = left.evidence.normalized_result;
  const traceSpecification = {
    events: [
      {
        id: "terminal-raw",
        source: "terminal_raw",
        exact: without(original.frames[0], ["sequence", "at_ms"]),
        ignore_fields: ["sequence", "at_ms"],
        cardinality: { kind: "exact", count: 1 },
      },
      {
        id: "process-exit",
        source: "lifecycle",
        exact: { event: "exit", ...original.exit },
        ignore_fields: ["elapsed_ms"],
        cardinality: { kind: "exact", count: 1 },
      },
      {
        id: "terminal-rendered",
        source: "terminal_rendered",
        exact: without(original.rendered_frames[0], ["sequence", "at_ms"]),
        ignore_fields: ["sequence", "at_ms"],
        cardinality: { kind: "exact", count: 1 },
      },
      {
        id: "process-settlement",
        source: "lifecycle",
        exact: {
          event: "settlement",
          state: original.settlement.state,
          cleanup_outcome: original.settlement.cleanup_outcome,
        },
        ignore_fields: ["elapsed_ms"],
        cardinality: { kind: "exact", count: 1 },
      },
    ],
    language: {
      kind: "finite_traces",
      variants: [
        {
          id: "one-output-and-clean-exit",
          trace: [
            "terminal-raw",
            "process-exit",
            "terminal-rendered",
            "process-settlement",
          ],
        },
      ],
    },
  };
  await writeFile(
    tracePath,
    `${JSON.stringify(traceSpecification, null, 2)}\n`,
  );
  const result = run(process.execPath, [
    cliPath,
    "compare-process-captures",
    left.path,
    right.path,
    tracePath,
    "--format",
    "json",
  ]);
  await writeFile(evidencePath, result.stdout);
  return JSON.parse(result.stdout);
};

const capturePair = async (label, input) => {
  const left = await capture(`${label}-authority`, authorityBinary, input);
  const right = await capture(`${label}-candidate`, candidateBinary, input);
  return {
    left: {
      path: join(outputRoot, `${label}-authority.capture.json`),
      evidence: left,
    },
    right: {
      path: join(outputRoot, `${label}-candidate.capture.json`),
      evidence: right,
    },
  };
};

const controlPair = await capturePair("control", control);
const controlComparison = await compare(
  "control",
  controlPair.left,
  controlPair.right,
);
const probePair = await capturePair("counterexample", selectedProbe);
const probeComparison = await compare(
  "counterexample",
  probePair.left,
  probePair.right,
);

const claims = [
  {
    claim_id: "control.terminal",
    title: "Terminal output matches for the selected integer-product control",
    kind: "behavioral",
    dimension: "terminal",
    comparison_evidence_id: controlComparison.evidence_id,
  },
  {
    claim_id: "control.overall",
    title:
      "All observed behavior matches for the selected integer-product control",
    kind: "behavioral",
    dimension: "overall",
    comparison_evidence_id: controlComparison.evidence_id,
  },
  {
    claim_id: "counterexample.terminal",
    title: "Terminal output matches at the discovered half-unit boundary",
    kind: "behavioral",
    dimension: "terminal",
    comparison_evidence_id: probeComparison.evidence_id,
  },
  {
    claim_id: "counterexample.overall",
    title: "All observed behavior matches at the discovered half-unit boundary",
    kind: "behavioral",
    dimension: "overall",
    comparison_evidence_id: probeComparison.evidence_id,
  },
];
const records = [
  controlPair.left.evidence,
  controlPair.right.evidence,
  controlComparison,
  probePair.left.evidence,
  probePair.right.evidence,
  probeComparison,
];
const verification = verifyReconstruction(
  { name: "Bounded C rounding investigation", claims },
  createEvidenceBundle(records),
);
const claimStatuses = Object.fromEntries(
  verification.claims.items.map(({ claim_id, status }) => [claim_id, status]),
);

assert.equal(controlComparison.normalized_result.terminal, "unchanged");
assert.equal(controlComparison.normalized_result.status, "unknown");
assert.equal(controlComparison.normalized_result.trace?.verdict, "equivalent");
assert.equal(probeComparison.normalized_result.terminal, "changed");
assert.equal(probeComparison.normalized_result.trace?.verdict, "different");
assert.deepEqual(claimStatuses, {
  "control.overall": "unknown",
  "control.terminal": "pass",
  "counterexample.overall": "fail",
  "counterexample.terminal": "fail",
});

const summary = {
  hypothesis,
  declared_domain: domain,
  candidates_examined: candidatesExamined,
  selected_probe: selectedProbe,
  authority_source_sha256: digest(authoritySource),
  candidate_source_sha256: digest(candidateSource),
  authority_binary_sha256: digest(await readFile(authorityBinary)),
  candidate_binary_sha256: digest(await readFile(candidateBinary)),
  compiler: compilerVersion,
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  comparison_evidence_ids: {
    control: controlComparison.evidence_id,
    counterexample: probeComparison.evidence_id,
  },
  claim_statuses: claimStatuses,
  verification_expected_failure_observed: verification.status === "fail",
  limitation:
    "The domain and half-unit probe rule are human-declared. A terminal pass covers the selected captured scenario only; overall process behavior remains unknown when dimensions are unobserved.",
};
await writeFile(
  join(outputRoot, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify({ output: outputRoot, ...summary }, null, 2));
