import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createEvidenceBundle } from "../../../dist/domain/evidenceBundle.js";

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
          dimensions: ["overall", "terminal"],
        },
        {
          comparison_evidence_id: probeComparison.evidence_id,
          dimensions: ["overall", "terminal"],
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
        "The approved probe must select a recorded variation",
      );
      const selectedValue = variation.candidate_values[0];
      assert.ok(selectedValue, "The selected probe value must be present");
      assert.match(selectedValue, /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u);
      assert.notEqual(selectedValue, variation.observed_value);

      const sourceById = new Map(
        records.map((record) => [record.evidence_id, record]),
      );
      const scenarioForApprovedFixture = async (sourceId, expectedBinary) => {
        assert.ok(
          recommendation.evidence_links.includes(sourceId),
          "Each executable source must be cited by the recommendation",
        );
        const sourceEvidence = sourceById.get(sourceId);
        assert.equal(sourceEvidence?.operation, "capture_process_scenario");
        assert.equal(sourceEvidence?.predicate_type, "rea.process-capture");
        const captured = sourceEvidence.normalized_result;
        const committedScenario = captured.manifest.scenario;
        assert.equal(
          await realpath(committedScenario.executable),
          await realpath(expectedBinary),
        );
        assert.equal(
          await realpath(committedScenario.working_directory),
          await realpath(outputRoot),
        );
        assert.deepEqual(committedScenario.environment, {});
        assert.deepEqual(committedScenario.events, []);
        assert.deepEqual(committedScenario.filesystem_observation_paths, []);
        assert.equal(
          captured.manifest.executable_identity.state,
          "path_metadata_unchanged",
        );
        const expectedDigest = digest(await readFile(expectedBinary));
        assert.equal(
          captured.manifest.selected_executable_sha256,
          expectedDigest,
        );
        assert.equal(captured.manifest.executable_sha256, expectedDigest);
        assert.equal(captured.manifest.executable_identity.reason, null);
        const originalArguments = committedScenario.arguments;
        assert.ok(Array.isArray(originalArguments));
        assert.ok(
          originalArguments.every((argument) => typeof argument === "string"),
        );
        assert.deepEqual(originalArguments, [
          selectedProbe.unit_price,
          String(selectedProbe.quantity),
        ]);
        assert.equal(
          originalArguments[variation.argument_index],
          variation.observed_value,
        );
        const approvedArguments = [...originalArguments];
        approvedArguments[variation.argument_index] = selectedValue;
        const scenario = { ...committedScenario, arguments: approvedArguments };
        delete scenario.executable_sha256;
        return scenario;
      };

      const leftScenario = await scenarioForApprovedFixture(
        variation.left_source_evidence_id,
        authorityBinary,
      );
      const rightScenario = await scenarioForApprovedFixture(
        variation.right_source_evidence_id,
        candidateBinary,
      );
      assert.deepEqual(leftScenario.arguments, rightScenario.arguments);
      const approval = {
        state: "approved-for-this-run",
        approval: "explicit --approve-recommended-probes command-line flag",
        probe_budget: { variations: 1, process_captures: 2, comparisons: 1 },
        parent_verification_evidence_id: verification.evidence_id,
        recommendation,
        selected_argument_variation: variation,
        scenarios: [leftScenario, rightScenario],
      };
      await writeFile(
        join(outputRoot, "feedback-probe.approval.json"),
        `${JSON.stringify(approval, null, 2)}\n`,
      );

      const leftCapture = await captureScenario(
        "feedback-authority",
        leftScenario,
      );
      const rightCapture = await captureScenario(
        "feedback-candidate",
        rightScenario,
      );
      const followupPair = {
        left: {
          path: join(outputRoot, "feedback-authority.capture.json"),
          evidence: leftCapture,
        },
        right: {
          path: join(outputRoot, "feedback-candidate.capture.json"),
          evidence: rightCapture,
        },
      };
      const followupComparison = await compare(
        "feedback",
        followupPair.left,
        followupPair.right,
      );
      assert.equal(followupComparison.normalized_result.terminal, "changed");

      const historyRecords = [
        ...records,
        specificationEvidence,
        verification,
        leftCapture,
        rightCapture,
        followupComparison,
      ];
      const feedbackBundle = createEvidenceBundle(historyRecords);
      const feedbackSpecificationInputPath = join(
        outputRoot,
        "feedback-specification.input.json",
      );
      await writeFile(
        feedbackSpecificationInputPath,
        `${JSON.stringify(
          {
            name: "Bounded C rounding investigation with approved follow-up",
            evidence_bundle: feedbackBundle,
            comparisons: [
              {
                comparison_evidence_id: controlComparison.evidence_id,
                dimensions: ["overall", "terminal"],
              },
              {
                comparison_evidence_id: probeComparison.evidence_id,
                dimensions: ["overall", "terminal"],
              },
              {
                comparison_evidence_id: followupComparison.evidence_id,
                dimensions: ["terminal"],
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      const feedbackSpecificationRun = run(process.execPath, [
        cliPath,
        "derive-reconstruction-specification",
        feedbackSpecificationInputPath,
        "--format",
        "json",
      ]);
      const feedbackSpecificationEvidence = JSON.parse(
        feedbackSpecificationRun.stdout,
      );
      await writeFile(
        join(outputRoot, "feedback-specification.evidence.json"),
        `${JSON.stringify(feedbackSpecificationEvidence, null, 2)}\n`,
      );
      const feedbackVerificationInputPath = join(
        outputRoot,
        "feedback-verification.input.json",
      );
      await writeFile(
        feedbackVerificationInputPath,
        `${JSON.stringify(
          {
            specification:
              feedbackSpecificationEvidence.normalized_result.specification,
            evidence_bundle: feedbackBundle,
          },
          null,
          2,
        )}\n`,
      );
      const feedbackVerificationRun = run(process.execPath, [
        cliPath,
        "verify-reconstruction",
        feedbackVerificationInputPath,
        "--format",
        "json",
      ]);
      const feedbackVerification = JSON.parse(feedbackVerificationRun.stdout);
      await writeFile(
        join(outputRoot, "feedback-verification.evidence.json"),
        `${JSON.stringify(feedbackVerification, null, 2)}\n`,
      );
      const followupClaim =
        feedbackVerification.normalized_result.claims.items.find(
          ({ comparison_evidence_id, dimension }) =>
            comparison_evidence_id === followupComparison.evidence_id &&
            dimension === "terminal",
        );
      assert.equal(followupClaim?.status, "fail");
      return {
        state: "executed-and-reverified",
        approval_evidence_path: join(
          outputRoot,
          "feedback-probe.approval.json",
        ),
        approved_argument_variation: variation,
        new_capture_evidence_ids: [
          leftCapture.evidence_id,
          rightCapture.evidence_id,
        ],
        followup_comparison_evidence_id: followupComparison.evidence_id,
        followup_specification_evidence_id:
          feedbackSpecificationEvidence.evidence_id,
        followup_verification_evidence_id: feedbackVerification.evidence_id,
        followup_terminal_claim_status: followupClaim.status,
        evidence_record_count: feedbackBundle.records.length,
        probe_budget: approval.probe_budget,
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
