import assert from "node:assert/strict";
import test from "node:test";

import { synthesizeBlackBoxExpression } from "./black-box-expression-synthesis.mjs";

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
