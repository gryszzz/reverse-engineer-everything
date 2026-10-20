import { describe, expect, it } from "vitest";

import { ARTIFACT_COMPARISON_EXAMPLE } from "../contracts/artifactComparisonExample.js";
import { compareArtifacts } from "../domain/artifactComparison.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../contracts/functionComparisonExample.js";
import { compareFunctions } from "../domain/functionComparison.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../domain/process/processCaptureExample.js";
import { buildReconstructionReport } from "./ReconstructionReportService.js";

const environment = {
  id: "fixture-macos",
  platform: "darwin",
  architecture: "arm64",
  isolation: "process" as const,
};

const processComparison = (
  left: Evidence,
  right: Evidence,
  terminal: "unchanged" | "changed" | "unknown",
): Evidence =>
  createEvidence(
    undefined,
    {
      id: "rea-process",
      name: "REA deterministic process harness",
      version: "3",
    },
    {
      predicateType: "rea.process-comparison",
      operation: "compare_process_captures",
      parameters: {
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
      },
      result: {
        status: terminal === "changed" ? "changed" : terminal,
        terminal,
        interaction: "unchanged",
        exit: "unchanged",
        filesystem: "unchanged",
        process: "unchanged",
        first_divergence:
          terminal === "changed"
            ? {
                status: "found",
                dimension: "terminal",
                index: 0,
                left_at_ms: 0,
                right_at_ms: 0,
                left: "reference output",
                right: "candidate output",
              }
            : terminal === "unknown"
              ? {
                  status: "unknown",
                  reason: "No complete terminal observation.",
                }
              : { status: "none" },
        limitations: [],
      },
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );

const processSource = (digit: string): Evidence =>
  createEvidence(
    { path: `/fixture/${digit}`, sha256: digit.repeat(64), format: "file" },
    { id: "fixture-process", name: "Fixture process", version: "1" },
    {
      predicateType: "rea.process-capture",
      operation: "capture_process_scenario",
      parameters: {},
      result: EMPTY_PROCESS_CAPTURE_EXAMPLE as unknown as JsonValue,
      confidence: "observed",
      authority: "controlled-replay",
      environment,
    },
  );

const processRequest = (terminal: "unchanged" | "changed" | "unknown") => {
  const left = processSource("1");
  const right = processSource("2");
  const comparison = processComparison(left, right, terminal);
  return {
    specification: {
      name: "Terminal reconstruction",
      claims: [
        {
          kind: "behavioral" as const,
          claim_id: "terminal-output",
          title: "Terminal output matches for the recorded case",
          comparison_evidence_id: comparison.evidence_id,
          dimension: "terminal" as const,
        },
      ],
    },
    evidence_bundle: createEvidenceBundle([left, right, comparison]),
    participant_roles: {
      left: "reference" as const,
      right: "candidate" as const,
    },
  };
};

describe("reconstruction report", () => {
  it("renders passing behavioral claims with explicit sides and artifact digests", () => {
    const result = buildReconstructionReport(processRequest("unchanged"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.report).toMatchObject({
      report_type: "ree.reconstruction-report",
      schema_version: 1,
      verification: { status: "pass", summary: { passed: 1, failed: 0 } },
      claims: [
        {
          claim_id: "terminal-output",
          status: "pass",
          participants: {
            left: {
              role: "reference",
              sources: [
                {
                  subject_identity: { sha256: "1".repeat(64) },
                  environment: {
                    id: "fixture-macos",
                    platform: "darwin",
                    architecture: "arm64",
                    isolation: "process",
                  },
                },
              ],
            },
            right: {
              role: "candidate",
              sources: [{ subject_identity: { sha256: "2".repeat(64) } }],
            },
          },
        },
      ],
    });
    expect(result.value.report.evidence_links).toContain(
      result.value.verification_evidence.evidence_id,
    );
  });

  it("reports observed counterexamples as failures without changing verifier semantics", () => {
    const result = buildReconstructionReport(processRequest("changed"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.verification).toMatchObject({
      status: "fail",
      summary: { passed: 0, failed: 1, unknown: 0 },
    });
    expect(result.value.report.claims[0]).toMatchObject({
      status: "fail",
      observed_status: "changed",
    });
  });

  it("keeps incomplete observations unknown and deterministic across bundle ordering", () => {
    const request = processRequest("unknown");
    const first = buildReconstructionReport(request);
    const second = buildReconstructionReport({
      ...request,
      evidence_bundle: createEvidenceBundle(
        [...request.evidence_bundle.records].reverse(),
      ),
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.report.verification.status).toBe("unknown");
    expect(first.value.report.claims[0]).toMatchObject({
      status: "unknown",
      observed_status: "unknown",
    });
    expect(first.value.report).toEqual(second.value.report);
  });
});

describe("structural reconstruction report routes", () => {
  it("projects structural artifact comparisons through the same report shape", () => {
    const { left, right } = ARTIFACT_COMPARISON_EXAMPLE;
    const comparisonResult = compareArtifacts(left, right);
    const comparison = createEvidence(
      undefined,
      {
        id: "rea-artifact-comparison",
        name: "REA artifact comparison",
        version: "1",
      },
      {
        predicateType: "rea.artifact-comparison",
        operation: "compare_artifacts",
        parameters: {
          left_evidence_ids: [left.evidence_id],
          right_evidence_ids: [right.evidence_id],
        },
        result: comparisonResult as unknown as JsonValue,
        confidence: "derived",
        authority: "analyst-inference",
        evidenceLinks: [left.evidence_id, right.evidence_id],
      },
    );
    const result = buildReconstructionReport({
      specification: {
        name: "Artifact compatibility",
        claims: [
          {
            kind: "structural-artifact",
            claim_id: "artifact-layout",
            title: "Artifact layout remains equal",
            comparison_evidence_id: comparison.evidence_id,
            dimension: "overall",
          },
        ],
      },
      evidence_bundle: createEvidenceBundle([left, comparison, right]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.claims[0]).toMatchObject({
      kind: "structural-artifact",
      participants: {
        left: { sources: [{ subject_identity: { sha256: "0".repeat(64) } }] },
        right: { sources: [{ subject_identity: { sha256: "1".repeat(64) } }] },
      },
    });
  });

  it("projects structural function comparisons through the same report shape", () => {
    const { left, right } = FUNCTION_COMPARISON_EXAMPLE;
    const comparisonResult = compareFunctions(left, right);
    const comparison = createEvidence(
      undefined,
      {
        id: "rea-function-comparison",
        name: "REA function comparison",
        version: "1",
      },
      {
        predicateType: "rea.function-comparison",
        operation: "compare_functions",
        parameters: {
          left_evidence_id: left.evidence_id,
          right_evidence_id: right.evidence_id,
        },
        result: comparisonResult as unknown as JsonValue,
        confidence: "derived",
        authority: "analyst-inference",
        evidenceLinks: [left.evidence_id, right.evidence_id],
      },
    );
    const result = buildReconstructionReport({
      specification: {
        name: "Function compatibility",
        claims: [
          {
            kind: "structural-function",
            claim_id: "function-pseudocode",
            title: "Function pseudocode remains equal",
            comparison_evidence_id: comparison.evidence_id,
            dimension: "pseudocode",
          },
        ],
      },
      evidence_bundle: createEvidenceBundle([left, comparison, right]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.claims[0]).toMatchObject({
      kind: "structural-function",
      status: "fail",
      participants: {
        left: { sources: [{ subject_identity: { sha256: "0".repeat(64) } }] },
        right: { sources: [{ subject_identity: { sha256: "1".repeat(64) } }] },
      },
    });
  });
});

describe("reconstruction report closure validation", () => {
  it("refuses to produce a report when a source observation is missing", () => {
    const request = processRequest("unchanged");
    const comparison = request.evidence_bundle.records.find(
      ({ operation }) => operation === "compare_process_captures",
    );
    expect(comparison).toBeDefined();
    if (comparison === undefined) return;
    const remainingSource = request.evidence_bundle.records.find(
      ({ evidence_id }) =>
        evidence_id !== comparison.evidence_id &&
        comparison.evidence_links.includes(evidence_id),
    );
    expect(remainingSource).toBeDefined();
    if (remainingSource === undefined) return;
    const incomplete = {
      ...request,
      evidence_bundle: createEvidenceBundle([comparison, remainingSource]),
    };
    const result = buildReconstructionReport(incomplete);
    expect(result.ok).toBe(false);
  });
});
