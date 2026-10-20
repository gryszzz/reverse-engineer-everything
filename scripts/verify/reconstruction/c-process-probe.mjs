import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createEvidenceBundle } from "../../../dist/domain/evidenceBundle.js";
import {
  rankDiscriminatingInputs,
  synthesizeBlackBoxExpression,
} from "./black-box-expression-synthesis.mjs";
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
const refineCandidate = scriptArguments.includes("--refine-candidate");
const blackBoxSynthesis = scriptArguments.includes("--black-box-synthesis");
const activeHypothesisDiscrimination = scriptArguments.includes(
  "--active-hypothesis-discrimination",
);
const hypothesisProbeApproval = scriptArguments
  .find((argument) => argument.startsWith("--approve-hypothesis-probe="))
  ?.slice("--approve-hypothesis-probe=".length);
const proposalApproval = scriptArguments
  .find((argument) => argument.startsWith("--approve-proposed-patch="))
  ?.slice("--approve-proposed-patch=".length);
const requestedOutputRoot = scriptArguments.find(
  (argument) =>
    argument !== "--approve-recommended-probes" &&
    argument !== "--refine-candidate" &&
    argument !== "--black-box-synthesis" &&
    argument !== "--active-hypothesis-discrimination" &&
    !argument.startsWith("--approve-hypothesis-probe=") &&
    !argument.startsWith("--approve-proposed-patch="),
);
if (
  scriptArguments.some(
    (argument) =>
      argument.startsWith("--") &&
      argument !== "--approve-recommended-probes" &&
      argument !== "--refine-candidate" &&
      argument !== "--black-box-synthesis" &&
      argument !== "--active-hypothesis-discrimination" &&
      !argument.startsWith("--approve-hypothesis-probe=") &&
      !argument.startsWith("--approve-proposed-patch="),
  )
)
  throw new Error(
    "Usage: c-process-probe.mjs [new-output-directory] [--approve-recommended-probes] [--refine-candidate] [--black-box-synthesis] [--active-hypothesis-discrimination] [--approve-hypothesis-probe=<sha256>] [--approve-proposed-patch=<sha256>]",
  );
if (blackBoxSynthesis && !refineCandidate)
  throw new Error("Black-box synthesis requires --refine-candidate.");
if (activeHypothesisDiscrimination && !blackBoxSynthesis)
  throw new Error(
    "Active hypothesis discrimination requires --black-box-synthesis.",
  );
if (hypothesisProbeApproval !== undefined && !activeHypothesisDiscrimination)
  throw new Error("Hypothesis probe approval requires active discrimination.");
if (
  hypothesisProbeApproval !== undefined &&
  !/^[a-f0-9]{64}$/u.test(hypothesisProbeApproval)
)
  throw new Error(
    "--approve-hypothesis-probe must contain the SHA-256 shown in a prior probe plan.",
  );
if (
  activeHypothesisDiscrimination &&
  proposalApproval !== undefined &&
  hypothesisProbeApproval === undefined
)
  throw new Error(
    "Patch approval requires re-approving the hypothesis probe plan for this run.",
  );
if (refineCandidate && !approveRecommendedProbes)
  throw new Error(
    "Candidate refinement requires --approve-recommended-probes so its bounded source probes are explicitly approved first.",
  );
if (proposalApproval !== undefined && !refineCandidate)
  throw new Error("Patch approval requires --refine-candidate.");
if (proposalApproval !== undefined && !/^[a-f0-9]{64}$/u.test(proposalApproval))
  throw new Error(
    "--approve-proposed-patch must contain the SHA-256 shown in a prior candidate patch proposal.",
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

const findCallArguments = (source, name) => {
  const matches = [...source.matchAll(new RegExp(`\\b${name}\\s*\\(`, "gu"))];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const open = source.indexOf("(", match.index);
  let quote;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let parentheses = 1;
  let brackets = 0;
  let braces = 0;
  let argumentStart = open + 1;
  const arguments_ = [];
  let close = -1;
  for (let index = open + 1; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = undefined;
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (current === '"' || current === "'") quote = current;
    else if (current === "(") parentheses += 1;
    else if (current === ")") {
      parentheses -= 1;
      if (parentheses === 0) {
        arguments_.push({ start: argumentStart, end: index });
        close = index;
        break;
      }
    } else if (current === "[") brackets += 1;
    else if (current === "]") brackets -= 1;
    else if (current === "{") braces += 1;
    else if (current === "}") braces -= 1;
    else if (
      current === "," &&
      parentheses === 1 &&
      brackets === 0 &&
      braces === 0
    ) {
      arguments_.push({ start: argumentStart, end: index });
      argumentStart = index + 1;
    }
  }
  if (close < 0 || arguments_.length !== 2) return undefined;
  return {
    start: match.index,
    end: close + 1,
    arguments: arguments_.map(({ start, end }) => {
      while (/\s/u.test(source[start] ?? "")) start += 1;
      while (end > start && /\s/u.test(source[end - 1] ?? "")) end -= 1;
      return { start, end, text: source.slice(start, end) };
    }),
  };
};

const sourceLineAt = (source, offset) => {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const newline = source.indexOf("\n", offset);
  return {
    number: source.slice(0, lineStart).split("\n").length,
    start: lineStart,
    end: newline < 0 ? source.length : newline,
  };
};

const replaceSourceRange = (source, range, replacement) =>
  source.slice(0, range.start) + replacement + source.slice(range.end);

const replacementPatch = (source, range, replacement, targetName) => {
  const location = sourceLineAt(source, range.start);
  const originalLine = source.slice(location.start, location.end);
  const relativeStart = range.start - location.start;
  const relativeEnd = range.end - location.start;
  const proposedLine =
    originalLine.slice(0, relativeStart) +
    replacement +
    originalLine.slice(relativeEnd);
  return [
    "--- a/candidate.c",
    `+++ b/${targetName}`,
    `@@ -${location.number},1 +${location.number},1 @@`,
    `-${originalLine}`,
    `+${proposedLine}`,
    "",
  ].join("\n");
};

const proposeOutputExpressionTransfer = ({
  authoritySource,
  candidateSource,
  comparison,
}) => {
  const observation = comparison.normalized_result;
  if (
    observation.status !== "changed" ||
    observation.terminal !== "changed" ||
    observation.first_divergence.status !== "found" ||
    observation.first_divergence.dimension !== "terminal" ||
    observation.first_divergence.left === null ||
    observation.first_divergence.right === null ||
    canonicalString(observation.first_divergence.left) ===
      canonicalString(observation.first_divergence.right)
  )
    return {
      state: "insufficient-evidence",
      reason:
        "A confirmed terminal divergence is required before proposing a source change.",
    };
  const authorityCall = findCallArguments(authoritySource, "printf");
  const candidateCall = findCallArguments(candidateSource, "printf");
  if (authorityCall === undefined || candidateCall === undefined)
    return {
      state: "insufficient-source-structure",
      reason:
        "Both programs must contain exactly one balanced printf call with two arguments.",
    };
  const [authorityFormat, authorityExpression] = authorityCall.arguments;
  const [candidateFormat, candidateExpression] = candidateCall.arguments;
  if (
    authorityFormat.text !== candidateFormat.text ||
    authorityExpression.text === candidateExpression.text
  )
    return {
      state: "insufficient-source-alignment",
      reason:
        "The output format arguments must match and the output expressions must differ.",
    };
  const patch = replacementPatch(
    candidateSource,
    candidateExpression,
    authorityExpression.text,
    "candidate.c",
  );
  const location = sourceLineAt(candidateSource, candidateExpression.start);
  const sourceIdentity = {
    authority_source_sha256: digest(authoritySource),
    candidate_source_sha256: digest(candidateSource),
  };
  const proposalSha256 = digest(
    canonicalString({
      version: 1,
      ...sourceIdentity,
      patch,
    }),
  );
  return {
    state: "proposed-awaiting-approval",
    proposal_sha256: proposalSha256,
    method: "matched-output-expression-transfer",
    basis_comparison_evidence_id: comparison.evidence_id,
    observed_terminal_difference: {
      reference: observation.first_divergence.left,
      candidate: observation.first_divergence.right,
    },
    source_identity: sourceIdentity,
    matched_output_format: authorityFormat.text,
    candidate_expression: candidateExpression.text,
    reference_expression: authorityExpression.text,
    candidate_source_range: {
      start: candidateExpression.start,
      end: candidateExpression.end,
      line: location.number,
      start_column: candidateExpression.start - location.start + 1,
      end_column: candidateExpression.end - location.start,
    },
    patch,
    rationale:
      "A captured terminal mismatch is linked to the only output call whose format matches between the owned reference and candidate; the proposal transfers the differing expression and preserves the candidate's surrounding source.",
    limitations:
      "This is a constrained source-differential proposal. It transfers a matching reference expression; it does not infer the expression's meaning or demonstrate independent semantic synthesis.",
  };
};

const canonicalString = (value) => JSON.stringify(value);

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
if (!activeHypothesisDiscrimination) {
  assert.equal(
    execute(authorityBinary, control.unit_price, control.quantity),
    "597.00",
  );
  assert.equal(
    execute(candidateBinary, control.unit_price, control.quantity),
    "597.00",
  );
}

let selectedProbe;
let candidatesExamined = 0;
if (!activeHypothesisDiscrimination) {
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
  assert.ok(
    selectedProbe,
    "The declared domain should contain a counterexample",
  );
}

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

const terminalOutput = (captureRecord) =>
  captureRecord.evidence.normalized_result.frames
    .map(({ data }) => data)
    .join("")
    .trim();

const controlPair = await capturePair("control", control);
const controlComparison = await compare(
  "control",
  controlPair.left,
  controlPair.right,
);
let activeHypothesisPlan;
if (activeHypothesisDiscrimination) {
  const seedObservation = {
    input: {
      unit_price: Number(control.unit_price),
      quantity: control.quantity,
    },
    expected_stdout: terminalOutput(controlPair.left),
  };
  const ranking = rankDiscriminatingInputs([seedObservation], domain);
  const planPath = join(outputRoot, "hypothesis-probe-plan.json");
  const seedEvidence = createEvidenceBundle([
    controlPair.left.evidence,
    controlPair.right.evidence,
    controlComparison,
  ]);
  await writeFile(
    join(outputRoot, "hypothesis-probe-seed.evidence-bundle.json"),
    `${JSON.stringify(seedEvidence, null, 2)}\n`,
  );
  if (ranking.state !== "probe-recommended") {
    const abstention = {
      ...ranking,
      candidate_source_sha256: digest(candidateSource),
      seed_comparison_evidence_id: controlComparison.evidence_id,
      seed_observation: seedObservation,
      execution: "no-probe-launched",
      reason: ranking.reason,
    };
    await writeFile(planPath, `${JSON.stringify(abstention, null, 2)}\n`);
    console.log(
      JSON.stringify(
        { output: outputRoot, hypothesis_probe_plan: abstention },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const planMaterial = {
    version: 1,
    method: ranking.method,
    reference_identity_sha256: digest(authoritySource),
    candidate_source_sha256: digest(candidateSource),
    domain,
    seed_observation: seedObservation,
    hypothesis_grammar: ranking.hypothesis_grammar,
    surviving_hypothesis_ids: ranking.surviving_hypothesis_ids,
    selected_probe: ranking.selected_probe,
  };
  activeHypothesisPlan = {
    ...ranking,
    plan_sha256: digest(canonicalString(planMaterial)),
    reference_identity_sha256: digest(authoritySource),
    candidate_source_sha256: digest(candidateSource),
    domain,
    seed_comparison_evidence_id: controlComparison.evidence_id,
    seed_observation: seedObservation,
    approval: "awaiting-explicit-probe-digest",
  };
  await writeFile(
    planPath,
    `${JSON.stringify(activeHypothesisPlan, null, 2)}\n`,
  );
  if (hypothesisProbeApproval === undefined) {
    console.log(
      JSON.stringify(
        {
          output: outputRoot,
          hypothesis_probe_plan: activeHypothesisPlan,
          next_step: `Re-run with --approve-hypothesis-probe=${activeHypothesisPlan.plan_sha256} to execute the selected input.`,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  assert.equal(
    hypothesisProbeApproval,
    activeHypothesisPlan.plan_sha256,
    "Hypothesis probe approval must match the fresh plan, candidate source, domain, and seed observation",
  );
  activeHypothesisPlan.approval = "approved-for-this-run";
  await writeFile(
    join(outputRoot, "hypothesis-probe-approval.json"),
    `${JSON.stringify(
      {
        state: "approved-for-this-run",
        approval: "explicit --approve-hypothesis-probe digest",
        plan_sha256: hypothesisProbeApproval,
        planned_input: ranking.selected_probe.input,
      },
      null,
      2,
    )}\n`,
  );
  selectedProbe = {
    ...ranking.selected_probe.input,
    authority_output: undefined,
    candidate_output: undefined,
  };
  candidatesExamined = ranking.examined_input_count;
} else {
  assert.ok(
    selectedProbe,
    "The declared domain should contain a counterexample",
  );
}
const probePair = await capturePair("counterexample", selectedProbe);
const probeComparison = await compare(
  "counterexample",
  probePair.left,
  probePair.right,
);
selectedProbe.authority_output = terminalOutput(probePair.left);
selectedProbe.candidate_output = terminalOutput(probePair.right);

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
const adjacentUnitPrices = [
  (Number(selectedProbe.unit_price) - 0.01).toFixed(2),
  (Number(selectedProbe.unit_price) + 0.01).toFixed(2),
];
const adjacentQuantities = [
  String(Math.max(0, selectedProbe.quantity - 1)),
  String(selectedProbe.quantity + 1),
];
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
      candidate_values: adjacentUnitPrices,
    },
    {
      argument_index: 1,
      observed_value: String(selectedProbe.quantity),
      candidate_values: adjacentQuantities,
    },
  ],
);

const runCandidateRefinement = async (batchEvidence) => {
  const refinementRoot = join(outputRoot, "candidate-refinement");
  await mkdir(refinementRoot);

  const candidateText = candidateSource.toString("utf8");
  let proposal;
  if (blackBoxSynthesis) {
    const observations = [
      {
        id: "control",
        input: {
          unit_price: Number(control.unit_price),
          quantity: control.quantity,
        },
        expected_stdout: terminalOutput(controlPair.left),
        comparison_evidence_id: controlComparison.evidence_id,
      },
      {
        id: "counterexample",
        input: {
          unit_price: Number(selectedProbe.unit_price),
          quantity: selectedProbe.quantity,
        },
        expected_stdout: terminalOutput(probePair.left),
        comparison_evidence_id: probeComparison.evidence_id,
      },
    ];
    const synthesis = synthesizeBlackBoxExpression(
      observations.map(
        ({ id, input, expected_stdout, comparison_evidence_id }) => ({
          id,
          input,
          expected_stdout,
          comparison_evidence_id,
        }),
      ),
    );
    const candidateCall = findCallArguments(candidateText, "printf");
    if (synthesis.state !== "unique-fit-in-declared-grammar") {
      proposal = {
        ...synthesis,
        method: "bounded-enumerative-expression-search",
        application: "not-applied",
        hypothesis_probe_plan_sha256: activeHypothesisPlan?.plan_sha256 ?? null,
        basis_comparison_evidence_ids: observations.map(
          ({ comparison_evidence_id }) => comparison_evidence_id,
        ),
        hypothesis_update: {
          previously_surviving_hypothesis_ids:
            activeHypothesisPlan?.surviving_hypothesis_ids ??
            synthesis.grammar?.map(({ id }) => id) ??
            [],
          observed_output: terminalOutput(probePair.left),
          observation_comparison_evidence_id: probeComparison.evidence_id,
          remaining_hypothesis_ids: synthesis.consistent_hypothesis_ids ?? [],
          eliminated_hypothesis_ids: (
            activeHypothesisPlan?.surviving_hypothesis_ids ??
            synthesis.grammar?.map(({ id }) => id) ??
            []
          ).filter((id) => !synthesis.consistent_hypothesis_ids?.includes(id)),
          contradictory_observation: synthesis.conflict ?? null,
        },
      };
    } else if (candidateCall === undefined) {
      proposal = {
        state: "insufficient-candidate-structure",
        reason:
          "Candidate must contain exactly one balanced two-argument printf call.",
        method: synthesis.method,
      };
    } else {
      const [formatArgument, outputArgument] = candidateCall.arguments;
      const patch = replacementPatch(
        candidateText,
        outputArgument,
        synthesis.expression,
        "candidate.c",
      );
      const sourceIdentity = {
        candidate_source_sha256: digest(candidateSource),
      };
      const proposalSha256 = digest(
        canonicalString({
          version: 1,
          method: synthesis.method,
          ...sourceIdentity,
          grammar: synthesis.grammar,
          selected_hypothesis_id: synthesis.selected_hypothesis_id,
          hypothesis_probe_plan_sha256:
            activeHypothesisPlan?.plan_sha256 ?? null,
          observations: observations.map(({ input, expected_stdout }) => ({
            input,
            expected_stdout,
          })),
          patch,
        }),
      );
      proposal = {
        state:
          outputArgument.text === synthesis.expression
            ? "candidate-already-matches-proposal"
            : "proposed-awaiting-approval",
        proposal_sha256: proposalSha256,
        method: synthesis.method,
        search: synthesis,
        source_identity: sourceIdentity,
        candidate_expression: outputArgument.text,
        proposed_expression: synthesis.expression,
        matched_output_format: formatArgument.text,
        training_observations: observations,
        basis_comparison_evidence_ids: observations.map(
          ({ comparison_evidence_id }) => comparison_evidence_id,
        ),
        hypothesis_probe_plan_sha256: activeHypothesisPlan?.plan_sha256 ?? null,
        hypothesis_update: {
          previously_surviving_hypothesis_ids:
            activeHypothesisPlan?.surviving_hypothesis_ids ??
            synthesis.grammar.map(({ id }) => id),
          observed_output: terminalOutput(probePair.left),
          observation_comparison_evidence_id: probeComparison.evidence_id,
          remaining_hypothesis_ids: synthesis.consistent_hypothesis_ids,
          eliminated_hypothesis_ids: (
            activeHypothesisPlan?.surviving_hypothesis_ids ??
            synthesis.grammar.map(({ id }) => id)
          ).filter((id) => !synthesis.consistent_hypothesis_ids.includes(id)),
          contradictory_observation: null,
        },
        hypothesis_probe_plan_path: activeHypothesisPlan
          ? join(outputRoot, "hypothesis-probe-plan.json")
          : null,
        reference_source_provided_to_synthesizer: false,
        rationale: activeHypothesisPlan
          ? "The approved probe was selected by expected information gain over the surviving grammar hypotheses. Its captured reference output eliminates inconsistent hypotheses, leaving a unique expression that matches the seed control and approved probe. The synthesis function receives only input/output observations; the reference source expression is not passed to it."
          : "A unique expression in the declared grammar matches captured reference outputs for the control and counterexample. The synthesis function receives only these input/output observations; the reference implementation is queried as an executable and its source expression is not passed to the proposer.",
        limitations: activeHypothesisPlan
          ? "The probe ranking assumes a uniform prior over a human-authored five-expression grammar and searches only a human-authored bounded input domain. This is not general program synthesis; only separately captured holdouts test whether the selected expression generalizes."
          : "This is a small, target-specific arithmetic grammar fit to two examples. It is not general program synthesis, and only separately captured holdouts can test whether the selected expression generalizes.",
        patch,
      };
    }
  } else {
    proposal = proposeOutputExpressionTransfer({
      authoritySource: authoritySource.toString("utf8"),
      candidateSource: candidateText,
      comparison: probeComparison,
    });
  }
  const proposalPath = join(refinementRoot, "candidate-patch-proposal.json");
  const proposalPatchPath = join(
    refinementRoot,
    "candidate-patch-proposal.patch",
  );
  await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
  if (proposal.patch !== undefined)
    await writeFile(proposalPatchPath, proposal.patch);
  if (proposal.state !== "proposed-awaiting-approval") {
    const report = {
      ...proposal,
      proposal_path: proposalPath,
      patch_path: proposal.patch === undefined ? null : proposalPatchPath,
      application: "not-applied",
    };
    await writeFile(
      join(refinementRoot, "candidate-refinement.report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  }
  if (proposalApproval === undefined) {
    const report = {
      ...proposal,
      proposal_path: proposalPath,
      patch_path: proposalPatchPath,
      application: "awaiting-explicit-digest-approval",
      approval_argument: `--approve-proposed-patch=${proposal.proposal_sha256}`,
    };
    await writeFile(
      join(refinementRoot, "candidate-refinement.report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(
      join(refinementRoot, "candidate-refinement.evidence-bundle.json"),
      `${JSON.stringify(batchEvidence.normalized_result.evidence_bundle, null, 2)}\n`,
    );
    return report;
  }
  assert.equal(
    proposalApproval,
    proposal.proposal_sha256,
    "Approval digest must match the freshly generated patch, source identity, observations, and active probe plan",
  );

  const authorityCall = blackBoxSynthesis
    ? undefined
    : findCallArguments(authoritySource.toString("utf8"), "printf");
  const candidateCall = findCallArguments(candidateText, "printf");
  assert.ok(candidateCall);
  if (!blackBoxSynthesis) assert.ok(authorityCall);
  const referenceExpression = authorityCall?.arguments[1];
  const candidateExpression = candidateCall.arguments[1];
  const approvedExpression = blackBoxSynthesis
    ? proposal.proposed_expression
    : referenceExpression?.text;
  assert.equal(typeof approvedExpression, "string");
  const approvedSource = replaceSourceRange(
    candidateText,
    candidateExpression,
    approvedExpression,
  );
  const overfitReplacement = blackBoxSynthesis
    ? `((unit_price == ${selectedProbe.unit_price} && quantity == ${selectedProbe.quantity}) ? ${Number(selectedProbe.authority_output)} : (${candidateExpression.text}))`
    : `(unit_price == ${selectedProbe.unit_price} && quantity == ${selectedProbe.quantity} ` +
      `? (${referenceExpression?.text}) : (${candidateExpression.text}))`;
  const overfitExpression = overfitReplacement;
  const overfitSource = replaceSourceRange(
    candidateText,
    candidateExpression,
    overfitExpression,
  );
  const overfitSourcePath = join(refinementRoot, "candidate-overfit.c");
  const approvedSourcePath = join(refinementRoot, "candidate-approved.c");
  const overfitBinary = join(refinementRoot, "candidate-overfit");
  const approvedBinary = join(refinementRoot, "candidate-approved");
  await Promise.all([
    writeFile(overfitSourcePath, overfitSource),
    writeFile(approvedSourcePath, approvedSource),
    writeFile(
      join(refinementRoot, "candidate-overfit.patch"),
      replacementPatch(
        candidateText,
        candidateExpression,
        overfitExpression,
        "candidate-overfit.c",
      ),
    ),
  ]);

  const compileScratch = async (label, sourcePath, binaryPath) => {
    const args = [
      "-std=c11",
      "-O0",
      "-Wall",
      "-Wextra",
      "-Werror",
      sourcePath,
      "-lm",
      "-o",
      binaryPath,
    ];
    const result = spawnSync(compiler, args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const build = {
      compiler,
      compiler_version: compilerVersion,
      arguments: args,
      source_path: sourcePath,
      source_sha256: digest(await readFile(sourcePath)),
      binary_path: binaryPath,
      binary_sha256:
        result.status === 0 ? digest(await readFile(binaryPath)) : null,
      exit_code: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
    await writeFile(
      join(refinementRoot, `${label}.build.json`),
      `${JSON.stringify(build, null, 2)}\n`,
    );
    if (result.error !== undefined) throw result.error;
    assert.equal(result.status, 0, `${label} candidate must compile`);
    return build;
  };

  const builds = await Promise.all([
    compileScratch("candidate-overfit", overfitSourcePath, overfitBinary),
    compileScratch("candidate-approved", approvedSourcePath, approvedBinary),
  ]);
  const scenarios = [
    { id: "control", input: control },
    { id: "counterexample", input: selectedProbe },
    {
      id: "neighbor-below",
      input: { unit_price: "1.04", quantity: selectedProbe.quantity },
    },
    {
      id: "neighbor-above",
      input: { unit_price: "1.06", quantity: selectedProbe.quantity },
    },
    {
      id: "additional-quantity",
      input: { unit_price: selectedProbe.unit_price, quantity: 2 },
    },
  ];
  const evidenceRecords = [
    ...batchEvidence.normalized_result.evidence_bundle.records,
  ];
  const authorityCaptures = new Map();
  for (const scenario of scenarios) {
    const evidence = await capture(
      `refinement-${scenario.id}-authority`,
      authorityBinary,
      scenario.input,
    );
    const captureRecord = {
      path: join(
        outputRoot,
        `refinement-${scenario.id}-authority.capture.json`,
      ),
      evidence,
    };
    authorityCaptures.set(scenario.id, captureRecord);
    evidenceRecords.push(evidence);
  }

  const compareCandidate = async (revision, binaryPath) => {
    const comparisons = [];
    for (const scenario of scenarios) {
      const authority = authorityCaptures.get(scenario.id);
      assert.ok(authority, `Missing authority capture for ${scenario.id}`);
      const candidateEvidence = await capture(
        `refinement-${revision}-${scenario.id}-candidate`,
        binaryPath,
        scenario.input,
      );
      const candidateCapture = {
        path: join(
          outputRoot,
          `refinement-${revision}-${scenario.id}-candidate.capture.json`,
        ),
        evidence: candidateEvidence,
      };
      evidenceRecords.push(candidateEvidence);
      const comparison = await compare(
        `refinement-${revision}-${scenario.id}`,
        authority,
        candidateCapture,
      );
      evidenceRecords.push(comparison);
      comparisons.push({ id: scenario.id, evidence: comparison });
    }
    return comparisons;
  };

  const overfitComparisons = await compareCandidate("overfit", overfitBinary);
  const approvedComparisons = await compareCandidate(
    "approved",
    approvedBinary,
  );
  const evidenceBundle = createEvidenceBundle(evidenceRecords);
  const verifyComparisons = async (label, comparisons) => {
    const specificationInputPath = join(
      refinementRoot,
      `${label}.specification.input.json`,
    );
    await writeFile(
      specificationInputPath,
      `${JSON.stringify(
        {
          name: `C candidate ${label} compatibility`,
          evidence_bundle: evidenceBundle,
          comparisons: comparisons.map(({ evidence }) => ({
            comparison_evidence_id: evidence.evidence_id,
            dimensions: ["terminal"],
          })),
        },
        null,
        2,
      )}\n`,
    );
    const specificationEvidence = JSON.parse(
      run(process.execPath, [
        cliPath,
        "derive-reconstruction-specification",
        specificationInputPath,
        "--format",
        "json",
      ]).stdout,
    );
    await writeFile(
      join(refinementRoot, `${label}.specification.evidence.json`),
      `${JSON.stringify(specificationEvidence, null, 2)}\n`,
    );
    const verificationInputPath = join(
      refinementRoot,
      `${label}.verification.input.json`,
    );
    await writeFile(
      verificationInputPath,
      `${JSON.stringify(
        {
          specification: specificationEvidence.normalized_result.specification,
          evidence_bundle: evidenceBundle,
        },
        null,
        2,
      )}\n`,
    );
    const verificationEvidence = JSON.parse(
      run(process.execPath, [
        cliPath,
        "verify-reconstruction",
        verificationInputPath,
        "--format",
        "json",
      ]).stdout,
    );
    await writeFile(
      join(refinementRoot, `${label}.verification.evidence.json`),
      `${JSON.stringify(verificationEvidence, null, 2)}\n`,
    );
    const labels = new Map(
      comparisons.map(({ id, evidence }) => [evidence.evidence_id, id]),
    );
    const statuses = Object.fromEntries(
      verificationEvidence.normalized_result.claims.items.map(
        ({ comparison_evidence_id, status }) => [
          labels.get(comparison_evidence_id),
          status,
        ],
      ),
    );
    return { specificationEvidence, verificationEvidence, statuses };
  };

  const overfitVerification = await verifyComparisons(
    "overfit",
    overfitComparisons,
  );
  const approvedVerification = await verifyComparisons(
    "approved",
    approvedComparisons,
  );
  assert.deepEqual(overfitVerification.statuses, {
    control: "pass",
    counterexample: "pass",
    "neighbor-below": "fail",
    "neighbor-above": "fail",
    "additional-quantity": "fail",
  });
  assert.deepEqual(approvedVerification.statuses, {
    control: "pass",
    counterexample: "pass",
    "neighbor-below": "pass",
    "neighbor-above": "pass",
    "additional-quantity": "pass",
  });
  assert.equal(
    digest(await readFile(join(fixtureRoot, "candidate.c"))),
    digest(candidateSource),
    "The repository-owned candidate must remain unchanged",
  );

  const report = {
    ...proposal,
    state: "approved-proposal-verified",
    proposal_path: proposalPath,
    patch_path: proposalPatchPath,
    approval: {
      state: "approved-for-this-run",
      argument: `--approve-proposed-patch=${proposalApproval}`,
      proposal_sha256: proposal.proposal_sha256,
    },
    authority_source_sha256: digest(authoritySource),
    original_candidate_source_sha256: digest(candidateSource),
    original_candidate_preserved: true,
    approved_candidate: {
      source_path: approvedSourcePath,
      source_sha256: digest(approvedSource),
    },
    rejected_overfit_source_path: overfitSourcePath,
    rejected_overfit_source_sha256: digest(overfitSource),
    builds,
    overfit_verification: {
      status: overfitVerification.verificationEvidence.normalized_result.status,
      claim_statuses: overfitVerification.statuses,
      decision:
        "rejected because the targeted example fix regresses neighboring and additional inputs",
    },
    approved_proposal_verification: {
      status:
        approvedVerification.verificationEvidence.normalized_result.status,
      claim_statuses: approvedVerification.statuses,
      decision: "accepted for these five observed terminal claims only",
    },
    evidence_bundle_path: join(
      refinementRoot,
      "candidate-refinement.evidence-bundle.json",
    ),
    overfit_specification_evidence_path: join(
      refinementRoot,
      "overfit.specification.evidence.json",
    ),
    overfit_verification_evidence_path: join(
      refinementRoot,
      "overfit.verification.evidence.json",
    ),
    approved_specification_evidence_path: join(
      refinementRoot,
      "approved.specification.evidence.json",
    ),
    approved_verification_evidence_path: join(
      refinementRoot,
      "approved.verification.evidence.json",
    ),
    limitation: blackBoxSynthesis
      ? activeHypothesisDiscrimination
        ? "The proposer fits a declared five-expression arithmetic grammar from a human-authored bounded domain and uniform prior. The additional probe is selected by expected information gain, but this does not demonstrate general program synthesis or behavioral equivalence. The reference source remains present in the repository outside the proposer input boundary."
        : "The proposer fits a declared five-expression arithmetic grammar from two observations; this does not demonstrate general program synthesis or behavioral equivalence. The input domain and initial probe search remain human-authored, and the reference source remains present in the repository outside the proposer input boundary."
      : "This source-differential expression transfer and finite owned C fixture do not demonstrate semantic patch synthesis or general behavioral equivalence.",
  };
  await Promise.all([
    writeFile(
      join(refinementRoot, "candidate-refinement.evidence-bundle.json"),
      `${JSON.stringify(evidenceBundle, null, 2)}\n`,
    ),
    writeFile(
      join(refinementRoot, "candidate-refinement.report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    ),
  ]);
  return report;
};

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
      const failedCaptureScenarios = [];
      const failedCapturePlan =
        await executeApprovedReconstructionProcessProbeBatch(
          plan,
          plan.plan_sha256,
          {
            validateTarget: async ({ executable, expected_sha256 }) =>
              digest(await readFile(executable)) === expected_sha256,
            capture: async (scenario) => {
              failedCaptureScenarios.push(scenario);
              throw new Error("fixture capture failure");
            },
          },
        );
      assert.equal(failedCapturePlan.ok, true);
      if (!failedCapturePlan.ok)
        throw new Error(failedCapturePlan.error.message);
      assert.equal(failedCapturePlan.value.normalized_result.state, "partial");
      const failedProbeResults =
        failedCapturePlan.value.normalized_result.probes;
      assert.equal(failedProbeResults.length, plan.probes.length);
      assert.deepEqual(
        failedProbeResults.map(({ selection, status, reason }) => ({
          selection,
          status,
          reason,
        })),
        [
          {
            selection: plan.probes[0].selection,
            status: "capture-failed",
            reason: undefined,
          },
          {
            selection: plan.probes[1].selection,
            status: "not-run",
            reason:
              "Execution stopped after an earlier capture failure; this approved probe was not launched.",
          },
        ],
        "Partial Evidence must preserve plan order and distinguish the failed probe from the skipped probe",
      );
      assert.equal(
        failedCaptureScenarios.length,
        1,
        "The batch must not retry or launch later approved probes after a capture failure",
      );
      assert.deepEqual(
        failedCaptureScenarios[0],
        plan.probes[0].left_scenario,
        "Only the first approved probe's left scenario may reach the failing capture adapter",
      );
      assert.equal(
        failedProbeResults[0].right_capture_evidence_id,
        undefined,
        "A failed left capture must not fabricate a right capture or comparison",
      );
      assert.equal(
        failedProbeResults[0].comparison_evidence_id,
        undefined,
        "A failed capture must not fabricate a comparison",
      );
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
      const candidateRefinement = refineCandidate
        ? await runCandidateRefinement(batch.value)
        : { state: "not-requested" };
      const result = batch.value.normalized_result;
      assert.equal(result.state, "complete");
      assert.equal(result.probes.length, 2);
      const expectedVerificationStatuses = plan.probes.map(
        ({ left_scenario, right_scenario }) => {
          const leftOutput = execute(
            left_scenario.executable,
            left_scenario.arguments[0],
            Number(left_scenario.arguments[1]),
          );
          const rightOutput = execute(
            right_scenario.executable,
            right_scenario.arguments[0],
            Number(right_scenario.arguments[1]),
          );
          return leftOutput === rightOutput ? "pass" : "fail";
        },
      );
      assert.deepEqual(
        result.probes.map(({ status, verification_status }) => ({
          status,
          verification_status,
        })),
        expectedVerificationStatuses.map((verification_status) => ({
          status: "compared",
          verification_status,
        })),
        "Follow-up claim outcomes must match the captured process outputs",
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
        candidate_refinement: candidateRefinement,
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
  candidate_refinement:
    feedback.candidate_refinement ??
    (refineCandidate
      ? { state: "approval-required" }
      : { state: "not-requested" }),
  hypothesis_probe_plan_sha256: activeHypothesisPlan?.plan_sha256 ?? null,
  limitation: activeHypothesisDiscrimination
    ? "The expression grammar, uniform hypothesis prior, bounded domain, comparison dimension, and holdout cases are human-selected. The next input is ranked by expected information gain over this grammar; this does not establish correctness outside it."
    : "The domain, half-unit probe rule, comparison Evidence, and dimensions included in the draft are human-selected. A terminal pass covers the selected captured scenario only; overall process behavior remains unknown when dimensions are unobserved.",
};

const claimCounts = Object.values(summary.claim_statuses).reduce(
  (counts, status) => {
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  },
  {},
);
const reportPath = join(outputRoot, "REE_RECONSTRUCTION_REPORT.md");
const report = [
  "# REE — bounded C reconstruction report",
  "",
  "> This report summarizes the repository-owned C rounding fixture. It is a",
  "> readable view of this experiment's retained Evidence, not a general",
  "> equivalence certificate.",
  "",
  "## Result",
  "",
  `**Verifier result: ${verificationResult.status.toUpperCase()}** — this fixture intentionally starts with an incorrect candidate, so the expected result is one matching control and one counterexample. The harness exits successfully when it observes those expected outcomes.`,
  "",
  `Declared claims: ${summary.derived_claim_count} (${claimCounts.pass ?? 0} passed, ${claimCounts.fail ?? 0} failed, ${claimCounts.unknown ?? 0} unknown).`,
  "",
  "## Captured terminal cases",
  "",
  "| Case | Input (unit price × quantity) | Reference output | Candidate output | Terminal claim |",
  "| --- | --- | --- | --- | --- |",
  `| Agreement control | ${control.unit_price} × ${control.quantity} | ${terminalOutput(controlPair.left)} | ${terminalOutput(controlPair.right)} | ${summary.claim_statuses["control.terminal"]} |`,
  `| Discovered counterexample | ${summary.selected_probe.unit_price} × ${summary.selected_probe.quantity} | ${summary.selected_probe.authority_output} | ${summary.selected_probe.candidate_output} | ${summary.claim_statuses["counterexample.terminal"]} |`,
  "",
  "The candidate disagreed at the selected half-unit boundary. The planner's declared search range was 100–200 cents with quantities 1, 2, 3, and 10; the search and boundary rule are experiment inputs, not inferred universal behavior.",
  "",
  "## Evidence and artifact identity",
  "",
  `- Control comparison: \`${summary.comparison_evidence_ids.control}\``,
  `- Counterexample comparison: \`${summary.comparison_evidence_ids.counterexample}\``,
  `- Reconstruction specification: \`${summary.specification_evidence_id}\``,
  `- Verification: \`${summary.verification_evidence_id}\``,
  `- Reference source SHA-256: \`${summary.authority_source_sha256}\``,
  `- Candidate source SHA-256: \`${summary.candidate_source_sha256}\``,
  `- Reference binary SHA-256: \`${summary.authority_binary_sha256}\``,
  `- Candidate binary SHA-256: \`${summary.candidate_binary_sha256}\``,
  `- Environment: ${summary.compiler}; Node ${summary.node}; ${summary.platform}/${summary.architecture}.`,
  "",
  "Open `verification.evidence.json`, `specification.evidence.json`, the capture files, and the comparison files in the same output directory to inspect the full records. `summary.json` retains the experiment parameters and recommendation state.",
  "",
  "## Limits",
  "",
  summary.limitation,
  "",
  "Only the selected terminal outputs were claimed here. Process lifecycle and other unobserved dimensions remain unknown. A finite pass or fail applies to these recorded cases; it does not establish general behavioral equivalence.",
  "",
  "## Reproduce",
  "",
  "Run from the repository root with the pinned Node/npm toolchain and Clang:",
  "",
  "```sh",
  "npm run verify:ree-investigation-boundary -- /tmp/ree-c-investigation",
  "```",
  "",
].join("\n");

await writeFile(
  join(outputRoot, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(reportPath, report);
const savedReport = await readFile(reportPath, "utf8");
assert.match(savedReport, /Verifier result: FAIL/u);
assert.match(savedReport, /Agreement control/u);
assert.match(savedReport, /Discovered counterexample/u);
assert.ok(savedReport.includes(summary.verification_evidence_id));
console.log(
  JSON.stringify(
    { output: outputRoot, report: reportPath, ...summary },
    null,
    2,
  ),
);
