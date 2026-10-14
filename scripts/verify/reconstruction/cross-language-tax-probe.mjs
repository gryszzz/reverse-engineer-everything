import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createEvidenceBundle } from "../../../dist/domain/evidenceBundle.js";
import {
  executeApprovedReconstructionProcessProbeBatch,
  prepareReconstructionProcessProbeBatch,
} from "../../../dist/application/ReconstructionProbeBatchService.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const fixtureRoot = join(
  repositoryRoot,
  "experiments/ree-investigation-boundary/cross-language-tax",
);
const cliPath = join(repositoryRoot, "scripts/rea.mjs");
if (
  process.argv.slice(2).length !== 1 ||
  process.argv[2] !== "--approve-recommended-probes"
)
  throw new Error(
    "This owned-fixture experiment executes approved probes; rerun with --approve-recommended-probes.",
  );
const outputRoot = await mkdtemp(
  join(process.env.RUNNER_TEMP ?? tmpdir(), "ree-cross-language-tax-"),
);
const pythonAuthority = join(fixtureRoot, "authority.py");
const rubyCandidate = join(fixtureRoot, "candidate.rb");

const run = (executable, args) => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${executable} exited ${String(result.status)}:\n${result.stderr}${result.stdout}`,
    );
  return result.stdout;
};

const runCli = (...args) =>
  JSON.parse(run(process.execPath, [cliPath, ...args]));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const writeJson = async (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const capture = async (label, executable, amountCents, mode = "tax") => {
  const scenario = {
    executable,
    arguments: [String(amountCents), mode],
    working_directory: outputRoot,
    environment: {},
    timeout_ms: 5_000,
  };
  const scenarioPath = join(outputRoot, `${label}.scenario.json`);
  await writeJson(scenarioPath, scenario);
  const evidence = runCli("capture-process", scenarioPath, "--format", "json");
  await writeJson(join(outputRoot, `${label}.capture.evidence.json`), evidence);
  return evidence;
};

const without = (value, fields) =>
  Object.fromEntries(
    Object.entries(value).filter(([field]) => !fields.includes(field)),
  );

const compare = async (label, left, right) => {
  const original = left.normalized_result;
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
        id: "terminal-rendered",
        source: "terminal_rendered",
        exact: without(original.rendered_frames[0], ["sequence", "at_ms"]),
        ignore_fields: ["sequence", "at_ms"],
        cardinality: { kind: "exact", count: 1 },
      },
    ],
    language: {
      kind: "finite_traces",
      variants: [
        {
          id: "one-terminal-output",
          trace: [{ unordered: ["terminal-raw", "terminal-rendered"] }],
        },
      ],
    },
  };
  const leftPath = join(outputRoot, `${label}.left.capture.json`);
  const rightPath = join(outputRoot, `${label}.right.capture.json`);
  const tracePath = join(outputRoot, `${label}.trace.json`);
  await Promise.all([
    writeJson(leftPath, left),
    writeJson(rightPath, right),
    writeJson(tracePath, traceSpecification),
  ]);
  const evidence = runCli(
    "compare-process-captures",
    leftPath,
    rightPath,
    tracePath,
    "--format",
    "json",
  );
  await writeJson(
    join(outputRoot, `${label}.comparison.evidence.json`),
    evidence,
  );
  return evidence;
};

const comparePair = async (label, amountCents, mode = "tax") => {
  const left = await capture(
    `${label}.python`,
    pythonAuthority,
    amountCents,
    mode,
  );
  const right = await capture(
    `${label}.ruby`,
    rubyCandidate,
    amountCents,
    mode,
  );
  return {
    left,
    right,
    comparison: await compare(label, left, right),
  };
};

const control = await comparePair("control-100-cents", 100);
const counterexample = await comparePair("counterexample-99-cents", 99);
const branch = await comparePair("refund-branch-99-cents", 99, "refund");
const error = await comparePair("negative-amount-error", -1);
assert.equal(control.comparison.normalized_result.terminal, "unchanged");
assert.equal(counterexample.comparison.normalized_result.terminal, "changed");
assert.equal(branch.comparison.normalized_result.terminal, "unchanged");
assert.equal(branch.comparison.normalized_result.exit, "unchanged");
assert.equal(error.comparison.normalized_result.terminal, "unchanged");
assert.equal(error.comparison.normalized_result.exit, "unchanged");

const sourceRecords = [
  control.left,
  control.right,
  control.comparison,
  counterexample.left,
  counterexample.right,
  counterexample.comparison,
  branch.left,
  branch.right,
  branch.comparison,
  error.left,
  error.right,
  error.comparison,
];
const specificationInput = join(outputRoot, "specification-draft.input.json");
await writeJson(specificationInput, {
  name: "Cross-language tax rounding",
  evidence_bundle: createEvidenceBundle(sourceRecords),
  comparisons: [
    {
      comparison_evidence_id: control.comparison.evidence_id,
      dimensions: ["terminal"],
    },
    {
      comparison_evidence_id: counterexample.comparison.evidence_id,
      dimensions: ["terminal"],
    },
    {
      comparison_evidence_id: branch.comparison.evidence_id,
      dimensions: ["terminal", "exit"],
    },
    {
      comparison_evidence_id: error.comparison.evidence_id,
      dimensions: ["terminal", "exit"],
    },
  ],
});
const specificationEvidence = runCli(
  "derive-reconstruction-specification",
  specificationInput,
  "--format",
  "json",
);
await writeJson(
  join(outputRoot, "specification-draft.evidence.json"),
  specificationEvidence,
);
const specification = specificationEvidence.normalized_result.specification;
const verificationRequest = {
  specification,
  evidence_bundle: createEvidenceBundle(sourceRecords),
};
const verificationInput = join(outputRoot, "verification.input.json");
await writeJson(verificationInput, verificationRequest);
const initialVerification = runCli(
  "verify-reconstruction",
  verificationInput,
  "--format",
  "json",
);
await writeJson(
  join(outputRoot, "verification.initial.evidence.json"),
  initialVerification,
);
const verificationResult = initialVerification.normalized_result;
const recommendation = verificationResult.recommended_probes.find(
  ({ argument_variations }) => argument_variations?.length > 0,
);
assert.ok(recommendation, "The numeric counterexample should guide probes");
const variation = recommendation.argument_variations.find(
  ({ observed_value }) => observed_value === "99",
);
assert.ok(variation, "The input amount should be selected for follow-up");

const selections = variation.candidate_values.map((candidate_value) => ({
  left_source_evidence_id: variation.left_source_evidence_id,
  right_source_evidence_id: variation.right_source_evidence_id,
  argument_index: variation.argument_index,
  candidate_value,
}));
const plan = prepareReconstructionProcessProbeBatch({
  verification_request: verificationRequest,
  selections,
  max_probes: 2,
});
assert.equal(plan.ok, true);
if (!plan.ok) throw new Error(plan.error.message);
const replayedPlan = prepareReconstructionProcessProbeBatch({
  verification_request: verificationRequest,
  selections,
  max_probes: 2,
});
assert.equal(replayedPlan.ok, true);
if (!replayedPlan.ok) throw new Error(replayedPlan.error.message);
assert.equal(
  replayedPlan.value.plan_sha256,
  plan.value.plan_sha256,
  "Replaying the same accumulated Evidence and selections must reproduce the plan digest",
);
assert.ok(
  plan.value.probes.every(
    ({ trace_specification }) => trace_specification !== undefined,
  ),
  "The approved plan must retain the source comparison semantics",
);
await writeJson(join(outputRoot, "probe-batch.approval.json"), {
  state: "approved-for-this-run",
  approval:
    "explicit --approve-recommended-probes command-line flag, bound to the immutable plan digest",
  plan_sha256: plan.value.plan_sha256,
  execution_budget: plan.value.execution_budget,
  plan: plan.value,
});

const batch = await executeApprovedReconstructionProcessProbeBatch(
  plan.value,
  plan.value.plan_sha256,
  {
    validateTarget: async ({ executable, expected_sha256 }) =>
      digest(await readFile(executable)) === expected_sha256,
    capture: async (scenario) => {
      const scenarioPath = join(
        outputRoot,
        `approved-${digest(JSON.stringify(scenario))}.scenario.json`,
      );
      await writeJson(scenarioPath, scenario);
      return runCli("capture-process", scenarioPath, "--format", "json");
    },
  },
);
assert.equal(batch.ok, true);
if (!batch.ok) throw new Error(batch.error.message);
await writeJson(join(outputRoot, "probe-batch.evidence.json"), batch.value);
const batchResult = batch.value.normalized_result;
const followupStatuses = Object.fromEntries(
  batchResult.probes.map(({ selection, verification_status }) => [
    selection.candidate_value,
    verification_status,
  ]),
);
assert.deepEqual(followupStatuses, { 98: "fail", 100: "pass" });

let injectedCaptureCalls = 0;
const interruptedBatch = await executeApprovedReconstructionProcessProbeBatch(
  plan.value,
  plan.value.plan_sha256,
  {
    validateTarget: async ({ executable, expected_sha256 }) =>
      digest(await readFile(executable)) === expected_sha256,
    capture: async () => {
      injectedCaptureCalls += 1;
      throw new Error("injected fixture capture failure");
    },
  },
);
assert.equal(interruptedBatch.ok, true);
if (!interruptedBatch.ok) throw new Error(interruptedBatch.error.message);
assert.equal(injectedCaptureCalls, 1, "A failed capture is not retried");
assert.equal(interruptedBatch.value.normalized_result.state, "partial");
assert.equal(
  interruptedBatch.value.normalized_result.probes[0].status,
  "capture-failed",
);
assert.equal(
  interruptedBatch.value.normalized_result.probes.length,
  plan.value.probes.length,
  "The partial Evidence must account for every selected probe",
);
assert.equal(
  interruptedBatch.value.normalized_result.probes[1].status,
  "not-run",
);
assert.match(
  interruptedBatch.value.normalized_result.probes[1].reason,
  /was not launched/u,
);
const initialClaimStatuses = Object.fromEntries(
  verificationResult.claims.items
    .filter(({ comparison_evidence_id }) =>
      [
        control.comparison.evidence_id,
        counterexample.comparison.evidence_id,
      ].includes(comparison_evidence_id),
    )
    .map(({ comparison_evidence_id, status }) => [
      comparison_evidence_id === control.comparison.evidence_id
        ? "control"
        : "counterexample",
      status,
    ]),
);
assert.deepEqual(initialClaimStatuses, {
  control: "pass",
  counterexample: "fail",
});

console.log(
  JSON.stringify(
    {
      output: outputRoot,
      implementations: [
        "Python Decimal ROUND_HALF_UP",
        "Ruby integer truncation",
      ],
      initial_terminal_claims: initialClaimStatuses,
      branch_and_error_comparisons: {
        refund_terminal: branch.comparison.normalized_result.terminal,
        refund_exit: branch.comparison.normalized_result.exit,
        negative_amount_terminal: error.comparison.normalized_result.terminal,
        negative_amount_exit: error.comparison.normalized_result.exit,
      },
      recommendation: {
        observed_value: variation.observed_value,
        candidate_values: variation.candidate_values,
        argument_index: variation.argument_index,
      },
      approved_plan_sha256: plan.value.plan_sha256,
      followup_statuses: followupStatuses,
      evidence_record_count: batchResult.evidence_bundle.records.length,
      deterministic_replay_plan_sha256: plan.value.plan_sha256,
      injected_failure: {
        state: interruptedBatch.value.normalized_result.state,
        capture_calls: injectedCaptureCalls,
      },
      limitation:
        "Owned finite terminal experiment. Results do not establish tax-policy correctness or general program equivalence.",
    },
    null,
    2,
  ),
);
