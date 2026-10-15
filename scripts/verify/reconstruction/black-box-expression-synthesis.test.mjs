import assert from "node:assert/strict";
import test from "node:test";

import {
  rankDiscriminatingInputs,
  synthesizeBlackBoxExpression,
} from "./black-box-expression-synthesis.mjs";

const controlOnly = [
  { input: { unit_price: 199, quantity: 3 }, expected_stdout: "597.00" },
];
const domain = {
  unit_price_cents: { minimum: 100, maximum: 200, step: 1 },
  quantity_values: [1, 2, 3, 10],
};

test("black-box observations select a unique expression only within the grammar", () => {
  const result = synthesizeBlackBoxExpression([
    { input: { unit_price: 199, quantity: 3 }, expected_stdout: "597.00" },
    { input: { unit_price: 1.05, quantity: 1 }, expected_stdout: "1.05" },
  ]);

  assert.equal(result.state, "unique-fit-in-declared-grammar");
  assert.equal(result.selected_hypothesis_id, "direct-product");
  assert.equal(result.expression, "unit_price * quantity");
  assert.equal(result.hypotheses_examined, 5);
  assert.equal(
    result.generalization_claim,
    "none; holdout observations are required",
  );
});

test("the synthesizer refuses observations that leave multiple hypotheses", () => {
  const result = synthesizeBlackBoxExpression([
    { input: { unit_price: 3, quantity: 2 }, expected_stdout: "6.00" },
  ]);

  assert.equal(result.state, "ambiguous");
  assert.ok(result.consistent_hypothesis_ids.length > 1);
});

test("the synthesizer refuses observations outside its grammar", () => {
  const result = synthesizeBlackBoxExpression([
    { input: { unit_price: 3, quantity: 2 }, expected_stdout: "7.00" },
  ]);

  assert.equal(result.state, "no-consistent-hypothesis");
});

test("malformed or absent observations fail closed", () => {
  assert.equal(synthesizeBlackBoxExpression([]).state, "insufficient-evidence");
  assert.equal(
    synthesizeBlackBoxExpression([
      {
        input: { unit_price: Number.NaN, quantity: 2 },
        expected_stdout: "6.00",
      },
    ]).state,
    "invalid-observation",
  );
});

test("active planning ranks an unobserved input by expected information gain", () => {
  const result = rankDiscriminatingInputs(controlOnly, domain);

  assert.equal(result.state, "probe-recommended");
  assert.equal(result.method, "maximum-expected-information-gain");
  assert.equal(result.surviving_hypothesis_ids.length, 5);
  assert.ok(result.selected_probe.information_gain_bits > 0);
  assert.ok(result.selected_probe.distinct_predicted_outputs > 1);
  assert.deepEqual(result.selected_probe.input, {
    unit_price: "1.01",
    quantity: 1,
  });
});

test("an approved observation eliminates inconsistent hypotheses", () => {
  const result = synthesizeBlackBoxExpression([
    ...controlOnly,
    { input: { unit_price: 1.05, quantity: 10 }, expected_stdout: "10.50" },
  ]);

  assert.equal(result.state, "unique-fit-in-declared-grammar");
  assert.equal(result.selected_hypothesis_id, "direct-product");
});

test("a unique training fit can still fail on a contradictory holdout", () => {
  const training = [
    ...controlOnly,
    { input: { unit_price: 1.01, quantity: 1 }, expected_stdout: "1.01" },
  ];
  const result = synthesizeBlackBoxExpression(training);
  const holdout = {
    input: { unit_price: 1.02, quantity: 1 },
    expected_stdout: "2.00",
  };

  assert.equal(result.state, "unique-fit-in-declared-grammar");
  assert.equal(result.expression, "unit_price * quantity");
  assert.notEqual(
    (holdout.input.unit_price * holdout.input.quantity).toFixed(2),
    holdout.expected_stdout,
  );
});

test("the planner abstains for an already unique model or a nondiscriminating domain", () => {
  const unique = rankDiscriminatingInputs(
    [
      ...controlOnly,
      { input: { unit_price: 1.05, quantity: 10 }, expected_stdout: "10.50" },
    ],
    domain,
  );
  const nondiscriminating = rankDiscriminatingInputs(controlOnly, {
    unit_price_cents: { minimum: 100, maximum: 100, step: 1 },
    quantity_values: [1],
  });

  assert.equal(unique.state, "already-unique-within-grammar");
  assert.equal(nondiscriminating.state, "no-discriminating-input-in-domain");
});

test("the planner reports when observations fall outside the declared grammar", () => {
  const result = rankDiscriminatingInputs(
    [{ input: { unit_price: 3, quantity: 2 }, expected_stdout: "7.00" }],
    domain,
  );

  assert.equal(result.state, "no-consistent-hypothesis");
});
