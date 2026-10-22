import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import {
  elfFindings,
  javascriptFindings,
  outsideInFindings,
} from "./extract.mjs";
import { scoreFindings, scorePasses } from "./score.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const truthPath = join(repoRoot, "experiments/ree-bench/ground-truth.json");
const thresholdPath = join(repoRoot, "experiments/ree-bench/thresholds.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(args, env = process.env) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

function requireOk(child, label) {
  if (child.status === 0) return;
  const detail = `${child.stderr ?? ""}\n${child.stdout ?? ""}`.trim();
  throw new Error(`${label} failed (${child.status}): ${detail.slice(0, 800)}`);
}

function analyze(target, outDir) {
  const child = run([
    join(repoRoot, "ree.mjs"),
    "analyze",
    target,
    "--authorized",
    "--out",
    outDir,
    "--question",
    "Which modules, functions, imports, and strings are present?",
  ]);
  requireOk(child, `analyze ${target}`);
  return readJson(join(outDir, "evidence.json"));
}

function compileElf(source, destination) {
  const child = spawnSync(
    "gcc",
    ["-nostdlib", "-static", "-O0", "-Wl,-e,entry", "-o", destination, source],
    { encoding: "utf8" },
  );
  requireOk(child, "gcc");
  return destination;
}

function inspectElf(binary) {
  const child = run(
    [
      join(repoRoot, "scripts/rea.mjs"),
      "inspect-binary-layout",
      binary,
      "--json",
    ],
    process.env,
  );
  const stdout = child.stdout ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  if (parsed?.code === "provider_unavailable") {
    return {
      blocked: parsed.message ?? "Binary layout provider is unavailable.",
    };
  }
  requireOk(child, "inspect-binary-layout");
  if (!parsed) throw new Error("inspect-binary-layout did not return JSON.");
  return { record: parsed };
}

async function packArchive(directory, destination) {
  await createPackage(directory, destination);
  return destination;
}

function finish(spec, extracted, thresholds) {
  const scores = scoreFindings(spec.expected, extracted.findings);
  const failures = [
    ...scorePasses(scores, thresholds),
    ...extracted.provenance.map(
      (item) =>
        `${item.type} ${item.key} provenance: ${item.problems.join("; ")}`,
    ),
  ];
  return {
    id: spec.id,
    kind: spec.kind,
    scores,
    notes: extracted.notes,
    provenance: extracted.provenance,
    failures,
    passed: failures.length === 0,
  };
}

async function runCase(spec, thresholds) {
  const work = mkdtempSync(join(tmpdir(), "ree-bench-"));
  try {
    if (spec.kind === "javascript" || spec.kind === "archive") {
      const target =
        spec.kind === "archive"
          ? await packArchive(
              join(repoRoot, spec.members),
              join(work, "app.asar"),
            )
          : join(repoRoot, spec.target);
      const record = analyze(target, join(work, "out"));
      return finish(spec, javascriptFindings(record), thresholds);
    }
    if (spec.kind === "outside-in") {
      const outDir = join(work, "out");
      const child = run([
        join(repoRoot, "ree.mjs"),
        "outside-in",
        "--request",
        join(repoRoot, spec.request),
        "--fixture",
        join(repoRoot, spec.fixture),
        "--out",
        outDir,
        "--json",
      ]);
      requireOk(child, "outside-in");
      const extracted = outsideInFindings(
        JSON.parse(child.stdout),
        join(repoRoot, spec.fixture),
      );
      return finish(spec, extracted, thresholds);
    }
    if (spec.kind === "elf") {
      const binary = compileElf(
        join(repoRoot, spec.source),
        join(work, "fixture"),
      );
      const inspected = inspectElf(binary);
      if (inspected.blocked) {
        return {
          id: spec.id,
          kind: spec.kind,
          scores: null,
          notes: [inspected.blocked],
          provenance: [],
          failures: [`native layout blocked: ${inspected.blocked}`],
          passed: false,
        };
      }
      return finish(spec, elfFindings(inspected.record), thresholds);
    }
    throw new Error(`Unknown bench kind ${spec.kind}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function runBench({ only } = {}) {
  const truth = readJson(truthPath);
  const thresholds = readJson(thresholdPath);
  const selected = truth.cases.filter((spec) => !only || spec.id === only);
  if (selected.length === 0) throw new Error(`No bench case named ${only}.`);
  const cases = [];
  for (const spec of selected) {
    cases.push(await runCase(spec, thresholds[spec.id] ?? {}));
  }
  return {
    schema_version: "ree.bench.v1",
    passed: cases.every((item) => item.passed),
    cases,
  };
}

function ratio(value) {
  return value == null ? "n/a" : value.toFixed(2);
}

export function formatBench(result) {
  const lines = [
    "REE accuracy bench",
    "",
    "case\ttype\tprecision\trecall\texpected\tfound\tfalse claims",
  ];
  for (const item of result.cases) {
    if (!item.scores) {
      lines.push(`${item.id}\tblocked\t\t\t\t\t${item.failures.join(" ")}`);
      continue;
    }
    for (const [type, score] of Object.entries(item.scores)) {
      if (score.expected === 0 && score.found === 0) continue;
      lines.push(
        [
          item.id,
          type,
          ratio(score.precision),
          ratio(score.recall),
          score.expected,
          score.found,
          score.false_claims.length,
        ].join("\t"),
      );
    }
    for (const note of item.notes) lines.push(`note\t${item.id}\t${note}`);
    for (const failure of item.failures)
      lines.push(`fail\t${item.id}\t${failure}`);
  }
  lines.push("", result.passed ? "passed" : "failed");
  return lines.join("\n");
}
