import { describe, expect, it } from "vitest";

import { deriveReconstructionSpecificationEvidence } from "./ReconstructionSpecificationDerivationService.js";
import { createEvidence } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../domain/process/processCaptureExample.js";
import { PROCESS_PROVIDER } from "../domain/process/processEvidenceProvider.js";
import { processCaptureComparisonSchema } from "../domain/process/processComparison.js";

const environment = {
  id: "specification-derivation-test",
  platform: "linux",
  architecture: "x86_64",
  isolation: "container" as const,
};

const captureEvidence = (digit: string) =>
  createEvidence(
    {
      path: `/tmp/specification-derivation-${digit}`,
      sha256: digit.repeat(64),
      format: "file",
    },
    { id: "fixture", name: "Fixture capture", version: "1" },
    {
      predicateType: "rea.process-capture",
      operation: "capture_process_scenario",
      parameters: {},
      result: EMPTY_PROCESS_CAPTURE_EXAMPLE,
      confidence: "observed",
      authority: "controlled-replay",
      environment,
    },
  );

const comparisonEvidence = () => {
  const left = captureEvidence("a");
  const right = captureEvidence("b");
  const result = processCaptureComparisonSchema.parse({
    status: "unchanged",
    terminal: "unchanged",
    interaction: "unchanged",
    exit: "unchanged",
    filesystem: "unchanged",
    process: "unchanged",
    first_divergence: { status: "none" },
    limitations: [],
  });
  const comparison = createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-comparison",
    operation: "compare_process_captures",
    parameters: {
      left_evidence_id: left.evidence_id,
      right_evidence_id: right.evidence_id,
    },
    result: jsonValueSchema.parse(JSON.parse(JSON.stringify(result))),
    confidence: "derived",
    authority: "analyst-inference",
    evidenceLinks: [left.evidence_id, right.evidence_id],
  });
  return { left, right, comparison };
};

describe("reconstruction specification derivation", () => {
  it("drafts only selected, verifier-accepted claims with full source links", () => {
    const { left, right, comparison } = comparisonEvidence();
    const derived = deriveReconstructionSpecificationEvidence({
      name: "Finite process behavior",
      evidence_bundle: createEvidenceBundle([left, right, comparison]),
      comparisons: [
        {
          comparison_evidence_id: comparison.evidence_id,
          dimensions: ["terminal", "overall"],
        },
      ],
    });

    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.value.operation).toBe("derive_reconstruction_specification");
    expect(derived.value.predicate_type).toBe(
      "rea.reconstruction-specification-draft",
    );
    expect(derived.value.evidence_links).toEqual(
      [left.evidence_id, right.evidence_id, comparison.evidence_id].sort(),
    );
    expect(derived.value.normalized_result).toMatchObject({
      specification: {
        name: "Finite process behavior",
        claims: [
          {
            kind: "behavioral",
            dimension: "overall",
            comparison_evidence_id: comparison.evidence_id,
          },
          {
            kind: "behavioral",
            dimension: "terminal",
            comparison_evidence_id: comparison.evidence_id,
          },
        ],
      },
      source_evidence_ids: [
        left.evidence_id,
        right.evidence_id,
        comparison.evidence_id,
      ].sort(),
    });
  });

  it("rejects a selected dimension unsupported by the comparison record", () => {
    const { left, right, comparison } = comparisonEvidence();
    const derived = deriveReconstructionSpecificationEvidence({
      name: "Invalid selection",
      evidence_bundle: createEvidenceBundle([left, right, comparison]),
      comparisons: [
        {
          comparison_evidence_id: comparison.evidence_id,
          dimensions: ["assembly"],
        },
      ],
    });

    expect(derived.ok).toBe(false);
    if (derived.ok) return;
    expect(derived.error._tag).toBe("AnalysisInputError");
  });
});
