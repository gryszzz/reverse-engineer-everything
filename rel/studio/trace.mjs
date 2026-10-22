import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OWNED_FIXTURE } from "./experiment.mjs";
import { repositoryRoot } from "./paths.mjs";

const NOT_RECORDED =
  "This process-capture contract records terminal frames, process samples, and filesystem checkpoints. It has no network or IPC event collection.";

export function traceRuntimeReady(root = repositoryRoot) {
  return existsSync(join(root, "dist/cli-runtime/cli.js"));
}

/** Fixed scenario for the owned JavaScript lab. No caller path is accepted. */
export function ownedTraceScenario() {
  const cli = join(OWNED_FIXTURE, "cli.mjs");
  return {
    executable: process.execPath,
    arguments: [cli, "bridge"],
    working_directory: OWNED_FIXTURE,
    filesystem_observation_paths: [OWNED_FIXTURE],
    timeout_ms: 8000,
  };
}

export function ownedTraceArgv(scenarioPath, root = repositoryRoot) {
  return [
    process.execPath,
    join(root, "scripts/rea.mjs"),
    "capture-process",
    scenarioPath,
    "--json",
  ];
}

function baseName(filePath) {
  const parts = String(filePath).split(/[/\\]/u);
  return parts.at(-1) ?? filePath;
}

/**
 * Project a capture Evidence document into a trace view.
 * Dynamic observations stay labeled as process capture, not static Evidence edges.
 */
export function projectProcessCapture(capture, staticLabels = []) {
  if (!capture || typeof capture !== "object")
    return {
      status: "unavailable",
      separate_from_static_evidence: true,
      reason: "No capture record was produced.",
    };
  const body =
    capture.normalized_result && typeof capture.normalized_result === "object"
      ? capture.normalized_result
      : capture;
  const effects = Array.isArray(body.filesystem_effects)
    ? body.filesystem_effects
        .filter((effect) => effect && typeof effect.path === "string")
        .slice(0, 80)
        .map((effect) => ({
          path: effect.path,
          status: typeof effect.status === "string" ? effect.status : "unknown",
          source: "process-capture-filesystem-effect",
        }))
    : null;
  const labels = new Set(
    staticLabels.filter((label) => typeof label === "string" && label !== ""),
  );
  const correlated = [];
  for (const effect of effects ?? []) {
    const name = baseName(effect.path);
    const match = labels.has(effect.path)
      ? effect.path
      : labels.has(name)
        ? name
        : null;
    if (!match) continue;
    correlated.push({
      path: effect.path,
      static_label: match,
      relation: "same-path",
      note: "The path appears in the static record and in a filesystem checkpoint. This does not show that the module ran.",
    });
  }
  const residuals = Array.isArray(body.residual_unknowns)
    ? body.residual_unknowns
    : [];
  const network = residuals.find((item) => item?.scope === "network");
  return {
    status: "recorded",
    separate_from_static_evidence: true,
    evidence_id:
      typeof capture.evidence_id === "string" ? capture.evidence_id : null,
    operation: typeof capture.operation === "string" ? capture.operation : null,
    terminal: {
      frames: Array.isArray(body.frames) ? body.frames.length : null,
      note: "Frame count is the capture's terminal collection. Frame text is not copied into the static graph.",
    },
    filesystem: effects
      ? {
          status: "checkpoint-effects",
          note: "Before/after effects for the selected observation paths. This is not a complete stream of file reads.",
          effects,
          omitted: Math.max(
            0,
            (body.filesystem_effects?.length ?? effects.length) -
              effects.length,
          ),
        }
      : {
          status: "unknown",
          reason: "The capture has no filesystem_effects field.",
        },
    network: {
      status: "not-recorded",
      reason:
        typeof network?.reason === "string" ? network.reason : NOT_RECORDED,
    },
    ipc: {
      status: "not-recorded",
      reason: NOT_RECORDED,
    },
    correlated,
  };
}

export function spawnOwnedTrace(scenarioPath, env) {
  return spawn(process.execPath, ownedTraceArgv(scenarioPath).slice(1), {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
