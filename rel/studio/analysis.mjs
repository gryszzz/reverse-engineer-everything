import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bestReadyRoute,
  commandArgv,
  collectRouteFacts,
  routeById,
  routesForTarget,
} from "./engine-routes.mjs";
import { studioError } from "./errors.mjs";
import { withStudioLock } from "./lock.mjs";
import { narrateEvidence, narrateJavascriptSummary } from "./narrative.mjs";
import { repositoryRoot } from "./paths.mjs";
import { newId } from "./projects.mjs";
import { engineChildEnv } from "./tool-env.mjs";

const active = new Map();
const children = new Map();
const stopReason = new Map();
const TIMEOUT_MS = 180000;
const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/u;

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

function parseEngineJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.lastIndexOf("\n{");
    if (start === -1) return null;
    try {
      return JSON.parse(stdout.slice(start + 1));
    } catch {
      return null;
    }
  }
}

function engineErrorText(parsed, stderr, code, signal) {
  if (typeof parsed?.message === "string") return parsed.message.slice(0, 2000);
  if (typeof parsed?.error === "string") return parsed.error.slice(0, 2000);
  if (stderr) return stderr.slice(0, 2000);
  return `Analyzer exited ${code} signal ${signal}`;
}

export function routesForArtifact(artifact, facts = collectRouteFacts()) {
  return routesForTarget({
    path: artifact.path,
    kind: artifact.intake?.kind ?? null,
    facts,
  });
}

export function selectRoute(artifact, routeId, facts = collectRouteFacts()) {
  const routes = routesForArtifact(artifact, facts);
  if (routes.length === 0)
    throw studioError(
      "No engine route applies to this artifact. Nothing was started.",
      409,
    );
  const chosen = routeId ? routeById(routes, routeId) : bestReadyRoute(routes);
  if (!chosen)
    throw studioError("That route does not apply to this artifact.", 404);
  if (chosen.status !== "ready") {
    const listed = routes
      .map((route) => `${route.id}: ${route.status}`)
      .join("; ");
    throw studioError(
      `${chosen.label} is ${chosen.status}. ${chosen.detail} Applicable routes: ${listed}. Nothing was started.`,
      409,
    );
  }
  return chosen;
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
  routeId = null,
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
    const chosen = selectRoute(artifact, routeId);
    const runId = newId("run_");
    const runsDir = join(store.directory(projectId), "runs");
    const output = join(runsDir, runId);
    // JavaScript analysis refuses an output directory that already exists.
    // Other routes write engine.json here and do not create that directory.
    if (chosen.id === "javascript-static")
      mkdirSync(runsDir, { recursive: true });
    else mkdirSync(output, { recursive: true });
    const savedQuestion = question ?? project.question;
    const argv = commandArgv({
      id: chosen.id,
      target: artifact.path,
      output,
      question: savedQuestion,
    });
    const run = {
      id: runId,
      artifact_id: artifact.id,
      kind: chosen.id,
      route_id: chosen.id,
      provider: { id: chosen.provider },
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      output_dir: output,
      question: savedQuestion,
      authorization: "explicit-request",
      command: { argv, stdout_log_level: "silent" },
      evidence_id: null,
      summary: null,
      narrative: null,
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
        env: engineChildEnv(),
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
      if (stdout.length < 8_000_000) stdout += chunk.toString("utf8");
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
        if (chosen.id === "javascript-static")
          finishJavascript(
            store,
            projectId,
            runId,
            output,
            code,
            signal,
            stderr,
            reason,
          );
        else
          finishEngine(
            store,
            projectId,
            runId,
            output,
            stdout,
            stderr,
            code,
            signal,
            reason,
          );
      });
    });
    return store.read(projectId);
  });
}

function finishJavascript(
  store,
  projectId,
  runId,
  output,
  code,
  signal,
  stderr,
  reason,
) {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(join(output, "evidence.json"), "utf8"));
  } catch {
    parsed = null;
  }
  const summary = compactSummary(readSummary(output));
  const evidenceId = summary?.evidence_id ?? parsed?.evidence_id ?? null;
  const completed =
    reason === null &&
    code === 0 &&
    typeof evidenceId === "string" &&
    EVIDENCE_ID.test(evidenceId);
  const narrative = completed
    ? narrateJavascriptSummary(summary, evidenceId)
    : null;
  const errorText =
    reason === "timeout"
      ? "Timed out after 180000 ms."
      : (stderr || `Analyzer exited ${code} signal ${signal}`).slice(0, 2000);
  finishRun(store, projectId, runId, {
    status: completed
      ? "completed"
      : reason === "cancelled"
        ? "cancelled"
        : "failed",
    evidence_id: completed ? evidenceId : null,
    summary: completed ? summary : null,
    narrative,
    provider: completed ? (parsed?.provider ?? null) : null,
    error: completed ? null : errorText,
  });
}

function finishEngine(
  store,
  projectId,
  runId,
  output,
  stdout,
  stderr,
  code,
  signal,
  reason,
) {
  const parsed = parseEngineJson(stdout);
  if (stdout) writeFileSync(join(output, "engine.json"), stdout);
  const evidenceId =
    typeof parsed?.evidence_id === "string" &&
    EVIDENCE_ID.test(parsed.evidence_id)
      ? parsed.evidence_id
      : null;
  const completed = code === 0 && evidenceId !== null && reason === null;
  if (completed)
    writeFileSync(
      join(output, "evidence.json"),
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
  const narrative = completed ? narrateEvidence(parsed) : null;
  const status = completed
    ? "completed"
    : reason === "cancelled"
      ? "cancelled"
      : "failed";
  const errorText =
    reason === "timeout"
      ? "Timed out after 180000 ms."
      : engineErrorText(parsed, stderr, code, signal);
  finishRun(store, projectId, runId, {
    status,
    evidence_id: completed ? evidenceId : null,
    summary: completed
      ? {
          evidence_id: evidenceId,
          counts: null,
          limitations: narrative.limitations,
          unknowns: narrative.unknowns,
        }
      : null,
    narrative,
    provider: completed ? (parsed.provider ?? null) : null,
    error: completed ? null : errorText,
  });
}
