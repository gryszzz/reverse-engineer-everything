import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTarget } from "./intake.mjs";
import {
  exploreEvidence,
  MAX_EVIDENCE_FILE_BYTES,
} from "./evidence-explorer.mjs";
import { summarizeAnalysisView } from "./evidence-summary.mjs";
import {
  questionEvidenceSearchGuide,
  questionSearchTerms,
} from "./question-guidance.mjs";

export const repository = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repository, "scripts", "rea.mjs");

const inside = (base, candidate) => {
  const offset = relative(base, candidate);
  return (
    offset === "" ||
    (offset !== ".." && !offset.startsWith(".." + sep) && !isAbsolute(offset))
  );
};

/** Fail before creating files or invoking the trusted analyzer. */
export function planStaticAnalysis(inputPath, outputPath, authorized) {
  if (authorized !== true)
    throw new Error(
      "Specify --authorized to confirm permission for this read-only target.",
    );
  const detected = classifyTarget(inputPath);
  if (
    detected.kind !== "javascript" ||
    detected.exists !== true ||
    (detected.input_type !== "directory" &&
      extname(detected.target).toLowerCase() !== ".asar")
  ) {
    throw new Error(
      "Simple Mode executes only static JavaScript/Electron directory or ASAR analysis. Other formats require their REA provider.",
    );
  }
  if (!outputPath || typeof outputPath !== "string")
    throw new Error("Provide --out DIR outside the repository and target.");
  const target = realpathSync(detected.target);
  const output = resolve(outputPath);
  // Require an existing output parent so we never create arbitrary ancestor folders.
  const outputParent = realpathSync(dirname(output));
  const destination = resolve(outputParent, basename(output));
  const root = realpathSync(repository);
  if (
    inside(root, destination) ||
    inside(target, destination) ||
    inside(destination, target)
  ) {
    throw new Error(
      "Output must be outside the REE repository and the target, with neither containing the other.",
    );
  }
  if (existsSync(destination)) {
    throw new Error(
      "Output directory already exists. Choose a new path so no previous evidence is overwritten.",
    );
  }
  if (!existsSync(join(root, "dist", "cli-runtime", "cli.js"))) {
    throw new Error(
      "Built REA runtime missing. Run npm ci && npm run build:cached first.",
    );
  }
  return {
    target,
    output: destination,
    format: detected.input_type === "directory" ? "directory" : "asar",
  };
}

const runToFile = (args, output, filename, timeoutMs) => {
  const out = openSync(join(output, filename), "wx");
  const err = openSync(join(output, filename + ".stderr.txt"), "wx");
  const start = performance.now();
  let completed;
  try {
    completed = spawnSync(process.execPath, args, {
      cwd: repository,
      stdio: ["ignore", out, err],
      timeout: timeoutMs,
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  if (completed.error || completed.status !== 0) {
    throw new Error(
      filename +
        " failed (exit " +
        completed.status +
        ", signal " +
        completed.signal +
        "). See the retained stderr log.",
    );
  }
  return Math.round(performance.now() - start);
};

const safe = (input) =>
  String(input)
    .replaceAll(/[\r\n]/gu, " ")
    .replaceAll(/([\\`*_{}[\]()#+\-.!|<>~])/gu, "\\$1");
const inlineCode = (input) =>
  "`" +
  String(input ?? "unknown")
    .replaceAll(/[\r\n]/gu, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`") +
  "`";
const rows = (items, fallback) => {
  const entries = Object.entries(items ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 15);
  return entries.length > 0
    ? entries
        .map(([name, count]) => "- " + safe(name) + ": " + count)
        .join("\n")
    : fallback;
};

const coverageText = (coverage) => {
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage))
    return "unknown";
  const parts = [`status ${safe(coverage.status ?? "unknown")}`];
  if (typeof coverage.truncated === "boolean")
    parts.push(coverage.truncated ? "truncated" : "not truncated");
  if (
    Number.isSafeInteger(coverage.omitted_count) &&
    coverage.omitted_count > 0
  )
    parts.push(`${coverage.omitted_count} omitted`);
  if (Array.isArray(coverage.families)) {
    const familyUnknowns = coverage.families.reduce(
      (total, family) =>
        total +
        (Number.isSafeInteger(family?.unknown_count) && family.unknown_count > 0
          ? family.unknown_count
          : 0),
      0,
    );
    if (familyUnknowns > 0)
      parts.push(
        `${familyUnknowns.toLocaleString("en-US")} family-level unknowns`,
      );
  }
  return parts.join("; ");
};

const reportItems = (items, fallback) => {
  const unique = [
    ...new Set((items ?? []).filter((item) => typeof item === "string")),
  ];
  if (unique.length === 0) return [fallback];
  const shown = unique.slice(0, 8).map((item) => "- " + safe(item));
  if (unique.length > shown.length)
    shown.push(
      `- ${unique.length - shown.length} more descriptions are in summary.json and view-evidence.json.`,
    );
  return shown;
};

const questionEvidencePreviews = (evidencePath, question) => {
  const terms = questionSearchTerms(question);
  if (terms.length === 0) return { status: "no-search-terms", queries: [] };
  const evidenceStat = statSync(evidencePath);
  if (!evidenceStat.isFile())
    throw new Error("REA did not retain a regular Evidence JSON file.");
  const evidenceSize = evidenceStat.size;
  if (evidenceSize > MAX_EVIDENCE_FILE_BYTES)
    return {
      status: "skipped-evidence-exceeds-explorer-limit",
      evidence_bytes: evidenceSize,
      max_evidence_bytes: MAX_EVIDENCE_FILE_BYTES,
      queries: terms.map((term) => ({ term, matching: null, edges: [] })),
    };
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  return {
    status: "searched",
    evidence_bytes: evidenceSize,
    queries: terms.map((term) => {
      const result = exploreEvidence(evidence, { find: term, limit: 3 });
      return {
        term,
        matching: result.matching,
        displayed: result.displayed,
        truncated: result.truncated,
        edges: result.edges.map((edge) => ({
          edge_id: edge.edge_id,
          relation: edge.relation,
          source: edge.source.label,
          target: edge.target.label,
          location: edge.location,
          state: edge.state,
          confidence: edge.confidence,
          authority: edge.authority,
        })),
      };
    }),
  };
};

const readableLocation = (location) => {
  if (typeof location !== "string") return "location unavailable";
  try {
    const parsed = JSON.parse(location);
    const source = typeof parsed.source === "string" ? parsed.source : null;
    const line = Number.isSafeInteger(parsed.start?.line)
      ? parsed.start.line
      : null;
    return source ? source + (line === null ? "" : ":" + line) : location;
  } catch {
    return location;
  }
};

const questionEvidenceReport = (preview) => {
  if (preview.status === "not-run")
    return [
      "No automatic Evidence preview was available for this report record; use the exact search commands above.",
    ];
  if (preview.status === "no-search-terms")
    return [
      "No distinct search terms were derived from the question; use the unfiltered command above to browse the saved graph.",
    ];
  if (preview.status === "skipped-evidence-exceeds-explorer-limit")
    return [
      `Automatic preview skipped: saved Evidence is ${preview.evidence_bytes.toLocaleString("en-US")} bytes, over the Evidence Explorer's ${preview.max_evidence_bytes.toLocaleString("en-US")} byte limit. Use REA's bounded analysis views for larger records.`,
    ];
  const lines = [];
  for (const query of preview.queries) {
    lines.push(
      `### ${inlineCode(query.term)} — ${query.matching} recorded relationships matched; showing ${query.displayed}.`,
      "",
    );
    if (query.matching === 0) {
      lines.push(
        "No recorded relationship matched this text. That does not show that the feature or behavior is absent.",
        "",
      );
      continue;
    }
    for (const edge of query.edges) {
      lines.push(
        `- ${inlineCode(edge.source)} --[${safe(edge.relation)}]--> ${inlineCode(edge.target)}; ${inlineCode(readableLocation(edge.location))}; state ${inlineCode(edge.state)}, confidence ${inlineCode(edge.confidence)}, authority ${inlineCode(edge.authority)}; edge ${inlineCode(edge.edge_id)}.`,
      );
    }
    if (query.truncated)
      lines.push(
        `- Additional matches are available with the exact \`--find '${safe(query.term)}'\` command above.`,
      );
    lines.push("");
  }
  return lines;
};

export function investigationReport(record) {
  const questionGuide = questionEvidenceSearchGuide(record.question, {
    disableExplorerCommand:
      record.question_evidence_preview?.status ===
      "skipped-evidence-exceeds-explorer-limit",
  });
  const limitations = Array.isArray(record.limitations)
    ? record.limitations
    : [];
  const limitationSet = new Set(limitations);
  const unknowns = Array.isArray(record.unknowns) ? record.unknowns : [];
  const additionalUnknowns = unknowns.filter(
    (item) => typeof item === "string" && !limitationSet.has(item),
  );
  return [
    "# REE — static JavaScript investigation",
    "",
    "**Target:** " + safe(record.input_path),
    "**Question:** " +
      safe(record.question || "Map the source and its dependencies"),
    "**Status:** REA produced and projected identified static Evidence; this does not prove runtime behavior.",
    "",
    "## Measured structure",
    "- Application graph nodes: " + record.counts.nodes,
    "- Application graph relationships: " + record.counts.edges,
    "- Parsed JavaScript files: " + (record.counts.files_parsed ?? "unknown"),
    "- Parse failures: " + (record.counts.parse_failures ?? "unknown"),
    "- Summary provider: " + safe(record.projection_provider ?? "unknown"),
    "- Evidence ID: " + safe(record.evidence_id),
    "- Artifact SHA-256: " + safe(record.artifact_sha256),
    "- Graph ID: " + safe(record.application_graph_id),
    "- Graph coverage: " + coverageText(record.graph_coverage),
    "- Semantic coverage: " + coverageText(record.semantic_coverage),
    "",
    "## Relationships",
    rows(record.relationships, "- No relationships exposed by this graph."),
    "",
    "## Node types",
    rows(record.node_kinds, "- No node kinds exposed."),
    "",
    "## Explicit limitations",
    ...reportItems(
      limitations,
      "- No explicit limitations were listed; completeness is not guaranteed.",
    ),
    "- Static imports or relationships alone do not prove that a code path executed.",
    "- This view does not independently recompute every REA Evidence digest or prove a reconstruction is functionally equivalent.",
    "",
    "## Remaining unknowns",
    ...reportItems(
      additionalUnknowns,
      "- No additional unknown descriptions beyond the listed limitations. Check coverage and the retained Evidence before treating a behavior as understood.",
    ),
    "",
    "## Literal Evidence matches",
    "The bounded previews below run the Evidence Explorer's case-insensitive text filter over saved static relationships. They are search results, not semantic answers or proof of runtime execution.",
    "",
    ...questionEvidenceReport(
      record.question_evidence_preview ?? {
        status: "not-run",
        queries: [],
      },
    ),
    "",
    questionGuide.markdown,
  ].join("\n");
}

/** Runs only REA's static analyzer; never launches the supplied application. */
export function runStaticAnalysis(options) {
  const plan = planStaticAnalysis(
    options.target,
    options.out,
    options.authorized,
  );
  mkdirSync(plan.output);
  const elapsed = runToFile(
    [
      cli,
      "analyze-javascript-application",
      plan.target,
      "--summary",
      "--evidence-out",
      join(plan.output, "evidence.json"),
      "--json",
    ],
    plan.output,
    "view-evidence.json",
    180000,
  );
  const summary = summarizeAnalysisView(
    JSON.parse(readFileSync(join(plan.output, "view-evidence.json"), "utf8")),
  );
  // The complete parent is saved by REA before it returns the derived view.
  if (!existsSync(join(plan.output, "evidence.json")))
    throw new Error(
      "REA did not retain complete Evidence; no report generated.",
    );
  const evidencePath = join(plan.output, "evidence.json");
  const result = {
    ...summary,
    input_path: plan.target,
    question: options.question ?? null,
    question_search_terms: questionSearchTerms(options.question),
    question_evidence_preview: questionEvidencePreviews(
      evidencePath,
      options.question,
    ),
    timing_ms: { analyze_and_project: elapsed },
  };
  writeFileSync(
    join(plan.output, "summary.json"),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
  writeFileSync(
    join(plan.output, "REE_EVIDENCE_REPORT.md"),
    investigationReport(result),
    { flag: "wx" },
  );
  return {
    output: plan.output,
    evidence_id: summary.evidence_id,
    nodes: summary.counts.nodes,
    edges: summary.counts.edges,
    report: join(plan.output, "REE_EVIDENCE_REPORT.md"),
  };
}
