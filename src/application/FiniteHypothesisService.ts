import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  discriminateFiniteHypotheses,
  finiteHypothesisDiscriminationRequestSchema,
} from "../domain/finiteHypothesisDiscrimination.js";
import { finiteHypothesisAssessmentSchema } from "../domain/finiteHypothesisResultSchema.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { requestInputError } from "./workflowInputError.js";

/** Rank finite hypotheses without executing targets or authenticating caller assertions. */
export const assessFiniteHypotheses = (
  input: unknown,
): Result<JsonValue, AnalysisError> => {
  const parsed = finiteHypothesisDiscriminationRequestSchema.safeParse(input);
  if (!parsed.success)
    return err(
      requestInputError("discriminate_finite_hypotheses", parsed.error, input),
    );
  return ok(
    jsonValueSchema.parse(
      finiteHypothesisAssessmentSchema.parse({
        assessment: discriminateFiniteHypotheses(parsed.data),
      }),
    ),
  );
};
