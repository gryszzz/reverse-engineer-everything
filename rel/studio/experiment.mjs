import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { repositoryRoot } from "./paths.mjs";

export const OWNED_FIXTURE = fileURLToPath(
  new URL("../../experiments/rel-first-lab/", import.meta.url),
);
const PROBE = fileURLToPath(
  new URL("./owned-fixture-probe.mjs", import.meta.url),
);
const QUERY = "bridge";

export const OWNED_HYPOTHESES = Object.freeze([
  {
    id: "title-weighted",
    statement:
      "Caller-declared prediction: title matches outrank tag matches for the owned notes search.",
    predictions: [
      { input: "bridge", outcome: ["N-102", "N-101", "N-104"] },
      { input: "signal", outcome: ["N-101", "N-105"] },
    ],
  },
  {
    id: "tag-first",
    statement:
      "Caller-declared competing prediction: a tag match is ordered ahead of title matches.",
    predictions: [
      { input: "bridge", outcome: ["N-104", "N-101", "N-102"] },
      { input: "signal", outcome: ["N-105", "N-101"] },
    ],
  },
]);

const ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USERPROFILE",
  "SystemRoot",
  "PATHEXT",
  "COMSPEC",
];

export function allowlistedEnv() {
  const env = {};
  for (const key of ENV_KEYS) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  return env;
}

function stable(value) {
  if (Array.isArray(value))
    return `[${value.map((item) => stable(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestValue(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function ownedFixturePlan() {
  const argv = [
    process.execPath,
    PROBE,
    "--fixture",
    OWNED_FIXTURE,
    "--query",
    QUERY,
  ];
  const hashed = {
    probe: fileHash(PROBE),
    search: fileHash(join(OWNED_FIXTURE, "search.mjs")),
    notes: fileHash(join(OWNED_FIXTURE, "notes.mjs")),
  };
  const command = {
    argv,
    cwd: repositoryRoot,
    timeout_ms: 5000,
    max_stdout_bytes: 65536,
    query: QUERY,
    hypotheses: OWNED_HYPOTHESES,
    files: hashed,
  };
  return {
    ...command,
    plan_digest: digestValue(command),
  };
}

export function plannerRequest() {
  return {
    hypotheses: OWNED_HYPOTHESES.map(({ id, predictions }) => ({
      id,
      predictions,
    })),
    observations: [],
    candidate_inputs: ["bridge", "signal"],
  };
}

export function launchPlanner() {
  const runtime = join(repositoryRoot, "dist/cli-runtime/cli.js");
  if (!existsSync(runtime))
    return Promise.resolve({
      status: "unavailable",
      reason:
        "Built REA runtime missing. The planner was not run. npm ci && npm run build:cached builds it.",
    });
  const request = plannerRequest();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        join(repositoryRoot, "scripts/rea.mjs"),
        "discriminate-finite-hypotheses",
        JSON.stringify(request),
        "--json",
      ],
      {
        cwd: repositoryRoot,
        env: allowlistedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 200000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          status: "failed",
          exit_code: code,
          signal,
          stderr: stderr.slice(0, 2000),
          request,
        });
        return;
      }
      try {
        resolve({
          status: "completed",
          result: JSON.parse(stdout),
          request,
        });
      } catch {
        resolve({
          status: "failed",
          reason: "Planner stdout was not JSON.",
          request,
        });
      }
    });
  });
}

export function compareObservation(ids) {
  return OWNED_HYPOTHESES.map((hypothesis) => {
    const prediction = hypothesis.predictions.find(
      (item) => item.input === QUERY,
    );
    const expected = prediction?.outcome ?? null;
    return {
      hypothesis_id: hypothesis.id,
      statement: hypothesis.statement,
      expected,
      observed: ids,
      matches: JSON.stringify(expected) === JSON.stringify(ids),
    };
  });
}

export function launchOwnedProbe(plan) {
  const child = spawn(plan.argv[0], plan.argv.slice(1), {
    cwd: plan.cwd,
    env: allowlistedEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let truncated = false;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (stdout.length < plan.max_stdout_bytes)
      stdout += text.slice(0, plan.max_stdout_bytes - stdout.length);
    if (stdout.length >= plan.max_stdout_bytes) {
      truncated = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8000)
      stderr += chunk.toString("utf8").slice(0, 8000 - stderr.length);
  });
  const timer = setTimeout(() => {
    truncated = true;
    child.kill("SIGKILL");
  }, plan.timeout_ms);
  const done = new Promise((resolve) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: error.message,
        truncated,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, truncated });
    });
  });
  return {
    cancel: () => child.kill("SIGTERM"),
    done,
  };
}

export function observationFromProbe(result) {
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  const ids = Array.isArray(parsed?.ids)
    ? parsed.ids.filter((id) => typeof id === "string")
    : null;
  const ok =
    result.code === 0 &&
    !result.truncated &&
    parsed?.query === QUERY &&
    Array.isArray(ids);
  return {
    status: ok ? "completed" : "failed",
    exit_code: result.code,
    signal: result.signal,
    truncated: result.truncated,
    stderr: result.stderr.slice(0, 2000),
    observation: ok
      ? {
          query: parsed.query,
          ids,
          source: parsed.source ?? null,
          kind: "runtime-capture",
        }
      : null,
    comparison: ok ? compareObservation(ids) : [],
    separation:
      "This runtime capture is stored on the experiment record. It is not written into static evidence.json and it is not given an REA Evidence ID.",
    engine_reassessment: "not-run",
    engine_reassessment_reason:
      "discriminate-finite-hypotheses requires REA Evidence IDs on observations. This probe does not mint those IDs, so the capture is not sent back to the planner.",
  };
}
