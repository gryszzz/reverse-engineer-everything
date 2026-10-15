import { expect, it } from "vitest";

import {
  discriminateFiniteHypotheses,
  updateFiniteHypotheses,
  type FiniteHypothesisDiscriminationRequest,
} from "./finiteHypothesisDiscrimination.js";

const evidenceId = (digit: string): string => `ev_${digit.repeat(64)}`;

it("ranks structured arithmetic inputs without owning the arithmetic grammar", () => {
  const contract: FiniteHypothesisDiscriminationRequest = {
    hypotheses: [
      {
        id: "addition",
        predictions: [
          { input: { a: 2, b: 2 }, outcome: 4 },
          { input: { a: 2, b: 3 }, outcome: 5 },
          { input: { a: 3, b: 4 }, outcome: 7 },
        ],
      },
      {
        id: "multiplication",
        predictions: [
          { input: { a: 2, b: 2 }, outcome: 4 },
          { input: { a: 2, b: 3 }, outcome: 6 },
          { input: { a: 3, b: 4 }, outcome: 12 },
        ],
      },
    ],
    observations: [
      {
        input: { a: 2, b: 2 },
        outcome: 4,
        evidence_ids: [evidenceId("1")],
      },
    ],
    candidate_inputs: [
      { a: 2, b: 3 },
      { a: 3, b: 4 },
    ],
  };

  const result = discriminateFiniteHypotheses(contract);

  expect(result.state).toBe("probe-recommended");
  if (result.state !== "probe-recommended") return;
  expect(result.selected_probe.distinct_predicted_outcomes).toBe(2);
  expect(result.selected_probe.information_gain_bits).toBe(1);
  expect(result.scoring.prior).toBe("uniform-over-surviving-hypotheses");
  expect(result.selected_probe.predictions).toEqual(
    expect.arrayContaining([
      { hypothesis_id: "addition", outcome: 5 },
      { hypothesis_id: "multiplication", outcome: 6 },
    ]),
  );
});

it("discriminates competing duplicate-record rules and updates from linked evidence", () => {
  const forward = "mode=fast\nmode=safe";
  const reverse = "mode=safe\nmode=fast";
  const parsed = (value: string, lines: number) => ({
    kind: "parsed",
    key: "mode",
    value,
    lines,
  });
  const contract: FiniteHypothesisDiscriminationRequest = {
    hypotheses: [
      {
        id: "first-record",
        predictions: [
          { input: "mode=fast", outcome: parsed("fast", 1) },
          { input: forward, outcome: parsed("fast", 2) },
          { input: reverse, outcome: parsed("safe", 2) },
        ],
      },
      {
        id: "last-record",
        predictions: [
          { input: "mode=fast", outcome: parsed("fast", 1) },
          { input: forward, outcome: parsed("safe", 2) },
          { input: reverse, outcome: parsed("fast", 2) },
        ],
      },
      {
        id: "reject-duplicates",
        predictions: [
          { input: "mode=fast", outcome: parsed("fast", 1) },
          { input: forward, outcome: { kind: "error", exit_code: 2 } },
          { input: reverse, outcome: { kind: "error", exit_code: 2 } },
        ],
      },
      {
        id: "collect-duplicates",
        predictions: [
          { input: "mode=fast", outcome: parsed("fast", 1) },
          {
            input: forward,
            outcome: { kind: "parsed", key: "mode", values: ["fast", "safe"] },
          },
          {
            input: reverse,
            outcome: { kind: "parsed", key: "mode", values: ["safe", "fast"] },
          },
        ],
      },
    ],
    observations: [
      {
        input: "mode=fast",
        outcome: parsed("fast", 1),
        evidence_ids: [evidenceId("2")],
      },
    ],
    candidate_inputs: [forward, reverse],
  };

  const planned = discriminateFiniteHypotheses(contract);
  expect(planned.state).toBe("probe-recommended");
  if (planned.state !== "probe-recommended") return;
  expect(planned.selected_probe.distinct_predicted_outcomes).toBe(4);
  expect(planned.selected_probe.information_gain_bits).toBe(2);

  const observed = planned.selected_probe.predictions.find(
    ({ hypothesis_id }) => hypothesis_id === "last-record",
  );
  expect(observed).toBeDefined();
  const updated = updateFiniteHypotheses(contract, {
    input: planned.selected_probe.input,
    outcome: observed!.outcome,
    evidence_ids: [evidenceId("3")],
  });
  expect(updated).toMatchObject({
    state: "already-unique-within-model",
    surviving_hypothesis_ids: ["last-record"],
  });
});

it("abstains on incomplete prediction tables and preserves contradictory Evidence", () => {
  const incomplete = discriminateFiniteHypotheses({
    hypotheses: [
      { id: "a", predictions: [{ input: "seen", outcome: 1 }] },
      { id: "b", predictions: [{ input: "seen", outcome: 2 }] },
    ],
    observations: [],
    candidate_inputs: ["seen", "unmodeled"],
  });
  expect(incomplete.state).toBe("insufficient-predictions");

  const contradiction = discriminateFiniteHypotheses({
    hypotheses: [
      {
        id: "a",
        predictions: [
          { input: "x", outcome: 1 },
          { input: "y", outcome: 1 },
          { input: "z", outcome: 1 },
        ],
      },
      {
        id: "b",
        predictions: [
          { input: "x", outcome: 2 },
          { input: "y", outcome: 2 },
          { input: "z", outcome: 2 },
        ],
      },
    ],
    observations: [
      { input: "x", outcome: 1, evidence_ids: [evidenceId("4")] },
      { input: "y", outcome: 2, evidence_ids: [evidenceId("5")] },
    ],
    candidate_inputs: ["z"],
  });
  expect(contradiction).toMatchObject({
    state: "no-consistent-hypothesis",
    conflicting_observation_index: 1,
    evidence_ids: [evidenceId("4"), evidenceId("5")],
  });
});

it("binds a deterministic plan digest and reports no information gain honestly", () => {
  const request: FiniteHypothesisDiscriminationRequest = {
    hypotheses: [
      {
        id: "a",
        predictions: [
          { input: "seen", outcome: 1 },
          { input: "candidate", outcome: 1 },
        ],
      },
      {
        id: "b",
        predictions: [
          { input: "seen", outcome: 1 },
          { input: "candidate", outcome: 1 },
        ],
      },
    ],
    observations: [
      { input: "seen", outcome: 1, evidence_ids: [evidenceId("6")] },
    ],
    candidate_inputs: ["candidate"],
  };
  expect(discriminateFiniteHypotheses(request)).toEqual(
    discriminateFiniteHypotheses(request),
  );
  expect(discriminateFiniteHypotheses(request)).toMatchObject({
    state: "no-discriminating-input-in-domain",
    examined_input_count: 1,
  });
});

it("reassesses the last candidate without invalidating the hypothesis contract", () => {
  const request: FiniteHypothesisDiscriminationRequest = {
    hypotheses: [
      {
        id: "first",
        predictions: [
          { input: "seen", outcome: "x" },
          { input: "probe", outcome: "a" },
        ],
      },
      {
        id: "last",
        predictions: [
          { input: "seen", outcome: "x" },
          { input: "probe", outcome: "b" },
        ],
      },
    ],
    observations: [
      { input: "seen", outcome: "x", evidence_ids: [evidenceId("7")] },
    ],
    candidate_inputs: ["probe"],
  };
  expect(
    updateFiniteHypotheses(request, {
      input: "probe",
      outcome: "b",
      evidence_ids: [evidenceId("8")],
    }),
  ).toMatchObject({
    state: "already-unique-within-model",
    surviving_hypothesis_ids: ["last"],
  });
});
