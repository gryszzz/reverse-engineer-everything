import { z } from "zod";

import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { processCaptureComparisonSchema } from "../domain/process/processComparison.js";
import {
  functionComparisonDimensionNameSchema,
  functionComparisonResultSchema,
} from "../domain/functionComparisonSchemas.js";
import { artifactComparisonResultSchema } from "../domain/artifactComparison.js";
import { reconstructionSpecificationSchema } from "../domain/reconstructionVerificationSchemas.js";
import {
  reconstructionSpecificationDerivationInputSchema,
  reconstructionSpecificationDraftSchema,
  type ReconstructionSpecificationDerivationInput,
  type ReconstructionSpecificationDraft,
} from "../domain/reconstructionSpecificationDerivationSchemas.js";
import { verifyReconstruction } from "../domain/reconstructionVerification.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { requestInputError, workflowInputError } from "./workflowInputError.js";
import { RECONSTRUCTION_SPECIFICATION_PROVIDER } from "./InvestigationProviders.js";

const OPERATION = "derive_reconstruction_specification" as const;

/** Propose only caller-selected claims tied to authenticated comparison Evidence. */
export const deriveReconstructionSpecificationEvidence = (
  input: unknown,
): Result<Evidence, AnalysisError> => {
  const parsed =
    reconstructionSpecificationDerivationInputSchema.safeParse(input);
  if (!parsed.success)
    return err(requestInputError(OPERATION, parsed.error, input));
  return deriveReconstructionSpecificationEvidenceValidated(parsed.data);
};

export const deriveReconstructionSpecificationEvidenceValidated = (
  input: ReconstructionSpecificationDerivationInput,
): Result<Evidence, AnalysisError> => {
  try {
    const bundle = input.evidence_bundle;
    const records = new Map(
      bundle.records.map((record) => [record.evidence_id, record]),
    );
    const claims = input.comparisons.flatMap((selection) => {
      const comparison = records.get(selection.comparison_evidence_id);
      if (comparison === undefined)
        throw new TypeError(
          `Missing comparison Evidence ${selection.comparison_evidence_id}`,
        );
      const kind = comparisonKind(comparison);
      const supportedDimensions = dimensionsFor(comparison, kind);
      for (const dimension of selection.dimensions)
        if (!supportedDimensions.includes(dimension))
          throw new TypeError(
            `Dimension ${dimension} is not supported by comparison Evidence ${comparison.evidence_id}`,
          );
      return selection.dimensions.map((dimension) => ({
        claim_id: `${kind}.${comparison.evidence_id}.${dimension}`,
        title: `Match the ${dimension} result recorded by comparison ${comparison.evidence_id}`,
        kind,
        dimension,
        comparison_evidence_id: comparison.evidence_id,
      }));
    });
    claims.sort((left, right) =>
      compareUnicodeCodePoints(left.claim_id, right.claim_id),
    );
    const specification = reconstructionSpecificationSchema.parse({
      name: input.name,
      claims,
    });
    // Reuse the production verifier as the authority for comparison identity,
    // linked source closure, and dimension semantics.
    const verification = verifyReconstruction(specification, bundle);
    const draft = reconstructionSpecificationDraftSchema.parse({
      specification,
      source_evidence_ids: verification.evidence_links,
      limitations: [
        "This draft contains only caller-selected comparison Evidence and dimensions; it does not establish complete target behavior.",
        "Claims preserve the comparison's observed scope and authority. Verification pass does not establish global implementation equivalence.",
      ],
    }) satisfies ReconstructionSpecificationDraft;
    return ok(
      createEvidence(undefined, RECONSTRUCTION_SPECIFICATION_PROVIDER, {
        predicateType: "rea.reconstruction-specification-draft",
        operation: OPERATION,
        parameters: jsonObjectSchema.parse({
          comparison_evidence_ids: input.comparisons
            .map(({ comparison_evidence_id: id }) => id)
            .sort(compareUnicodeCodePoints),
          claim_count: draft.specification.claims.length,
        }),
        result: jsonValueSchema.parse(draft),
        confidence: "inferred",
        authority: "analyst-inference",
        limitations: draft.limitations,
        evidenceLinks: draft.source_evidence_ids,
      }),
    );
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      return err(workflowInputError(OPERATION, cause));
    if (cause instanceof TypeError)
      return err(workflowInputError(OPERATION, cause));
    return err(
      new AnalysisProtocolError(
        "Reconstruction specification derivation failed",
        { cause },
      ),
    );
  }
};

type ClaimKind = "behavioral" | "structural-function" | "structural-artifact";
type SelectedDimension =
  ReconstructionSpecificationDerivationInput["comparisons"][number]["dimensions"][number];

const comparisonKind = (evidence: Evidence): ClaimKind => {
  if (evidence.operation === "compare_process_captures") return "behavioral";
  if (evidence.operation === "compare_functions") return "structural-function";
  if (evidence.operation === "compare_artifacts") return "structural-artifact";
  throw new TypeError(
    `Evidence ${evidence.evidence_id} is not a supported reconstruction comparison`,
  );
};

const dimensionsFor = (
  evidence: Evidence,
  kind: ClaimKind,
): SelectedDimension[] => {
  if (kind === "behavioral") {
    processCaptureComparisonSchema.parse(evidence.normalized_result);
    return [
      "overall",
      "terminal",
      "interaction",
      "exit",
      "filesystem",
      "process",
    ];
  }
  if (kind === "structural-function") {
    const result = functionComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    return [
      "overall",
      ...result.dimensions.map(({ dimension }) =>
        functionComparisonDimensionNameSchema.parse(dimension),
      ),
    ];
  }
  artifactComparisonResultSchema.parse(evidence.normalized_result);
  return ["overall"];
};
