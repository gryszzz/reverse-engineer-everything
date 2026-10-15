import { z } from "zod";

import { digestCanonicalValue } from "./canonicalDigest.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { jsonValueSchema, type JsonValue } from "./jsonValue.js";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const predictionSchema = z.strictObject({
  input: jsonValueSchema,
  outcome: jsonValueSchema,
});

export const finiteHypothesisDiscriminationRequestSchema = z.strictObject({
  hypotheses: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(128),
        predictions: z.array(predictionSchema).min(1).max(512),
      }),
    )
    .min(2)
    .max(128),
  observations: z
    .array(
      z.strictObject({
        input: jsonValueSchema,
        outcome: jsonValueSchema,
        evidence_ids: z.array(evidenceIdSchema).min(1).max(128),
      }),
    )
    .max(512),
  candidate_inputs: z.array(jsonValueSchema).min(1).max(512),
});

export type FiniteHypothesisDiscriminationRequest = z.infer<
  typeof finiteHypothesisDiscriminationRequestSchema
>;

type Request = FiniteHypothesisDiscriminationRequest;
type Prediction = z.infer<typeof predictionSchema>;

export type FiniteHypothesisDiscriminationResult =
  | {
      readonly state: "invalid-contract";
      readonly reason: string;
    }
  | {
      readonly state: "insufficient-predictions";
      readonly reason: string;
    }
  | {
      readonly state: "no-consistent-hypothesis";
      readonly surviving_hypothesis_ids: readonly [];
      readonly conflicting_observation_index?: number;
      readonly evidence_ids: readonly string[];
      readonly reason: string;
    }
  | {
      readonly state: "insufficient-evidence";
      readonly surviving_hypothesis_ids: readonly string[];
      readonly reason: string;
    }
  | {
      readonly state: "already-unique-within-model";
      readonly surviving_hypothesis_ids: readonly [string];
      readonly reason: string;
    }
  | {
      readonly state: "no-discriminating-input-in-domain";
      readonly surviving_hypothesis_ids: readonly string[];
      readonly examined_input_count: number;
      readonly reason: string;
    }
  | {
      readonly state: "probe-recommended";
      readonly surviving_hypothesis_ids: readonly string[];
      readonly examined_input_count: number;
      readonly selected_probe: {
        readonly input: JsonValue;
        readonly information_gain_bits: number;
        readonly distinct_predicted_outcomes: number;
        readonly predictions: readonly {
          readonly hypothesis_id: string;
          readonly outcome: JsonValue;
        }[];
      };
      readonly scoring: {
        readonly prior: "uniform-over-surviving-hypotheses";
        readonly measure: "shannon-entropy-reduction-bits";
        readonly tie_break: "more-outcomes-then-canonical-input-digest";
      };
      readonly plan_sha256: string;
      readonly reason: string;
    };

const inputKey = (input: JsonValue): string => digestCanonicalValue(input);
const outcomeKey = (outcome: JsonValue): string =>
  digestCanonicalValue(outcome);

const entropy = (counts: readonly number[], population: number): number =>
  counts.reduce((sum, count) => {
    const probability = count / population;
    return sum - probability * Math.log2(probability);
  }, 0);

const predictionsByInput = (predictions: readonly Prediction[]) =>
  new Map(predictions.map(({ input, outcome }) => [inputKey(input), outcome]));

const validateContract = (
  request: Request,
):
  | {
      readonly state: "invalid-contract" | "insufficient-predictions";
      readonly reason: string;
    }
  | undefined => {
  const hypothesisIds = request.hypotheses.map(({ id }) => id);
  if (new Set(hypothesisIds).size !== hypothesisIds.length)
    return {
      state: "invalid-contract",
      reason: "Hypothesis identifiers must be unique.",
    };

  const candidateKeys = request.candidate_inputs.map(inputKey);
  if (new Set(candidateKeys).size !== candidateKeys.length)
    return {
      state: "invalid-contract",
      reason: "Candidate inputs must be unique under canonical JSON equality.",
    };

  const observationKeys = request.observations.map(({ input }) =>
    inputKey(input),
  );
  if (new Set(observationKeys).size !== observationKeys.length)
    return {
      state: "invalid-contract",
      reason:
        "Observation inputs must be unique; combine repeated evidence links on one observation.",
    };

  const knownInputs = new Set([...candidateKeys, ...observationKeys]);
  for (const { id, predictions } of request.hypotheses) {
    const keys = predictions.map(({ input }) => inputKey(input));
    if (new Set(keys).size !== keys.length)
      return {
        state: "invalid-contract",
        reason: `Hypothesis ${id} contains duplicate input predictions.`,
      };
    const predictedInputs = new Set(keys);
    for (const key of knownInputs) {
      if (!predictedInputs.has(key))
        return {
          state: "insufficient-predictions",
          reason: `Hypothesis ${id} does not predict every observed and candidate input; the planner will not treat missing predictions as disagreement.`,
        };
    }
  }
  return undefined;
};

/**
 * Rank caller-bounded inputs using caller-declared finite hypotheses.
 * The function does not invent hypotheses, generate inputs, or execute targets.
 */
export const discriminateFiniteHypotheses = (
  input: unknown,
): FiniteHypothesisDiscriminationResult => {
  const parsed = finiteHypothesisDiscriminationRequestSchema.safeParse(input);
  if (!parsed.success)
    return {
      state: "invalid-contract",
      reason: parsed.error.issues[0]?.message ?? "The contract is malformed.",
    };
  const request = parsed.data;
  const contractError = validateContract(request);
  if (contractError !== undefined) return contractError;

  const indexed = request.hypotheses.map((hypothesis) => ({
    ...hypothesis,
    byInput: predictionsByInput(hypothesis.predictions),
  }));
  const consistent = indexed.filter(({ byInput }) =>
    request.observations.every((observation) => {
      const predicted = byInput.get(inputKey(observation.input));
      return (
        predicted !== undefined &&
        outcomeKey(predicted) === outcomeKey(observation.outcome)
      );
    }),
  );
  if (consistent.length === 0) {
    let conflictIndex: number | undefined;
    for (let index = 0; index < request.observations.length; index += 1) {
      const prefix = request.observations.slice(0, index + 1);
      if (
        indexed.some(({ byInput }) =>
          prefix.every((observation) => {
            const predicted = byInput.get(inputKey(observation.input));
            return (
              predicted !== undefined &&
              outcomeKey(predicted) === outcomeKey(observation.outcome)
            );
          }),
        )
      )
        continue;
      conflictIndex = index;
      break;
    }
    return {
      state: "no-consistent-hypothesis",
      surviving_hypothesis_ids: [],
      ...(conflictIndex === undefined
        ? {}
        : { conflicting_observation_index: conflictIndex }),
      evidence_ids: [
        ...new Set(
          request.observations.flatMap(({ evidence_ids }) => evidence_ids),
        ),
      ].sort(compareUnicodeCodePoints),
      reason:
        "No declared hypothesis explains all linked observations; the model, observations, or both may be insufficient.",
    };
  }

  const survivingIds = consistent
    .map(({ id }) => id)
    .sort(compareUnicodeCodePoints);
  if (request.observations.length === 0)
    return {
      state: "insufficient-evidence",
      surviving_hypothesis_ids: survivingIds,
      reason:
        "Candidate predictions are available, but no linked observations constrain the declared hypotheses.",
    };
  if (consistent.length === 1)
    return {
      state: "already-unique-within-model",
      surviving_hypothesis_ids: [consistent[0]!.id],
      reason:
        "The linked observations select one hypothesis within the caller-declared finite model.",
    };

  const observedKeys = new Set(
    request.observations.map(({ input }) => inputKey(input)),
  );
  const candidates = request.candidate_inputs
    .filter((candidate) => !observedKeys.has(inputKey(candidate)))
    .map((candidate) => {
      const predictions = consistent.map(({ id, byInput }) => ({
        hypothesis_id: id,
        outcome: byInput.get(inputKey(candidate))!,
      }));
      const groups = new Map<string, number>();
      for (const { outcome } of predictions) {
        const key = outcomeKey(outcome);
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      return {
        input: candidate,
        predictions,
        information_gain_bits: Number(
          entropy([...groups.values()], consistent.length).toFixed(9),
        ),
        distinct_predicted_outcomes: groups.size,
        sort_key: inputKey(candidate),
      };
    })
    .sort(
      (left, right) =>
        right.information_gain_bits - left.information_gain_bits ||
        right.distinct_predicted_outcomes - left.distinct_predicted_outcomes ||
        compareUnicodeCodePoints(left.sort_key, right.sort_key),
    );
  const selected = candidates.find(
    ({ information_gain_bits }) => information_gain_bits > 0,
  );
  if (selected === undefined)
    return {
      state: "no-discriminating-input-in-domain",
      surviving_hypothesis_ids: survivingIds,
      examined_input_count: candidates.length,
      reason:
        "No caller-supplied candidate input distinguishes the surviving hypotheses.",
    };

  const plan = {
    version: 1,
    contract_sha256: digestCanonicalValue(request, "Hypothesis contract"),
    observation_evidence_ids: [
      ...new Set(
        request.observations.flatMap(({ evidence_ids }) => evidence_ids),
      ),
    ].sort(compareUnicodeCodePoints),
    surviving_hypothesis_ids: survivingIds,
    selected_input: selected.input,
    predictions: selected.predictions,
    information_gain_bits: selected.information_gain_bits,
    scoring: {
      prior: "uniform-over-surviving-hypotheses" as const,
      measure: "shannon-entropy-reduction-bits" as const,
      tie_break: "more-outcomes-then-canonical-input-digest" as const,
    },
  };
  return {
    state: "probe-recommended",
    surviving_hypothesis_ids: survivingIds,
    examined_input_count: candidates.length,
    selected_probe: {
      input: selected.input,
      information_gain_bits: selected.information_gain_bits,
      distinct_predicted_outcomes: selected.distinct_predicted_outcomes,
      predictions: selected.predictions,
    },
    scoring: plan.scoring,
    plan_sha256: digestCanonicalValue(plan, "Hypothesis probe plan"),
    reason:
      "This caller-supplied input maximizes expected information gain within the declared hypotheses and candidate domain.",
  };
};

export const updateFiniteHypotheses = (
  input: unknown,
  observation: {
    readonly input: JsonValue;
    readonly outcome: JsonValue;
    readonly evidence_ids: readonly string[];
  },
): FiniteHypothesisDiscriminationResult => {
  const parsed = finiteHypothesisDiscriminationRequestSchema.safeParse(input);
  if (!parsed.success)
    return {
      state: "invalid-contract",
      reason: parsed.error.issues[0]?.message ?? "The contract is malformed.",
    };
  const next = {
    ...parsed.data,
    observations: [
      ...parsed.data.observations,
      {
        input: observation.input,
        outcome: observation.outcome,
        evidence_ids: [...observation.evidence_ids],
      },
    ],
    // Keep the declared domain intact. The discriminator excludes observed
    // inputs itself and can then report that no remaining candidate separates
    // the surviving models instead of turning the updated request invalid.
    candidate_inputs: parsed.data.candidate_inputs,
  };
  return discriminateFiniteHypotheses(next);
};
