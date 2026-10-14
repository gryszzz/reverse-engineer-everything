import { z } from "zod";

import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";
import {
  reconstructionVerificationRequestSchema,
  type ReconstructionVerificationResult,
} from "../domain/reconstructionVerificationSchemas.js";
import { verifyReconstruction } from "../domain/reconstructionVerification.js";
import { err, ok, type Result } from "../domain/result.js";
import { requestInputError, workflowInputError } from "./workflowInputError.js";
import { RECONSTRUCTION_PROVIDER } from "./InvestigationProviders.js";

const OPERATION = "verify_reconstruction" as const;

export { reconstructionVerificationRequestSchema };

export type ReconstructionVerificationRequest = z.infer<
  typeof reconstructionVerificationRequestSchema
>;

export interface ReconstructionVerificationEvidence {
  readonly evidence: Evidence;
  readonly result: ReconstructionVerificationResult;
}

/** Wrap a verified result, retaining the complete closure selected by an adapter. */
export const createReconstructionVerificationEvidence = (
  specification: ReconstructionVerificationRequest["specification"],
  result: ReconstructionVerificationResult,
  evidenceLinks: readonly string[] = result.evidence_links,
): Evidence =>
  createEvidence(undefined, RECONSTRUCTION_PROVIDER, {
    predicateType: "rea.reconstruction-verification",
    operation: OPERATION,
    parameters: jsonObjectSchema.parse({
      specification_sha256: result.specification_sha256,
      claim_ids: specification.claims.map(({ claim_id: id }) => id),
    }),
    result: jsonValueSchema.parse(result),
    confidence: "derived",
    authority: "analyst-inference",
    limitations: result.limitations,
    evidenceLinks,
  });

/** Parse and verify a portable Evidence request, retaining the typed result. */
export const verifyReconstructionEvidence = (
  input: unknown,
): Result<ReconstructionVerificationEvidence, AnalysisError> => {
  const parsed = reconstructionVerificationRequestSchema.safeParse(input);
  if (!parsed.success)
    return err(requestInputError(OPERATION, parsed.error, input));
  return verifyReconstructionEvidenceValidated(parsed.data);
};

/** Verify a validated request and wrap the result in portable Evidence. */
export const verifyReconstructionEvidenceValidated = (
  input: ReconstructionVerificationRequest,
): Result<ReconstructionVerificationEvidence, AnalysisError> => {
  const verified = evaluateReconstructionVerificationValidated(input);
  if (!verified.ok) return verified;
  try {
    const result = verified.value;
    const evidence = createReconstructionVerificationEvidence(
      input.specification,
      result,
    );
    return ok({ evidence, result });
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      return err(workflowInputError(OPERATION, cause));
    return err(
      new AnalysisProtocolError("Reconstruction verification failed", {
        cause,
      }),
    );
  }
};

/** Evaluate a validated request without choosing adapter-specific Evidence closure. */
export const evaluateReconstructionVerificationValidated = (
  input: ReconstructionVerificationRequest,
): Result<ReconstructionVerificationResult, AnalysisError> => {
  try {
    return ok(verifyReconstruction(input.specification, input.evidence_bundle));
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError || cause instanceof TypeError)
      return err(workflowInputError(OPERATION, cause));
    return err(
      new AnalysisProtocolError("Reconstruction verification failed", {
        cause,
      }),
    );
  }
};
