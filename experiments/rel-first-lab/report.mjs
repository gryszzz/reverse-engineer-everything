import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { summarizeEvidence } from "../../rel/evidence-summary.mjs";
export { summarizeEvidence } from "../../rel/evidence-summary.mjs";

const safeInline = (value) =>
  String(value).replaceAll("`", "'").replaceAll("\n", " ");
export function markdownReport(summary) {
  const lines = [
    "# REE — first real analyzer run",
    "",
    "**Status:** REA produced a JavaScript application Evidence record for the fork-owned lab.",
    "",
    "## What the analyzer actually returned",
    "",
    `- Evidence ID: \`${safeInline(summary.evidence_id)}\``,
    `- Input artifact SHA-256: \`${safeInline(summary.artifact_sha256)}\``,
    `- Application graph ID: \`${safeInline(summary.application_graph_id)}\``,
    `- Modules in statistics: ${summary.counts.modules ?? "not provided"}`,
    `- Files parsed: ${summary.counts.files_parsed ?? "not provided"}`,
    `- Parse failures: ${summary.counts.parse_failures ?? "not provided"}`,
    `- Graph nodes / edges: ${summary.counts.nodes} / ${summary.counts.edges}`,
    `- Graph coverage (raw): \`${safeInline(JSON.stringify(summary.graph_coverage))}\``,
    "",
    "**Observed relationship types (static graph; not runtime proof):**",
    ...Object.entries(summary.relationships)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, count]) => `- ${safeInline(type)}: ${count}`),
    "",
    "## Learning checkpoint",
    "",
    "The toy CLI's output is established separately by `verify.mjs`. The sample source states that exact title matches outrank prefixes, substrings, and tags. REA's graph describes *static* structure; it does not by itself prove which ranking branches executed during a search.",
    "",
    "## Unknowns / limitations",
    "",
    ...(summary.limitations.length
      ? summary.limitations
      : [
          "No explicit limitations surfaced in these fields; absence does not prove completeness.",
        ]
    ).map((x) => `- ${safeInline(x)}`),
    "- No independent digest re-computation or full reconstruction-equivalence test was performed by this report script.",
    "- The graph is evidence of a single local sample, not evidence that the engine can reverse engineer every application.",
    "",
    "**Next question:** Can the saved Evidence trace `cli.mjs` importing `search.mjs` and `notes.mjs`, with exact source locations?",
    "",
  ];
  return lines.join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 5)
      throw new Error(
        "Usage: node report.mjs evidence.json summary.json report.md",
      );
    const record = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const summary = summarizeEvidence(record);
    writeFileSync(process.argv[3], `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(process.argv[4], markdownReport(summary));
    console.log(
      `REE Evidence: ${summary.counts.nodes} nodes, ${summary.counts.edges} edges; ${summary.evidence_id}`,
    );
  } catch (error) {
    console.error(`REE report failed: ${error.message}`);
    process.exitCode = 1;
  }
}
