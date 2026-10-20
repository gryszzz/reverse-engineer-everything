import { describe, expect, it } from "vitest";

import { buildReconstructionReport } from "../../../src/application/ReconstructionReportService.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../../src/domain/process/processCaptureExample.js";
import { renderReconstructionReportMarkdown } from "../../../src/cli/reconstructionReportMarkdown.js";

const source = (
  digit: string,
  providerId = "fixture-process",
  environmentId = "fixture-macos",
) =>
  createEvidence(
    { path: `/fixture/${digit}`, sha256: digit.repeat(64), format: "file" },
    { id: providerId, name: "Fixture process", version: "1" },
    {
      predicateType: "rea.process-capture",
      operation: "capture_process_scenario",
      parameters: {},
      result: EMPTY_PROCESS_CAPTURE_EXAMPLE as unknown as JsonValue,
      confidence: "observed",
      authority: "controlled-replay",
      environment: {
        id: environmentId,
        platform: "darwin",
        architecture: "arm64",
        isolation: "process",
      },
    },
  );

const reportFor = (
  title: string,
  sourceMetadata?: { providerId?: string; environmentId?: string },
) => {
  const left = source(
    "1",
    sourceMetadata?.providerId,
    sourceMetadata?.environmentId,
  );
  const right = source("2");
  const comparison = createEvidence(
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
        status: "unchanged",
        terminal: "unchanged",
        interaction: "unchanged",
        exit: "unchanged",
        filesystem: "unchanged",
        process: "unchanged",
        first_divergence: { status: "none" },
        limitations: [],
      },
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );
  const result = buildReconstructionReport({
    specification: {
      name: "Markdown report fixture",
      claims: [
        {
          kind: "behavioral",
          claim_id: "terminal-output",
          title,
          comparison_evidence_id: comparison.evidence_id,
          dimension: "terminal",
        },
      ],
    },
    evidence_bundle: createEvidenceBundle([left, right, comparison]),
    participant_roles: { left: "reference", right: "candidate" },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value.report;
};

describe("reconstruction report Markdown presentation", () => {
  it("renders report status, participant roles, and Evidence links", () => {
    const report = reportFor("Terminal behavior matches for the recorded case");
    const markdown = renderReconstructionReportMarkdown(report);

    expect(markdown).toContain("**Result: PASS**");
    expect(markdown).toContain("reference (left)");
    expect(markdown).toContain("candidate (right)");
    expect(markdown).toContain(report.verification.evidence_id);
    expect(markdown).toContain(report.report_sha256);
  });

  it("escapes analyst-controlled text so titles cannot inject Markdown links or images", () => {
    const markdown = renderReconstructionReportMarkdown(
      reportFor("![remote](https://example.test/image.png)"),
    );

    expect(markdown).not.toContain("![remote]");
    expect(markdown).not.toContain("](https://example.test");
    expect(markdown).toContain("\\!");
    expect(markdown).toContain("\\(");
  });

  it("escapes untrusted provider and environment labels retained from Evidence", () => {
    const markdown = renderReconstructionReportMarkdown(
      reportFor("Safe title", {
        providerId: "![provider](https://example.test)",
        environmentId: "<script>bad()</script>",
      }),
    );

    expect(markdown).not.toContain("![provider]");
    expect(markdown).not.toContain("](https://example.test)");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&lt;script&gt;");
  });
});
