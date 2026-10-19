import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect } from "vitest";

import { ProcessCaptureError } from "../../../src/process/capture/ProcessCaptureError.js";
import {
  executeApprovedFiniteHypothesisProcessProbe,
  prepareFiniteHypothesisProcessProbe,
} from "../../../src/application/ReconstructionProbeBatchService.js";
import { createProcessCaptureEvidence } from "../../../src/application/process/ProcessEvidence.js";
import { captureProcessScenario } from "../../../src/process/capture/ProcessHarness.js";
import { ProcessCaptureResourceScope } from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import {
  parseProcessScenario,
  type ProcessScenario,
} from "../../../src/domain/process/processScenario.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { itWithCaptureCapability } from "./processCaptureCapability.js";

const verifyProbeFailureEvidence = async (
  plan: { readonly plan_sha256: string },
  missingProjectionPlan: { readonly plan_sha256: string },
  ports: Parameters<typeof executeApprovedFiniteHypothesisProcessProbe>[2],
) => {
  const captureFailure = new ProcessCaptureError(
    "injected process capture failure",
  );
  const failedCapture = await executeApprovedFiniteHypothesisProcessProbe(
    plan,
    plan.plan_sha256,
    {
      ...ports,
      capture: async () => {
        throw captureFailure;
      },
    },
  );
  expect(failedCapture.ok).toBe(false);
  if (!failedCapture.ok) expect(failedCapture.error).toBe(captureFailure);

  const missingProjection = await executeApprovedFiniteHypothesisProcessProbe(
    missingProjectionPlan,
    missingProjectionPlan.plan_sha256,
    ports,
  );
  expect(missingProjection.ok).toBe(false);
  if (!missingProjection.ok) {
    expect(missingProjection.error._tag).toBe("AnalysisOutputError");
    expect(missingProjection.error.partialObservation).toMatchObject({
      predicate_type: "rea.process-capture",
      operation: "capture_process_scenario",
    });
  }
};

itWithCaptureCapability(
  "narrows hypotheses from an approved real process capture and rejects stale or altered plans",
  async () => {
    const root = await createTestTempDirectory("ree-finite-probe-");
    const scope = new ProcessCaptureResourceScope();
    let captures = 0;
    const capture = async (scenario: ProcessScenario) => {
      captures += 1;
      const result = await captureProcessScenario(
        scenario,
        undefined,
        process.platform,
        process.env,
        undefined,
        undefined,
        undefined,
        scope,
      );
      if (!result.ok) throw result.error;
      return createProcessCaptureEvidence(scenario, result.value);
    };
    try {
      const source = await capture(
        parseProcessScenario({
          executable: process.execPath,
          arguments: [
            "-e",
            'process.stdout.write("sample output"); process.exit(Number(process.argv[1]))',
            "0",
          ],
          working_directory: root,
          settle_ms: 50,
          limits: { output_bytes: 1 },
        }),
      );
      const request = {
        hypotheses: {
          hypotheses: [
            {
              id: "identity",
              predictions: [
                { input: 0, outcome: 0 },
                { input: 1, outcome: 1 },
              ],
            },
            {
              id: "double",
              predictions: [
                { input: 0, outcome: 0 },
                { input: 1, outcome: 2 },
              ],
            },
          ],
          observations: [
            { input: 0, outcome: 0, evidence_ids: [source.evidence_id] },
          ],
          candidate_inputs: [1],
        },
        source_evidence_id: source.evidence_id,
        selected_input: 1,
        argument_mapping: { kind: "string-argument", argument_index: 2 },
        outcome_json_pointer: "/exit/code",
        max_probes: 1,
      };
      const prepared = prepareFiniteHypothesisProcessProbe(request, source);
      if (!prepared.ok) throw prepared.error;
      const plan = prepared.value;
      expect(plan.scenario.arguments).toEqual([
        "-e",
        'process.stdout.write("sample output"); process.exit(Number(process.argv[1]))',
        "1",
      ]);
      const ports = {
        validateTarget: async (target: {
          executable: string;
          expected_sha256: string;
        }) =>
          createHash("sha256")
            .update(await readFile(target.executable))
            .digest("hex") === target.expected_sha256,
        capture,
      };
      expect(
        (
          await executeApprovedFiniteHypothesisProcessProbe(
            plan,
            "0".repeat(64),
            ports,
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await executeApprovedFiniteHypothesisProcessProbe(
            { ...plan, input: 2 },
            plan.plan_sha256,
            ports,
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await executeApprovedFiniteHypothesisProcessProbe(
            plan,
            plan.plan_sha256,
            { ...ports, validateTarget: async () => false },
          )
        ).ok,
      ).toBe(false);
      expect(captures).toBe(1);
      const executed = await executeApprovedFiniteHypothesisProcessProbe(
        plan,
        plan.plan_sha256,
        ports,
      );
      if (!executed.ok) throw executed.error;
      expect(executed.value.normalized_result).toMatchObject({
        input: 1,
        observed_outcome: 1,
        partial: true,
        surviving_hypotheses: {
          state: "already-unique-within-model",
          surviving_hypothesis_ids: ["identity"],
        },
      });
      expect(executed.value.evidence_links).toContain(source.evidence_id);
      expect(captures).toBe(2);

      const missingProjectionPlan = prepareFiniteHypothesisProcessProbe(
        { ...request, outcome_json_pointer: "/missing" },
        source,
      );
      if (!missingProjectionPlan.ok) throw missingProjectionPlan.error;
      await verifyProbeFailureEvidence(
        plan,
        missingProjectionPlan.value,
        ports,
      );
      expect(captures).toBe(3);
    } finally {
      await scope.close();
    }
  },
  30_000,
);
