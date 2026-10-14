const product = ({ unit_price, quantity }) => unit_price * quantity;

const hypotheses = [
  {
    id: "direct-product",
    expression: "unit_price * quantity",
    evaluate: product,
  },
  {
    id: "floor-product",
    expression: "floor(unit_price * quantity)",
    evaluate: ({ unit_price, quantity }) =>
      Math.floor(product({ unit_price, quantity })),
  },
  {
    id: "ceil-product",
    expression: "ceil(unit_price * quantity)",
    evaluate: ({ unit_price, quantity }) =>
      Math.ceil(product({ unit_price, quantity })),
  },
  {
    id: "round-product",
    expression: "round(unit_price * quantity)",
    evaluate: ({ unit_price, quantity }) =>
      Math.round(product({ unit_price, quantity })),
  },
  {
    id: "round-half-up-product",
    expression: "floor(unit_price * quantity + 0.5)",
    evaluate: ({ unit_price, quantity }) =>
      Math.floor(product({ unit_price, quantity }) + 0.5),
  },
];

const format = (value) => value.toFixed(2);

/**
 * Select a unique expression from a deliberately small grammar using only
 * black-box input/output examples. No authority source, executable path, or
 * filesystem access is accepted by this function.
 */
export const synthesizeBlackBoxExpression = (observations) => {
  if (!Array.isArray(observations) || observations.length === 0)
    return {
      state: "insufficient-evidence",
      reason: "At least one observation is required.",
    };

  for (const observation of observations) {
    if (
      !Number.isFinite(observation?.input?.unit_price) ||
      !Number.isFinite(observation?.input?.quantity) ||
      typeof observation?.expected_stdout !== "string" ||
      !/^[-+]?\d+(?:\.\d{2})?$/u.test(observation.expected_stdout)
    )
      return {
        state: "invalid-observation",
        reason:
          "Each observation must contain finite numeric inputs and a numeric terminal result.",
      };
  }

  const consistent = hypotheses.filter((hypothesis) =>
    observations.every(
      ({ input, expected_stdout }) =>
        format(hypothesis.evaluate(input)) === expected_stdout,
    ),
  );
  if (consistent.length === 0)
    return {
      state: "no-consistent-hypothesis",
      hypotheses_examined: hypotheses.length,
      reason:
        "No expression in the declared arithmetic grammar explains all observations.",
    };
  if (consistent.length !== 1)
    return {
      state: "ambiguous",
      hypotheses_examined: hypotheses.length,
      consistent_hypothesis_ids: consistent.map(({ id }) => id),
      reason:
        "The observations do not uniquely identify an expression in the declared grammar.",
    };

  const [selected] = consistent;
  return {
    state: "unique-fit-in-declared-grammar",
    method: "bounded-enumerative-expression-search",
    grammar: hypotheses.map(({ id, expression }) => ({ id, expression })),
    hypotheses_examined: hypotheses.length,
    consistent_hypothesis_ids: [selected.id],
    selected_hypothesis_id: selected.id,
    expression: selected.expression,
    training_observation_count: observations.length,
    generalization_claim: "none; holdout observations are required",
  };
};
