import { z } from "zod";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import { createReconstructionReport } from "../domain/reconstructionReport.js";
import {
  reconstructionReportResultSchema,
  reconstructionReportRequestSchema,
  type ReconstructionReportResult,
} from "../domain/reconstructionReportSchemas.js";
import { err, ok, type Result } from "../domain/result.js";
import { requestInputError, workflowInputError } from "./workflowInputError.js";
import { verifyReconstructionEvidenceValidated } from "./ReconstructionVerificationService.js";

const OPERATION = "build_reconstruction_report" as const;

export { reconstructionReportRequestSchema };

/** Build a stable report from a verified Evidence closure. */
export const buildReconstructionReport = (
  input: unknown,
): Result<ReconstructionReportResult, AnalysisError> => {
  const parsed = reconstructionReportRequestSchema.safeParse(input);
  if (!parsed.success)
    return err(requestInputError(OPERATION, parsed.error, input));

  const verified = verifyReconstructionEvidenceValidated({
    specification: parsed.data.specification,
    evidence_bundle: parsed.data.evidence_bundle,
  });
  if (!verified.ok) return verified;

  try {
    const report = createReconstructionReport({
      specification: parsed.data.specification,
      verificationEvidenceId: verified.value.evidence.evidence_id,
      result: verified.value.result,
      evidenceBundle: parsed.data.evidence_bundle,
      ...(parsed.data.participant_roles === undefined
        ? {}
        : { participantRoles: parsed.data.participant_roles }),
    });
    return ok(
      reconstructionReportResultSchema.parse({
        report,
        verification_evidence: verified.value.evidence,
      }),
    );
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError || cause instanceof TypeError)
      return err(workflowInputError(OPERATION, cause));
    return err(
      new AnalysisProtocolError("Reconstruction report generation failed", {
        cause,
      }),
    );
  }
};
