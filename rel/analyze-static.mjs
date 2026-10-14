import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
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
import { summarizeAnalysisView } from "./evidence-summary.mjs";

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
    .replaceAll(/[\r\n|]/gu, " ")
    .replaceAll(String.fromCharCode(96), "'");
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

export function investigationReport(record) {
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
    "- Graph coverage: " + safe(JSON.stringify(record.graph_coverage)),
    "- Semantic coverage: " + safe(JSON.stringify(record.semantic_coverage)),
    "",
    "## Relationships",
    rows(record.relationships, "- No relationships exposed by this graph."),
    "",
    "## Node types",
    rows(record.node_kinds, "- No node kinds exposed."),
    "",
    "## Explicit limitations",
    ...(record.limitations.length
      ? record.limitations.map((item) => "- " + safe(item))
      : [
          "- None listed in the projected fields; completeness is not guaranteed.",
        ]),
    "- Static imports or relationships alone do not prove that a code path executed.",
    "- This view does not independently recompute every REA Evidence digest or prove a reconstruction is functionally equivalent.",
    "",
    "## Remaining unknowns",
    ...(record.unknowns ?? []).map((item) => "- " + safe(item)),
    "",
    "## Follow-up with Codex",
    "Ask it to read the retained Evidence, find the specific source lines relevant to your question, and distinguish direct observations, inferred relationships and unknowns.",
    "",
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
  const result = {
    ...summary,
    input_path: plan.target,
    question: options.question ?? null,
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
