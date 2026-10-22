import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allowlistedEnv } from "./experiment.mjs";
import { studioError } from "./errors.mjs";
import { withStudioLock } from "./lock.mjs";
import { repositoryRoot } from "./paths.mjs";
import { newId } from "./projects.mjs";

const active = new Map();
const children = new Map();
const stopReason = new Map();
const TIMEOUT_MS = 180000;

function compactSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const list = (value) =>
    Array.isArray(value)
      ? value.filter((item) => typeof item === "string").slice(0, 12)
      : [];
  return {
    evidence_id: summary.evidence_id ?? null,
    counts: summary.counts ?? null,
    relationships: summary.relationships ?? null,
    limitations: list(summary.limitations),
    unknowns: list(summary.unknowns),
    graph_coverage: summary.graph_coverage ?? null,
    semantic_coverage: summary.semantic_coverage ?? null,
    timing_ms: summary.timing_ms ?? null,
    question_evidence_preview: summary.question_evidence_preview ?? null,
  };
}

function readSummary(directory) {
  const path = join(directory, "summary.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function finishRun(store, projectId, runId, patch) {
  return store.update(projectId, (project) => {
    const run = project.runs.find((item) => item.id === runId);
    if (!run) return project;
    Object.assign(run, patch, { finished_at: new Date().toISOString() });
    return project;
  });
}

export function cancelStaticAnalysis(dataDir, runId) {
  if (active.get(dataDir) !== runId) return false;
  const child = children.get(runId);
  if (!child) return false;
  stopReason.set(runId, "cancelled");
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
  return true;
}

export function startStaticAnalysis({
  store,
  projectId,
  artifactId,
  question,
  authorized,
}) {
  if (authorized !== true)
    throw studioError(
      "Analysis requires authorized: true. The studio does not infer permission.",
      403,
    );
  return withStudioLock(store.root, () => {
    if (active.has(store.root))
      throw studioError(
        "An analysis is already running in this studio data directory.",
        409,
      );
    const project = store.read(projectId);
    const artifact = project.artifacts.find((item) => item.id === artifactId);
    if (!artifact) throw studioError("Unknown artifact.", 404);
    if (artifact.intake?.kind !== "javascript")
      throw studioError(
        "The studio executes static analysis only for a JavaScript or Electron directory or ASAR. Other routes stay in the readiness report.",
      );
    const runId = newId("run_");
    const output = join(store.directory(projectId), "runs", runId);
    mkdirSync(join(store.directory(projectId), "runs"), { recursive: true });
    const argv = [
      process.execPath,
      join(repositoryRoot, "ree.mjs"),
      "analyze",
      artifact.path,
      "--authorized",
      "--out",
      output,
      "--json",
    ];
    const savedQuestion = question ?? project.question;
    if (savedQuestion) argv.push("--question", savedQuestion);
    const run = {
      id: runId,
      artifact_id: artifact.id,
      kind: "static-javascript",
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      output_dir: output,
      question: savedQuestion,
      authorization: "explicit-request",
      command: { argv },
      evidence_id: null,
      summary: null,
      error: null,
    };
    store.update(projectId, (current) => {
      current.runs.push(run);
      return current;
    });
    active.set(store.root, runId);
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: repositoryRoot,
        env: allowlistedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      active.delete(store.root);
      finishRun(store, projectId, runId, {
        status: "failed",
        error:
          error instanceof Error ? error.message : "Could not start analysis.",
      });
      throw error;
    }
    children.set(runId, child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stopReason.set(runId, "timeout");
      child.kill("SIGTERM");
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16000) stderr += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      void withStudioLock(store.root, () => {
        active.delete(store.root);
        children.delete(runId);
        const reason = stopReason.get(runId) ?? null;
        stopReason.delete(runId);
        let parsed = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          parsed = null;
        }
        const summary = compactSummary(readSummary(output));
        const evidenceId = summary?.evidence_id ?? parsed?.evidence_id ?? null;
        const completed = code === 0 && Boolean(evidenceId);
        const status = completed
          ? "completed"
          : reason === "cancelled"
            ? "cancelled"
            : "failed";
        const errorText =
          reason === "timeout"
            ? "Timed out after 180000 ms."
            : (stderr || `Analyzer exited ${code} signal ${signal}`).slice(
                0,
                2000,
              );
        finishRun(store, projectId, runId, {
          status,
          evidence_id: status === "completed" ? evidenceId : null,
          summary: status === "completed" ? summary : null,
          error: status === "completed" ? null : errorText,
        });
      });
    });
    return store.read(projectId);
  });
}
