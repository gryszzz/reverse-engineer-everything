import { uniqueSorted } from "../domain/canonicalOrdering.js";
import type { ReconstructionReport } from "../domain/reconstructionReportSchemas.js";

/** Render the versioned report for CLI users without changing its domain data. */
export const renderReconstructionReportMarkdown = (
  report: ReconstructionReport,
): string => {
  const lines = [
    "# Reconstruction report",
    "",
    `**Result: ${report.verification.status.toUpperCase()}** — ${report.verification.summary.passed} passed, ${report.verification.summary.failed} failed, ${report.verification.summary.unknown} unknown across ${report.verification.summary.total} declared claims.`,
    "",
    `Report SHA-256: \`${report.report_sha256}\`  `,
    `Verification Evidence: \`${report.verification.evidence_id}\`  `,
    `Specification SHA-256: \`${report.verification.specification_sha256}\``,
    "",
    `> ${report.scope_statement}`,
    "",
    "## Claims",
    "",
  ];
  const claimLimitations = report.claims.map(
    ({ limitations }) => new Set(limitations),
  );
  const sharedLimitations =
    claimLimitations.length === 0
      ? []
      : uniqueSorted(
          [...(claimLimitations[0] ?? [])].filter((limitation) =>
            claimLimitations.every((items) => items.has(limitation)),
          ),
        );

  for (const claim of report.claims) {
    lines.push(
      `### ${markdownText(claim.title)} — ${claim.status.toUpperCase()}`,
      "",
      `- Claim: \`${claim.claim_id}\` (${claim.kind}, ${markdownText(claim.dimension)}; observed ${claim.observed_status})`,
      `- Comparison Evidence: \`${claim.comparison_evidence_id}\``,
    );
    for (const sideName of ["left", "right"] as const) {
      const side = claim.participants[sideName];
      for (const source of side.sources) {
        const subject = source.subject_identity;
        const process = source.process_executable_identity;
        const identities = [
          ...(subject === null ? [] : [`subject SHA-256 ${subject.sha256}`]),
          ...(process?.selected_executable_sha256 === null || process === null
            ? []
            : [
                `selected executable SHA-256 ${process.selected_executable_sha256}`,
              ]),
          ...(process?.executable_sha256 === null || process === null
            ? []
            : [`process executable SHA-256 ${process.executable_sha256}`]),
        ];
        const environment = source.environment;
        lines.push(
          `- ${side.role} (${sideName}) Evidence: \`${source.evidence_id}\``,
          `  - ${markdownText(source.operation)}; ${source.authority} authority; ${source.confidence} confidence; provider ${markdownText(source.provider.id)}@${markdownText(source.provider.version ?? "unknown")}.`,
          `  - Artifact identity: ${source.identity_status}${identities.length === 0 ? "." : `; ${identities.join("; ")}.`}`,
          `  - Environment: ${environment === null ? "not recorded." : `${markdownText(environment.platform)}/${markdownText(environment.architecture)}, ${environment.isolation} isolation (${markdownText(environment.id)}).`}`,
        );
      }
    }
    lines.push(
      `- Evidence links: ${claim.evidence_links.map((id) => `\`${id}\``).join(", ")}`,
    );
    if (claim.unknown_ids.length > 0)
      lines.push(
        `- Residual unknowns: ${claim.unknown_ids.map((id) => `\`${id}\``).join(", ")}`,
      );
    for (const limitation of claim.limitations)
      if (!sharedLimitations.includes(limitation))
        lines.push(`- Limitation: ${markdownText(limitation)}`);
    lines.push("");
  }

  lines.push("## Shared claim limitations", "");
  if (sharedLimitations.length === 0)
    lines.push("No limitations were shared by every declared claim.", "");
  else {
    for (const limitation of sharedLimitations)
      lines.push(`- ${markdownText(limitation)}`);
    lines.push("");
  }

  lines.push("## Unresolved behavior", "");
  if (report.unresolved_unknowns.length === 0)
    lines.push(
      "No residual-unknown records were linked by these claims. Unknown claim outcomes can still reflect incomplete observations or limitations.",
      "",
    );
  else
    for (const unknown of report.unresolved_unknowns)
      lines.push(
        `- \`${unknown.unknown_id}\` (${unknown.status}, ${unknown.severity}): ${markdownText(unknown.question)}`,
      );
  if (report.unresolved_unknowns.length > 0) lines.push("");

  lines.push("## Report limitations", "");
  if (report.limitations.length === 0)
    lines.push("No additional report-level limitations were recorded.", "");
  else
    for (const limitation of report.limitations)
      lines.push(`- ${markdownText(limitation)}`);
  if (report.limitations.length > 0) lines.push("");

  lines.push(
    "## Evidence retention",
    "",
    "This report stores Evidence IDs and identities, not copies of source Evidence. Keep the supplied Evidence bundle beside this report so every cited record remains inspectable.",
    "",
    `Evidence links: ${report.evidence_links.map((id) => `\`${id}\``).join(", ")}`,
    "",
  );
  return lines.join("\n");
};

const markdownText = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replaceAll("!", "\\!")
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
