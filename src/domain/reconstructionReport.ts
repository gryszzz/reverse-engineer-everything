import {
  reconstructionReportDigest,
  reconstructionReportSchema,
  type ReconstructionReport,
  type ReconstructionReportRole,
} from "./reconstructionReportSchemas.js";
import type { Evidence } from "./evidence.js";
import type { EvidenceBundle } from "./evidenceBundle.js";
import type {
  ReconstructionSpecification,
  ReconstructionVerificationResult,
} from "./reconstructionVerificationSchemas.js";
import { parseProcessCapture } from "./process/processCaptureParsing.js";
import { uniqueSorted } from "./canonicalOrdering.js";

interface ReconstructionReportInput {
  readonly specification: ReconstructionSpecification;
  readonly verificationEvidenceId: string;
  readonly result: ReconstructionVerificationResult;
  readonly evidenceBundle: EvidenceBundle;
  readonly participantRoles?: {
    readonly left: ReconstructionReportRole;
    readonly right: ReconstructionReportRole;
  };
}

/** Project verified claims and their source Evidence into the shared report contract. */
export const createReconstructionReport = ({
  specification,
  verificationEvidenceId,
  result,
  evidenceBundle,
  participantRoles,
}: ReconstructionReportInput): ReconstructionReport => {
  const records = new Map(
    evidenceBundle.records.map((record) => [record.evidence_id, record]),
  );
  const claimsById = new Map(
    specification.claims.map((claim) => [claim.claim_id, claim]),
  );
  const unknownsById = new Map<string, EvidenceBundle["unknowns"][number]>();
  for (const unknown of evidenceBundle.unknowns) {
    const previous = unknownsById.get(unknown.unknown_id);
    if (previous === undefined || previous.revision < unknown.revision)
      unknownsById.set(unknown.unknown_id, unknown);
  }

  const claims = result.claims.items.map((claimResult) => {
    const specificationClaim = claimsById.get(claimResult.claim_id);
    if (specificationClaim === undefined)
      throw new TypeError(
        `Verified claim ${claimResult.claim_id} is missing from its specification`,
      );
    const source = (evidenceId: string): Evidence => {
      const record = records.get(evidenceId);
      if (record === undefined)
        throw new TypeError(`Report source Evidence ${evidenceId} is missing`);
      return record;
    };
    const side = (
      sideName: "left" | "right",
      evidenceIds: readonly string[],
    ) => ({
      side: sideName,
      role:
        participantRoles?.[sideName] ?? (sideName satisfies "left" | "right"),
      sources: evidenceIds.map((evidenceId) =>
        sourceSummary(source(evidenceId)),
      ),
    });
    return {
      claim_id: claimResult.claim_id,
      title: specificationClaim.title,
      kind: claimResult.kind,
      dimension: claimResult.dimension,
      status: claimResult.status,
      observed_status: claimResult.observed_status,
      comparison_evidence_id: claimResult.comparison_evidence_id,
      participants: {
        left: side("left", claimResult.left_evidence_ids),
        right: side("right", claimResult.right_evidence_ids),
      },
      evidence_links: claimResult.evidence_links,
      unknown_ids: claimResult.unknown_ids,
      limitations: claimResult.limitations,
    };
  });

  const unknownIds = uniqueSorted(
    claims.flatMap(({ unknown_ids }) => unknown_ids),
  );
  const unresolvedUnknowns = unknownIds.map((unknownId) => {
    const unknown = unknownsById.get(unknownId);
    if (unknown === undefined)
      throw new TypeError(
        `Report residual unknown ${unknownId} is missing from the Evidence bundle`,
      );
    return {
      unknown_id: unknown.unknown_id,
      revision: unknown.revision,
      question: unknown.question,
      severity: unknown.severity,
      domain: unknown.domain,
      status: unknown.status,
    };
  });

  const content = {
    report_type: "ree.reconstruction-report" as const,
    schema_version: 1 as const,
    verification: {
      evidence_id: verificationEvidenceId,
      status: result.status,
      specification_sha256: result.specification_sha256,
      summary: result.summary,
    },
    claims,
    unresolved_unknowns: unresolvedUnknowns,
    evidence_links: uniqueSorted([
      verificationEvidenceId,
      ...result.evidence_links,
    ]),
    limitations: uniqueSorted(result.limitations),
    scope_statement:
      "Results apply only to the declared claims and retained Evidence; they do not establish global implementation equivalence." as const,
  };
  return reconstructionReportSchema.parse({
    ...content,
    report_sha256: reconstructionReportDigest(content),
  });
};

const sourceSummary = (evidence: Evidence) => {
  const subjectIdentity =
    evidence.subject === null
      ? null
      : {
          sha256: evidence.subject.digest.sha256,
          format: evidence.subject.format,
          architecture: evidence.subject.architecture,
        };
  const processExecutableIdentity =
    evidence.predicate_type === "rea.process-capture" &&
    evidence.operation === "capture_process_scenario"
      ? (() => {
          const capture = parseProcessCapture(evidence.normalized_result);
          return {
            selected_executable_sha256:
              capture.manifest.selected_executable_sha256,
            executable_sha256: capture.manifest.executable_sha256,
            state: capture.manifest.executable_identity.state,
            reason: capture.manifest.executable_identity.reason,
          };
        })()
      : null;
  const processIdentityPartial =
    processExecutableIdentity !== null &&
    (processExecutableIdentity.selected_executable_sha256 !== null ||
      processExecutableIdentity.executable_sha256 !== null);
  const identityStatus: "identified" | "partial" | "unknown" =
    subjectIdentity !== null
      ? "identified"
      : processIdentityPartial
        ? "partial"
        : "unknown";

  return {
    evidence_id: evidence.evidence_id,
    operation: evidence.operation,
    provider: evidence.provider,
    confidence: evidence.confidence,
    authority: evidence.authority,
    environment: evidence.environment,
    identity_status: identityStatus,
    subject_identity: subjectIdentity,
    process_executable_identity: processExecutableIdentity,
  };
};
