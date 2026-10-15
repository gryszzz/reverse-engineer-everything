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

const validateObservations = (observations) => {
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
  return { state: "valid" };
};

const consistentHypotheses = (observations) =>
  hypotheses.filter((hypothesis) =>
    observations.every(
      ({ input, expected_stdout }) =>
        format(hypothesis.evaluate(input)) === expected_stdout,
    ),
  );

/**
 * Select a unique expression from a deliberately small grammar using only
 * black-box input/output examples. No authority source, executable path, or
 * filesystem access is accepted by this function.
 */
export const synthesizeBlackBoxExpression = (observations) => {
  const validation = validateObservations(observations);
  if (validation.state !== "valid") return validation;

  const consistent = consistentHypotheses(observations);
  if (consistent.length === 0) {
    // Preserve the first point at which an observation eliminates every
    // hypothesis that explained the preceding prefix. This is a diagnosis,
    // not proof that the earlier model was correct or that the new capture is
    // wrong: the declared grammar may simply be incomplete.
    let conflict;
    for (let index = 0; index < observations.length; index += 1) {
      if (index === 0) continue;
      const prior = consistentHypotheses(observations.slice(0, index));
      if (
        prior.length > 0 &&
        consistentHypotheses(observations.slice(0, index + 1)).length === 0
      ) {
        const observation = observations[index];
        conflict = {
          observation_index: index,
          ...(typeof observation.id === "string"
            ? { observation_id: observation.id }
            : {}),
          ...(typeof observation.comparison_evidence_id === "string"
            ? { comparison_evidence_id: observation.comparison_evidence_id }
            : {}),
          input: observation.input,
          observed_stdout: observation.expected_stdout,
          previously_consistent_hypothesis_ids: prior.map(({ id }) => id),
          diagnosis:
            "This observation eliminated every hypothesis that explained the preceding observations; the declared grammar may be inadequate.",
        };
        break;
      }
    }
    return {
      state: "no-consistent-hypothesis",
      hypotheses_examined: hypotheses.length,
      reason:
        "No expression in the declared arithmetic grammar explains all observations.",
      ...(conflict === undefined ? {} : { conflict }),
    };
  }
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

const entropy = (counts, population) =>
  counts.reduce((sum, count) => {
    const probability = count / population;
    return sum - probability * Math.log2(probability);
  }, 0);

/** Rank bounded inputs by expected reduction in uncertainty over the surviving grammar. */
export const rankDiscriminatingInputs = (observations, domain) => {
  const validation = validateObservations(observations);
  if (validation.state !== "valid") return validation;
  const consistent = consistentHypotheses(observations);
  if (consistent.length === 0)
    return {
      state: "no-consistent-hypothesis",
      reason:
        "No expression in the declared grammar explains the current observations.",
    };
  if (consistent.length === 1)
    return {
      state: "already-unique-within-grammar",
      surviving_hypothesis_ids: consistent.map(({ id }) => id),
      reason:
        "The current observations already select one hypothesis in this grammar.",
    };

  const { unit_price_cents: centsRange, quantity_values: quantities } =
    domain ?? {};
  if (
    !Number.isSafeInteger(centsRange?.minimum) ||
    !Number.isSafeInteger(centsRange?.maximum) ||
    !Number.isSafeInteger(centsRange?.step) ||
    centsRange.minimum < 0 ||
    centsRange.maximum < centsRange.minimum ||
    centsRange.step < 1 ||
    !Array.isArray(quantities) ||
    quantities.length === 0 ||
    quantities.length > 100 ||
    quantities.some(
      (quantity) => !Number.isFinite(quantity) || quantity <= 0,
    ) ||
    new Set(quantities).size !== quantities.length ||
    (Math.floor((centsRange.maximum - centsRange.minimum) / centsRange.step) +
      1) *
      quantities.length >
      10_000
  )
    return {
      state: "invalid-domain",
      reason:
        "The probe domain is malformed or exceeds the 10,000-input planning budget.",
    };

  const observedInputs = new Set(
    observations.map(({ input }) => `${input.unit_price}:${input.quantity}`),
  );
  const candidates = [];
  for (
    let cents = centsRange.minimum;
    cents <= centsRange.maximum;
    cents += centsRange.step
  ) {
    for (const quantity of quantities) {
      const input = { unit_price: cents / 100, quantity };
      if (observedInputs.has(`${input.unit_price}:${quantity}`)) continue;
      const predictions = consistent.map((hypothesis) => ({
        hypothesis_id: hypothesis.id,
        expected_stdout: format(hypothesis.evaluate(input)),
      }));
      const groups = new Map();
      for (const prediction of predictions)
        groups.set(
          prediction.expected_stdout,
          (groups.get(prediction.expected_stdout) ?? 0) + 1,
        );
      const informationGain = entropy([...groups.values()], consistent.length);
      candidates.push({
        input: {
          unit_price: (cents / 100).toFixed(2),
          quantity,
        },
        information_gain_bits: Number(informationGain.toFixed(9)),
        distinct_predicted_outputs: groups.size,
        predictions,
      });
    }
  }
  candidates.sort(
    (left, right) =>
      right.information_gain_bits - left.information_gain_bits ||
      right.distinct_predicted_outputs - left.distinct_predicted_outputs ||
      Number(left.input.unit_price) - Number(right.input.unit_price) ||
      left.input.quantity - right.input.quantity,
  );
  const recommended = candidates.filter(
    ({ information_gain_bits }) => information_gain_bits > 0,
  );
  if (recommended.length === 0)
    return {
      state: "no-discriminating-input-in-domain",
      surviving_hypothesis_ids: consistent.map(({ id }) => id),
      examined_input_count: candidates.length,
      reason:
        "Every unobserved input in the bounded domain gives the surviving hypotheses the same predicted output.",
    };
  return {
    state: "probe-recommended",
    method: "maximum-expected-information-gain",
    hypothesis_grammar: hypotheses.map(({ id, expression }) => ({
      id,
      expression,
    })),
    scoring: {
      prior: "uniform over surviving hypotheses",
      measure: "Shannon entropy reduction in bits",
      tie_break: "more distinct outputs, then lower price, then lower quantity",
    },
    surviving_hypothesis_ids: consistent.map(({ id }) => id),
    examined_input_count: candidates.length,
    ranked_candidates: recommended.slice(0, 5),
    selected_probe: recommended[0],
  };
};
