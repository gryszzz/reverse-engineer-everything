import { z } from "zod";

import { jsonValueSchema } from "./jsonValue.js";

const reason = z.string();
const ids = z.array(z.string());
/** Typed outcomes for bounded, caller-declared hypothesis discrimination. */
export const finiteHypothesisResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("invalid-contract"), reason }),
  z.strictObject({ state: z.literal("insufficient-predictions"), reason }),
  z.strictObject({
    state: z.literal("no-consistent-hypothesis"),
    surviving_hypothesis_ids: z.array(z.string()).length(0),
    conflicting_observation_index: z.number().int().nonnegative().optional(),
    evidence_ids: z.array(z.string().regex(/^ev_[a-f0-9]{64}$/u)),
    reason,
  }),
  z.strictObject({
    state: z.literal("insufficient-evidence"),
    surviving_hypothesis_ids: ids,
    reason,
  }),
  z.strictObject({
    state: z.literal("already-unique-within-model"),
    surviving_hypothesis_ids: z.tuple([z.string()]),
    reason,
  }),
  z.strictObject({
    state: z.literal("no-discriminating-input-in-domain"),
    surviving_hypothesis_ids: ids,
    examined_input_count: z.number().int().nonnegative(),
    reason,
  }),
  z.strictObject({
    state: z.literal("probe-recommended"),
    surviving_hypothesis_ids: ids,
    examined_input_count: z.number().int().nonnegative(),
    selected_probe: z.strictObject({
      input: jsonValueSchema,
      information_gain_bits: z.number().nonnegative(),
      distinct_predicted_outcomes: z.number().int().positive(),
      predictions: z.array(
        z.strictObject({ hypothesis_id: z.string(), outcome: jsonValueSchema }),
      ),
    }),
    scoring: z.strictObject({
      prior: z.literal("uniform-over-surviving-hypotheses"),
      measure: z.literal("shannon-entropy-reduction-bits"),
      tie_break: z.literal("more-outcomes-then-canonical-input-digest"),
    }),
    plan_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    reason,
  }),
]);

/** Object envelope shared by CLI and MCP clients. */
export const finiteHypothesisAssessmentSchema = z.strictObject({
  assessment: finiteHypothesisResultSchema,
});
