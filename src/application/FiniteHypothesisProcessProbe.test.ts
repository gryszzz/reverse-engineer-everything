import { expect, it } from "vitest";

import { createEvidence } from "../domain/evidence.js";
import { PROCESS_PROVIDER } from "../domain/process/processEvidenceProvider.js";
import { prepareFiniteHypothesisProcessProbe } from "./ReconstructionProbeBatchService.js";

it("returns an input error for malformed source capture data instead of throwing", () => {
  const source = createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture",
    operation: "capture_process_scenario",
    parameters: {},
    result: {},
    confidence: "observed",
    authority: "controlled-replay",
  });
  const result = prepareFiniteHypothesisProcessProbe(
    {
      hypotheses: {
        hypotheses: [
          {
            id: "first",
            predictions: [
              { input: "seen", outcome: 0 },
              { input: "probe", outcome: 1 },
            ],
          },
          {
            id: "last",
            predictions: [
              { input: "seen", outcome: 0 },
              { input: "probe", outcome: 2 },
            ],
          },
        ],
        observations: [
          { input: "seen", outcome: 0, evidence_ids: [source.evidence_id] },
        ],
        candidate_inputs: ["probe"],
      },
      source_evidence_id: source.evidence_id,
      selected_input: "probe",
      argument_mapping: { kind: "string-argument", argument_index: 0 },
      outcome_json_pointer: "/exit/code",
      max_probes: 1,
    },
    source,
  );
  expect(result.ok).toBe(false);
});
