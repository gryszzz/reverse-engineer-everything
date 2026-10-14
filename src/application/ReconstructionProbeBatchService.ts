import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";
import {
  compareProcessCaptures,
  processCaptureComparisonSchema,
} from "../domain/process/processComparison.js";
import { PROCESS_PROVIDER } from "../domain/process/processEvidenceProvider.js";
import { parseProcessCapture } from "../domain/process/processCaptureParsing.js";
import {
  processScenarioCommitment,
  processScenarioSchema,
  type ProcessScenario,
} from "../domain/process/processScenario.js";
import {
  reconstructionSpecificationSchema,
  type ReconstructionClaim,
} from "../domain/reconstructionVerificationSchemas.js";
import {
  reconstructionVerificationRequestSchema,
  type ReconstructionVerificationResult,
} from "../domain/reconstructionVerificationSchemas.js";
import type { ReconstructionVerificationRequest } from "./ReconstructionVerificationService.js";
import {
  createReconstructionVerificationEvidence,
  evaluateReconstructionVerificationValidated,
} from "./ReconstructionVerificationService.js";
import { RECONSTRUCTION_PROVIDER } from "./InvestigationProviders.js";
import { requestInputError, workflowInputError } from "./workflowInputError.js";
import { err, ok, type Result } from "../domain/result.js";

const OPERATION = "execute_reconstruction_probe_batch" as const;
export const MAX_RECONSTRUCTION_PROCESS_PROBES = 4;

const probeSelectionSchema = z.strictObject({
  left_source_evidence_id: z.string().startsWith("ev_"),
  right_source_evidence_id: z.string().startsWith("ev_"),
  argument_index: z.number().int().nonnegative(),
  candidate_value: z.string(),
});

const selectedProbePlanSchema = z.strictObject({
  selection: probeSelectionSchema,
  left_scenario: processScenarioSchema,
  right_scenario: processScenarioSchema,
  left_executable_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  right_executable_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source_comparison_evidence_id: z.string().startsWith("ev_"),
  source_claim_id: z.string().min(1),
});

const planBodySchema = z
  .strictObject({
    version: z.literal(1),
    verification_request: reconstructionVerificationRequestSchema,
    probes: z
      .array(selectedProbePlanSchema)
      .min(1)
      .max(MAX_RECONSTRUCTION_PROCESS_PROBES),
    deduplicated_selection_count: z.number().int().nonnegative(),
    execution_budget: z.strictObject({
      max_probes: z
        .number()
        .int()
        .min(1)
        .max(MAX_RECONSTRUCTION_PROCESS_PROBES),
      process_captures: z.number().int().nonnegative(),
      comparisons: z.number().int().nonnegative(),
      retries: z.literal(0),
    }),
  })
  .superRefine((plan, context) => {
    if (plan.probes.length > plan.execution_budget.max_probes)
      context.addIssue({
        code: "custom",
        path: ["execution_budget", "max_probes"],
        message:
          "The execution budget cannot be smaller than its approved probe plan.",
      });
    if (plan.execution_budget.process_captures !== plan.probes.length * 2)
      context.addIssue({
        code: "custom",
        path: ["execution_budget", "process_captures"],
        message: "Each process probe requires exactly two captures.",
      });
    if (plan.execution_budget.comparisons !== plan.probes.length)
      context.addIssue({
        code: "custom",
        path: ["execution_budget", "comparisons"],
        message: "Each process probe requires exactly one comparison.",
      });
    const selections = plan.probes.map(
      ({ selection }) => canonicalize(selection) ?? "",
    );
    if (new Set(selections).size !== selections.length)
      context.addIssue({
        code: "custom",
        path: ["probes"],
        message:
          "An approved process probe plan cannot contain duplicate selections.",
      });
  });

export const reconstructionProcessProbePlanSchema = planBodySchema.extend({
  plan_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type ReconstructionProcessProbeSelection = z.infer<
  typeof probeSelectionSchema
>;
export type ReconstructionProcessProbePlan = z.infer<
  typeof reconstructionProcessProbePlanSchema
>;

export const reconstructionProcessProbeBatchRequestSchema = z.strictObject({
  verification_request: reconstructionVerificationRequestSchema,
  selections: z.array(probeSelectionSchema).min(1).max(32),
  max_probes: z.number().int().min(1).max(MAX_RECONSTRUCTION_PROCESS_PROBES),
});

export type ReconstructionProcessProbeBatchRequest = z.infer<
  typeof reconstructionProcessProbeBatchRequestSchema
>;

export interface ReconstructionProcessProbeBatchPorts {
  /** Validate the executable identity immediately before launching any target. */
  readonly validateTarget: (target: {
    readonly executable: string;
    readonly expected_sha256: string;
    readonly source_evidence_id: string;
  }) => Promise<boolean>;
  /** Capture one exact, already-approved process scenario. */
  readonly capture: (scenario: ProcessScenario) => Promise<Evidence>;
}

/** Derive a deterministic, exact-plan digest from current verifier recommendations. */
export const prepareReconstructionProcessProbeBatch = (
  input: unknown,
): Result<ReconstructionProcessProbePlan, AnalysisError> => {
  const parsed = reconstructionProcessProbeBatchRequestSchema.safeParse(input);
  if (!parsed.success)
    return err(requestInputError(OPERATION, parsed.error, input));
  try {
    const verification = evaluateReconstructionVerificationValidated(
      parsed.data.verification_request,
    );
    if (!verification.ok) return verification;
    const records = new Map(
      parsed.data.verification_request.evidence_bundle.records.map((record) => [
        record.evidence_id,
        record,
      ]),
    );
    const prepared = new Map<string, z.infer<typeof selectedProbePlanSchema>>();
    for (const selection of parsed.data.selections) {
      const match = findRecommendation(
        verification.value,
        parsed.data.verification_request.specification,
        selection,
      );
      if (!match)
        return err(
          inputFailure(
            "selections",
            "Each selected input must exactly match a current verifier recommendation and its source Evidence.",
          ),
        );
      const sourceClaim =
        parsed.data.verification_request.specification.claims.find(
          ({ comparison_evidence_id, dimension, kind }) =>
            kind === "behavioral" &&
            dimension === "terminal" &&
            comparison_evidence_id === match.comparison_evidence_id,
        );
      if (sourceClaim === undefined)
        return err(
          inputFailure(
            "selections",
            "A process probe can be planned only for a selected terminal reconstruction claim.",
          ),
        );
      const left = sourceProcessScenario(
        records.get(selection.left_source_evidence_id),
        selection.left_source_evidence_id,
        selection.argument_index,
        match.observed_value,
        selection.candidate_value,
      );
      if (!left.ok) return left;
      const right = sourceProcessScenario(
        records.get(selection.right_source_evidence_id),
        selection.right_source_evidence_id,
        selection.argument_index,
        match.observed_value,
        selection.candidate_value,
      );
      if (!right.ok) return right;
      if (
        left.value.executable_sha256 === right.value.executable_sha256 &&
        left.value.scenario.executable === right.value.scenario.executable
      )
        return err(
          inputFailure(
            "selections",
            "The source pair must identify two distinct executable targets.",
          ),
        );
      const key = selectionKey(selection);
      if (prepared.has(key)) continue;
      prepared.set(key, {
        selection,
        left_scenario: left.value.scenario,
        right_scenario: right.value.scenario,
        left_executable_sha256: left.value.executable_sha256,
        right_executable_sha256: right.value.executable_sha256,
        source_comparison_evidence_id: match.comparison_evidence_id,
        source_claim_id: sourceClaim.claim_id,
      });
    }
    const probes = [...prepared.values()].sort((left, right) =>
      compareSelection(left.selection, right.selection),
    );
    if (probes.length > parsed.data.max_probes)
      return err(
        inputFailure(
          "max_probes",
          `The approved batch contains ${String(probes.length)} unique probes, exceeding its limit of ${String(parsed.data.max_probes)}. Reduce the selected probes or explicitly prepare a larger bounded plan.`,
        ),
      );
    if (probes.length === 0)
      return err(
        inputFailure(
          "selections",
          "No unique probes remain after deduplication.",
        ),
      );
    const body = planBodySchema.parse({
      version: 1,
      verification_request: parsed.data.verification_request,
      probes,
      deduplicated_selection_count:
        parsed.data.selections.length - probes.length,
      execution_budget: {
        max_probes: parsed.data.max_probes,
        process_captures: probes.length * 2,
        comparisons: probes.length,
        retries: 0,
      },
    });
    const plan = reconstructionProcessProbePlanSchema.parse({
      ...body,
      plan_sha256: digest(body),
    });
    return ok(plan);
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError || cause instanceof TypeError)
      return err(workflowInputError(OPERATION, cause));
    return err(
      new AnalysisProtocolError("Process probe plan preparation failed", {
        cause,
      }),
    );
  }
};

/** Execute only the exact plan whose digest the investigator approved. */
export const executeApprovedReconstructionProcessProbeBatch = async (
  planInput: unknown,
  approvedPlanSha256: string,
  ports: ReconstructionProcessProbeBatchPorts,
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = reconstructionProcessProbePlanSchema.safeParse(planInput);
  if (!parsed.success)
    return err(requestInputError(OPERATION, parsed.error, planInput));
  const plan = parsed.data;
  const { plan_sha256: planSha256, ...body } = plan;
  if (digest(body) !== planSha256 || approvedPlanSha256 !== planSha256)
    return err(
      inputFailure(
        "approved_plan_sha256",
        "The approval does not match this exact immutable process probe plan. Prepare and approve the changed plan before execution.",
      ),
    );

  const targets = uniqueTargets(plan);
  for (const target of targets) {
    let valid: boolean;
    try {
      valid = await ports.validateTarget(target);
    } catch (cause: unknown) {
      return err(
        inputFailure(
          "plan_sha256",
          `Target identity validation failed for ${target.source_evidence_id}: ${safeError(cause)}`,
        ),
      );
    }
    if (!valid)
      return err(
        inputFailure(
          "plan_sha256",
          `Executable identity changed or could not be verified for source Evidence ${target.source_evidence_id}; no probes were executed.`,
        ),
      );
  }

  try {
    const records = [...plan.verification_request.evidence_bundle.records];
    const completed: {
      readonly selection: ReconstructionProcessProbeSelection;
      readonly left_capture_evidence_id?: string;
      readonly right_capture_evidence_id?: string;
      readonly comparison_evidence_id?: string;
      readonly status: "compared" | "capture-failed";
      readonly failure?: string;
    }[] = [];
    for (const probe of plan.probes) {
      let leftCapture: Evidence;
      try {
        await validateApprovedTarget(ports, {
          executable: processScenarioSchema.parse(probe.left_scenario)
            .executable,
          expected_sha256: probe.left_executable_sha256,
          source_evidence_id: probe.selection.left_source_evidence_id,
        });
        leftCapture = await ports.capture(
          processScenarioSchema.parse(probe.left_scenario),
        );
        records.push(parseEvidence(leftCapture));
        validateCapturedTarget(
          leftCapture,
          processScenarioSchema.parse(probe.left_scenario),
          probe.left_executable_sha256,
        );
      } catch (cause: unknown) {
        completed.push({
          selection: probe.selection,
          status: "capture-failed",
          failure: safeError(cause),
        });
        break;
      }
      let rightCapture: Evidence;
      try {
        await validateApprovedTarget(ports, {
          executable: processScenarioSchema.parse(probe.right_scenario)
            .executable,
          expected_sha256: probe.right_executable_sha256,
          source_evidence_id: probe.selection.right_source_evidence_id,
        });
        rightCapture = await ports.capture(
          processScenarioSchema.parse(probe.right_scenario),
        );
        records.push(parseEvidence(rightCapture));
        validateCapturedTarget(
          rightCapture,
          processScenarioSchema.parse(probe.right_scenario),
          probe.right_executable_sha256,
        );
      } catch (cause: unknown) {
        completed.push({
          selection: probe.selection,
          left_capture_evidence_id: leftCapture.evidence_id,
          status: "capture-failed",
          failure: safeError(cause),
        });
        break;
      }
      const left = parseProcessCapture(leftCapture.normalized_result);
      const right = parseProcessCapture(rightCapture.normalized_result);
      const comparisonResult = compareProcessCaptures(left, right);
      const comparison = createProcessComparisonEvidence(
        leftCapture,
        rightCapture,
        comparisonResult,
      );
      records.push(comparison);
      completed.push({
        selection: probe.selection,
        left_capture_evidence_id: leftCapture.evidence_id,
        right_capture_evidence_id: rightCapture.evidence_id,
        comparison_evidence_id: comparison.evidence_id,
        status: "compared",
      });
      if (
        records.length -
          plan.verification_request.evidence_bundle.records.length >=
        plan.execution_budget.process_captures +
          plan.execution_budget.comparisons
      )
        break;
    }

    const addedClaims: ReconstructionClaim[] = [];
    for (const item of completed) {
      if (item.comparison_evidence_id === undefined) continue;
      const probe = plan.probes.find(
        ({ selection }) =>
          selectionKey(selection) === selectionKey(item.selection),
      );
      const sourceClaim = plan.verification_request.specification.claims.find(
        ({ claim_id }) => claim_id === probe?.source_claim_id,
      );
      if (sourceClaim === undefined) continue;
      addedClaims.push({
        ...sourceClaim,
        claim_id: `${sourceClaim.claim_id}.probe.${item.comparison_evidence_id.slice(3, 19)}`,
        title: `${sourceClaim.title}; approved probe ${item.selection.candidate_value}`,
        comparison_evidence_id: item.comparison_evidence_id,
      });
    }
    const specification = reconstructionSpecificationSchema.parse({
      ...plan.verification_request.specification,
      name: `${plan.verification_request.specification.name} — approved process probes`,
      claims: [
        ...plan.verification_request.specification.claims,
        ...addedClaims,
      ],
    });
    const bundle = createEvidenceBundle(
      records,
      plan.verification_request.evidence_bundle.unknowns,
    );
    const verification = evaluateReconstructionVerificationValidated({
      specification,
      evidence_bundle: bundle,
    });
    if (!verification.ok) return verification;
    const verificationEvidence = createReconstructionVerificationEvidence(
      specification,
      verification.value,
    );
    const finalBundle = createEvidenceBundle(
      [...records, verificationEvidence],
      plan.verification_request.evidence_bundle.unknowns,
    );
    const probeStatuses = completed.map((item) => {
      const comparisonId = item.comparison_evidence_id;
      const claim =
        comparisonId === undefined
          ? undefined
          : verification.value.claims.items.find(
              ({ comparison_evidence_id, dimension }) =>
                comparison_evidence_id === comparisonId &&
                dimension === "terminal",
            );
      return {
        ...item,
        ...(claim === undefined ? {} : { verification_status: claim.status }),
      };
    });
    const evidence = createEvidence(undefined, RECONSTRUCTION_PROVIDER, {
      predicateType: "rea.reconstruction-process-probe-batch",
      operation: OPERATION,
      parameters: jsonObjectSchema.parse({
        plan_sha256: plan.plan_sha256,
        approved_plan_sha256: approvedPlanSha256,
        selected_probe_count: plan.probes.length,
        executed_probe_count: completed.filter(
          ({ status }) => status === "compared",
        ).length,
      }),
      result: jsonValueSchema.parse({
        plan_sha256: plan.plan_sha256,
        execution_budget: plan.execution_budget,
        deduplicated_selection_count: plan.deduplicated_selection_count,
        state: completed.some(({ status }) => status === "capture-failed")
          ? "partial"
          : "complete",
        probes: probeStatuses,
        specification,
        verification: verificationEvidence,
        evidence_bundle: finalBundle,
      }),
      confidence: "derived",
      authority: "analyst-inference",
      limitations: [
        "Only the exact selected process argument probes in this approved plan were executed; no retries or other target classes are included.",
        "Verification covers only the declared finite claims and accumulated Evidence, not global program equivalence.",
        "Process captures preserve their recorded ambient-environment limitations; an approved plan does not prove environmental completeness.",
      ],
      evidenceLinks: [
        ...plan.verification_request.evidence_bundle.records.map(
          ({ evidence_id }) => evidence_id,
        ),
        ...records
          .slice(plan.verification_request.evidence_bundle.records.length)
          .map(({ evidence_id }) => evidence_id),
        verificationEvidence.evidence_id,
      ],
    });
    return ok(evidence);
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError || cause instanceof TypeError)
      return err(workflowInputError(OPERATION, cause));
    return err(
      new AnalysisProtocolError("Approved process probe batch failed", {
        cause,
      }),
    );
  }
};

const validateApprovedTarget = async (
  ports: ReconstructionProcessProbeBatchPorts,
  target: {
    readonly executable: string;
    readonly expected_sha256: string;
    readonly source_evidence_id: string;
  },
): Promise<void> => {
  let valid: boolean;
  try {
    valid = await ports.validateTarget(target);
  } catch (cause: unknown) {
    throw new TypeError(
      `Target identity validation failed for ${target.source_evidence_id}: ${safeError(cause)}`,
    );
  }
  if (!valid)
    throw new TypeError(
      `Executable identity changed or could not be verified for source Evidence ${target.source_evidence_id}`,
    );
};

const findRecommendation = (
  verification: ReconstructionVerificationResult,
  specification: ReconstructionProcessProbeBatchRequest["verification_request"]["specification"],
  selection: ReconstructionProcessProbeSelection,
) => {
  for (const item of verification.recommended_probes) {
    if (item.operation !== "capture_process_scenario") continue;
    const variation = item.argument_variations?.find(
      ({
        left_source_evidence_id: left,
        right_source_evidence_id: right,
        argument_index: index,
        candidate_values,
      }) =>
        left === selection.left_source_evidence_id &&
        right === selection.right_source_evidence_id &&
        index === selection.argument_index &&
        candidate_values.includes(selection.candidate_value),
    );
    if (variation !== undefined) {
      const sourceClaim = specification.claims.find(({ claim_id }) =>
        item.claim_ids.includes(claim_id),
      );
      if (sourceClaim === undefined) continue;
      return {
        comparison_evidence_id: sourceClaim.comparison_evidence_id,
        observed_value: variation.observed_value,
      };
    }
  }
  return undefined;
};

const sourceProcessScenario = (
  source: Evidence | undefined,
  sourceId: string,
  argumentIndex: number,
  observedValue: string,
  candidateValue: string,
) => {
  if (
    source === undefined ||
    source.evidence_id !== sourceId ||
    source.operation !== "capture_process_scenario" ||
    source.predicate_type !== "rea.process-capture"
  )
    return err(
      inputFailure(
        "selections",
        `Source ${sourceId} is not process-capture Evidence.`,
      ),
    );
  const capture = parseProcessCapture(source.normalized_result);
  if (
    capture.manifest.executable_identity.state !== "path_metadata_unchanged" ||
    capture.manifest.executable_sha256 === null ||
    capture.manifest.executable_sha256 !==
      capture.manifest.selected_executable_sha256
  )
    return err(
      inputFailure(
        "selections",
        `Source executable identity is not verified for ${sourceId}.`,
      ),
    );
  const committed = { ...capture.manifest.scenario };
  delete committed["executable_sha256"];
  const events = committed["events"];
  if (
    Array.isArray(events) &&
    events.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        Reflect.get(event, "type") === "input" &&
        Reflect.get(event, "sensitive") === true,
    )
  )
    return err(
      inputFailure(
        "selections",
        `Sensitive input events cannot be reconstructed from source Evidence ${sourceId}.`,
      ),
    );
  const parsedScenario = processScenarioSchema.safeParse(committed);
  if (!parsedScenario.success)
    return err(requestInputError(OPERATION, parsedScenario.error, committed));
  const scenario = parsedScenario.data;
  if (scenario.arguments[argumentIndex] !== observedValue)
    return err(
      inputFailure(
        "selections",
        `Argument ${String(argumentIndex)} in source ${sourceId} differs from its recommended observed value.`,
      ),
    );
  const arguments_ = [...scenario.arguments];
  arguments_[argumentIndex] = candidateValue;
  const revisedScenario = processScenarioSchema.parse({
    ...scenario,
    arguments: arguments_,
  });
  return ok({
    scenario: revisedScenario,
    executable_sha256: capture.manifest.executable_sha256,
  });
};

const validateCapturedTarget = (
  evidenceInput: Evidence,
  expectedScenario: ProcessScenario,
  expectedSha256: string,
): void => {
  const evidence = parseEvidence(evidenceInput);
  if (
    evidence.operation !== "capture_process_scenario" ||
    evidence.predicate_type !== "rea.process-capture"
  )
    throw new TypeError("Capture adapter returned non-process Evidence");
  const capture = parseProcessCapture(evidence.normalized_result);
  if (
    capture.manifest.executable_identity.state !== "path_metadata_unchanged" ||
    capture.manifest.selected_executable_sha256 !== expectedSha256 ||
    capture.manifest.executable_sha256 !== expectedSha256
  )
    throw new TypeError(
      "Captured executable identity differs from the approved plan",
    );
  const expectedCommitment = processScenarioCommitment(
    expectedScenario,
    expectedSha256,
  );
  if (digest(expectedCommitment) !== digest(capture.manifest.scenario))
    throw new TypeError(
      "Captured scenario differs from the approved process probe plan",
    );
};

const createProcessComparisonEvidence = (
  leftEvidence: Evidence,
  rightEvidence: Evidence,
  comparison: ReturnType<typeof compareProcessCaptures>,
) =>
  createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-comparison",
    operation: "compare_process_captures",
    parameters: {
      left_evidence_id: leftEvidence.evidence_id,
      right_evidence_id: rightEvidence.evidence_id,
    },
    result: jsonValueSchema.parse(
      processCaptureComparisonSchema.parse(comparison),
    ),
    confidence: "derived",
    authority: "analyst-inference",
    limitations: comparison.limitations,
    evidenceLinks: [leftEvidence.evidence_id, rightEvidence.evidence_id],
  });

const uniqueTargets = (plan: ReconstructionProcessProbePlan) => {
  const targets = new Map<
    string,
    { executable: string; expected_sha256: string; source_evidence_id: string }
  >();
  for (const probe of plan.probes) {
    for (const [sourceId, scenarioInput, sha256] of [
      [
        probe.selection.left_source_evidence_id,
        probe.left_scenario,
        probe.left_executable_sha256,
      ],
      [
        probe.selection.right_source_evidence_id,
        probe.right_scenario,
        probe.right_executable_sha256,
      ],
    ] as const) {
      const parsed = processScenarioSchema.parse(scenarioInput);
      targets.set(sourceId, {
        executable: parsed.executable,
        expected_sha256: sha256,
        source_evidence_id: sourceId,
      });
    }
  }
  return [...targets.values()].sort((left, right) =>
    compareStrings(left.source_evidence_id, right.source_evidence_id),
  );
};

const selectionKey = (selection: ReconstructionProcessProbeSelection): string =>
  canonicalize(selection) ?? "";

const compareSelection = (
  left: ReconstructionProcessProbeSelection,
  right: ReconstructionProcessProbeSelection,
): number =>
  compareStrings(left.left_source_evidence_id, right.left_source_evidence_id) ||
  compareStrings(
    left.right_source_evidence_id,
    right.right_source_evidence_id,
  ) ||
  left.argument_index - right.argument_index ||
  compareStrings(left.candidate_value, right.candidate_value);

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const digest = (value: unknown): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Value is not canonical JSON");
  return createHash("sha256").update(serialized).digest("hex");
};

const inputFailure = (field: string, message: string): AnalysisInputError =>
  new AnalysisInputError(OPERATION, undefined, [
    { path: [field], reason: "invalid_value", message },
  ]);

const safeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message || cause.name : String(cause);
