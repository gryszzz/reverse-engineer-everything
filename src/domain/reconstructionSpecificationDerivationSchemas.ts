import { z } from "zod";

import { functionComparisonDimensionNameSchema } from "./functionComparisonSchemas.js";
import { evidenceBundleSchema } from "./evidenceBundle.js";
import { prefixedDigestSchema } from "./digests.js";
import { PROCESS_COMPARISON_DIMENSIONS } from "./process/processComparison.js";
import { reconstructionSpecificationSchema } from "./reconstructionVerificationSchemas.js";

const evidenceIdSchema = prefixedDigestSchema("ev");
const derivationDimensionSchema = z.enum([
  "overall",
  ...PROCESS_COMPARISON_DIMENSIONS,
  ...functionComparisonDimensionNameSchema.options,
]);

/** Caller-selected, evidence-bound claims from supported comparison records. */
export const reconstructionSpecificationDerivationInputSchema = z.strictObject({
  name: z.string().trim().min(1),
  evidence_bundle: evidenceBundleSchema,
  comparisons: z
    .array(
      z.strictObject({
        comparison_evidence_id: evidenceIdSchema,
        dimensions: z.array(derivationDimensionSchema).min(1),
      }),
    )
    .min(1),
});

export const reconstructionSpecificationDraftSchema = z
  .strictObject({
    specification: reconstructionSpecificationSchema,
    source_evidence_ids: z.array(evidenceIdSchema).min(1),
    limitations: z.array(z.string()).min(1),
  })
  .superRefine((draft, context) => {
    if (
      new Set(draft.source_evidence_ids).size !==
      draft.source_evidence_ids.length
    )
      context.addIssue({
        code: "custom",
        message: "Source Evidence IDs must be unique",
        path: ["source_evidence_ids"],
      });
  });

export type ReconstructionSpecificationDerivationInput = z.infer<
  typeof reconstructionSpecificationDerivationInputSchema
>;
export type ReconstructionSpecificationDraft = z.infer<
  typeof reconstructionSpecificationDraftSchema
>;
