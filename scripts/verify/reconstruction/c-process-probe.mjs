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
  "experiments/ree-investigation-boundary",
);
const cliPath = join(repositoryRoot, "scripts/rea.mjs");
const scriptArguments = process.argv.slice(2);
const approveRecommendedProbes = scriptArguments.includes(
  "--approve-recommended-probes",
);
const requestedOutputRoot = scriptArguments.find(
  (argument) => argument !== "--approve-recommended-probes",
);
if (
  scriptArguments.some(
    (argument) =>
      argument.startsWith("--") && argument !== "--approve-recommended-probes",
  )
)
  throw new Error(
    "Usage: c-process-probe.mjs [new-output-directory] [--approve-recommended-probes]",
  );
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

const captureScenario = async (label, scenario) => {
  const scenarioPath = join(outputRoot, `${label}.scenario.json`);
  const evidencePath = join(outputRoot, `${label}.capture.json`);
  const logPath = join(outputRoot, `${label}.stderr.log`);
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

const capture = async (label, binary, input) =>
  captureScenario(label, {
    executable: binary,
    arguments: [input.unit_price, String(input.quantity)],
    working_directory: outputRoot,
    environment: {},
    timeout_ms: 5_000,
  });

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

const records = [
  controlPair.left.evidence,
  controlPair.right.evidence,
  controlComparison,
  probePair.left.evidence,
  probePair.right.evidence,
  probeComparison,
];
const comparisonLabels = new Map([
  [controlComparison.evidence_id, "control"],
  [probeComparison.evidence_id, "counterexample"],
]);
const specificationInputPath = join(outputRoot, "specification.input.json");
await writeFile(
  specificationInputPath,
  `${JSON.stringify(
    {
      name: "Bounded C rounding investigation",
      evidence_bundle: createEvidenceBundle(records),
      comparisons: [
        {
          comparison_evidence_id: controlComparison.evidence_id,
          dimensions: ["terminal"],
        },
        {
          comparison_evidence_id: probeComparison.evidence_id,
          dimensions: ["terminal"],
        },
      ],
    },
    null,
    2,
  )}\n`,
);
const specificationRun = run(process.execPath, [
  cliPath,
  "derive-reconstruction-specification",
  specificationInputPath,
  "--format",
  "json",
]);
const specificationEvidence = JSON.parse(specificationRun.stdout);
await writeFile(
  join(outputRoot, "specification.evidence.json"),
  `${JSON.stringify(specificationEvidence, null, 2)}\n`,
);
const specificationDraft = specificationEvidence.normalized_result;
const verificationInputPath = join(outputRoot, "verification.input.json");
await writeFile(
  verificationInputPath,
  `${JSON.stringify(
    {
      specification: specificationDraft.specification,
      evidence_bundle: createEvidenceBundle(records),
    },
    null,
    2,
  )}\n`,
);
const verificationRun = run(process.execPath, [
  cliPath,
  "verify-reconstruction",
  verificationInputPath,
  "--format",
  "json",
]);
const verification = JSON.parse(verificationRun.stdout);
await writeFile(
  join(outputRoot, "verification.evidence.json"),
  `${JSON.stringify(verification, null, 2)}\n`,
);
const verificationResult = verification.normalized_result;
const claimStatuses = Object.fromEntries(
  verificationResult.claims.items.map(
    ({ comparison_evidence_id, dimension, status }) => [
      `${comparisonLabels.get(comparison_evidence_id)}.${dimension}`,
      status,
    ],
  ),
);

assert.equal(controlComparison.normalized_result.terminal, "unchanged");
assert.equal(controlComparison.normalized_result.trace?.verdict, "equivalent");
assert.equal(probeComparison.normalized_result.terminal, "changed");
assert.equal(probeComparison.normalized_result.trace?.verdict, "different");
assert.deepEqual(claimStatuses, {
  "control.terminal": "pass",
  "counterexample.terminal": "fail",
});
const counterexampleProbe = verificationResult.recommended_probes.find(
  ({ argument_variations }) => argument_variations !== undefined,
);
assert.ok(
  counterexampleProbe,
  "The terminal counterexample should guide probes",
);
assert.deepEqual(
  counterexampleProbe.argument_variations.map(
    ({ argument_index, observed_value, candidate_values }) => ({
      argument_index,
      observed_value,
      candidate_values,
    }),
  ),
  [
    {
      argument_index: 0,
      observed_value: selectedProbe.unit_price,
      candidate_values: ["1.04", "1.06"],
    },
    {
      argument_index: 1,
      observed_value: String(selectedProbe.quantity),
      candidate_values: ["9", "11"],
    },
  ],
);

const feedback = approveRecommendedProbes
  ? await (async () => {
      const recommendation = counterexampleProbe;
      assert.ok(
        recommendation.evidence_links.includes(probeComparison.evidence_id),
        "The recommendation must cite the counterexample comparison",
      );
      const variation = recommendation.argument_variations[0];
      assert.ok(
        variation,
        "The probe must select a recorded argument variation",
      );
      const sourceIds = [
        variation.left_source_evidence_id,
        variation.right_source_evidence_id,
      ];
      const selections = variation.candidate_values
        .slice(0, 2)
        .map((candidate_value) => ({
          left_source_evidence_id: sourceIds[0],
          right_source_evidence_id: sourceIds[1],
          argument_index: variation.argument_index,
          candidate_value,
        }));
      assert.equal(selections.length, 2);
      const verificationRequest = {
        specification: specificationDraft.specification,
        evidence_bundle: createEvidenceBundle(records),
      };
      const selectedPlan = prepareReconstructionProcessProbeBatch({
        verification_request: verificationRequest,
        selections: [...selections, selections[0]],
        max_probes: 2,
      });
      assert.equal(selectedPlan.ok, true);
      if (!selectedPlan.ok) throw new Error(selectedPlan.error.message);
      const plan = selectedPlan.value;
      assert.ok(
        plan.probes.every(
          ({ trace_specification }) => trace_specification !== undefined,
        ),
        "Approved probes must retain the source comparison trace specification",
      );
      assert.equal(
        plan.probes.length,
        2,
        "Duplicate recommendations must deduplicate",
      );
      assert.equal(plan.deduplicated_selection_count, 1);
      assert.deepEqual(plan.execution_budget, {
        max_probes: 2,
        process_captures: 4,
        comparisons: 2,
        retries: 0,
      });
      const overBudget = prepareReconstructionProcessProbeBatch({
        verification_request: verificationRequest,
        selections,
        max_probes: 1,
      });
      assert.equal(
        overBudget.ok,
        false,
        "Unique probes over budget must be rejected",
      );
      const changedPlan = {
        ...plan,
        probes: plan.probes.map((probe, index) =>
          index === 0
            ? {
                ...probe,
                left_scenario: {
                  ...probe.left_scenario,
                  arguments: [
                    "1.03",
                    ...probe.left_scenario.arguments.slice(1),
                  ],
                },
              }
            : probe,
        ),
      };
      let invalidPlanCaptures = 0;
      const invalidApproval =
        await executeApprovedReconstructionProcessProbeBatch(
          changedPlan,
          plan.plan_sha256,
          {
            validateTarget: async () => {
              invalidPlanCaptures += 1;
              return true;
            },
            capture: async () => {
              invalidPlanCaptures += 1;
              throw new Error("must not execute");
            },
          },
        );
      assert.equal(
        invalidApproval.ok,
        false,
        "Mutated plans require renewed approval",
      );
      assert.equal(
        invalidPlanCaptures,
        0,
        "Invalid plans must not validate or execute targets",
      );
      const failedCapturePlan =
        await executeApprovedReconstructionProcessProbeBatch(
          plan,
          plan.plan_sha256,
          {
            validateTarget: async ({ executable, expected_sha256 }) =>
              digest(await readFile(executable)) === expected_sha256,
            capture: async () => {
              throw new Error("fixture capture failure");
            },
          },
        );
      assert.equal(failedCapturePlan.ok, true);
      if (!failedCapturePlan.ok)
        throw new Error(failedCapturePlan.error.message);
      assert.equal(failedCapturePlan.value.normalized_result.state, "partial");
      assert.equal(failedCapturePlan.value.normalized_result.probes.length, 1);
      const approval = {
        state: "approved-for-this-run",
        approval:
          "explicit --approve-recommended-probes command-line flag, bound to immutable plan digest",
        plan_sha256: plan.plan_sha256,
        execution_budget: plan.execution_budget,
        plan,
      };
      await writeFile(
        join(outputRoot, "feedback-probe.approval.json"),
        `${JSON.stringify(approval, null, 2)}\n`,
      );
      const batch = await executeApprovedReconstructionProcessProbeBatch(
        plan,
        plan.plan_sha256,
        {
          validateTarget: async ({ executable, expected_sha256 }) =>
            digest(await readFile(executable)) === expected_sha256,
          capture: async (scenario) => {
            const label = `batch-${scenario.arguments[0]}-${scenario.executable === authorityBinary ? "authority" : "candidate"}`;
            return await captureScenario(label, scenario);
          },
        },
      );
      assert.equal(batch.ok, true);
      if (!batch.ok) throw new Error(batch.error.message);
      await writeFile(
        join(outputRoot, "feedback-probe-batch.evidence.json"),
        `${JSON.stringify(batch.value, null, 2)}\n`,
      );
      const result = batch.value.normalized_result;
      assert.equal(result.state, "complete");
      assert.equal(result.probes.length, 2);
      assert.ok(
        result.probes.every(
          ({ status, verification_status }) =>
            status === "compared" && verification_status === "fail",
        ),
      );
      assert.equal(
        result.evidence_bundle.records.length,
        records.length + 4 + 2 + 1,
      );
      return {
        state: "executed-and-reverified",
        approval_evidence_path: join(
          outputRoot,
          "feedback-probe.approval.json",
        ),
        batch_evidence_path: join(
          outputRoot,
          "feedback-probe-batch.evidence.json",
        ),
        plan_sha256: plan.plan_sha256,
        selected_probe_count: plan.probes.length,
        deduplicated_selection_count: plan.deduplicated_selection_count,
        new_capture_evidence_ids: result.probes.flatMap(
          ({ left_capture_evidence_id, right_capture_evidence_id }) => [
            left_capture_evidence_id,
            right_capture_evidence_id,
          ],
        ),
        followup_comparison_evidence_ids: result.probes.map(
          ({ comparison_evidence_id }) => comparison_evidence_id,
        ),
        followup_terminal_claim_statuses: result.probes.map(
          ({ verification_status }) => verification_status,
        ),
        evidence_record_count: result.evidence_bundle.records.length,
        invalid_plan_rejected_before_execution: invalidPlanCaptures === 0,
        over_budget_plan_rejected: !overBudget.ok,
        capture_failure_stopped_without_retry:
          failedCapturePlan.value.normalized_result.state === "partial",
        execution_budget: plan.execution_budget,
      };
    })()
  : {
      state: "approval-required",
      execution_flag: "--approve-recommended-probes",
      executed: false,
    };
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
  specification_evidence_id: specificationEvidence.evidence_id,
  derived_claim_count: specificationDraft.specification.claims.length,
  claim_statuses: claimStatuses,
  verification_evidence_id: verification.evidence_id,
  verification_expected_failure_observed: verificationResult.status === "fail",
  counterexample_probe_recommendation: counterexampleProbe,
  feedback_loop: feedback,
  limitation:
    "The domain, half-unit probe rule, comparison Evidence, and dimensions included in the draft are human-selected. A terminal pass covers the selected captured scenario only; overall process behavior remains unknown when dimensions are unobserved.",
};
await writeFile(
  join(outputRoot, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify({ output: outputRoot, ...summary }, null, 2));
