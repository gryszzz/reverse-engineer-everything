import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const VERIFY_SCHEMA = "ree.rebuild.verify.v1";

const MEANING = {
  pass: "The route test passed. This feature runs in the generated server.",
  unimplemented:
    "No built HTTP route matches this feature. The test checks the registry and does not claim the feature runs.",
  fail: "The route test failed.",
  "not-run": "The feature test did not run.",
};

export function readGeneratedArray(source, exportName) {
  const marker = `export const ${exportName} = `;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing export ${exportName}.`);
  const jsonStart = start + marker.length;
  if (source[jsonStart] !== "[")
    throw new Error(`Export ${exportName} is not an array.`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = jsonStart; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(jsonStart, index + 1));
    }
  }
  throw new Error(`Unclosed export ${exportName}.`);
}

function generatedTables(projectDir) {
  try {
    const behaviors = readGeneratedArray(
      readFileSync(join(projectDir, "src/behaviors.mjs"), "utf8"),
      "behaviors",
    );
    const routes = readGeneratedArray(
      readFileSync(join(projectDir, "src/routes.mjs"), "utf8"),
      "routes",
    );
    return { behaviors, routes };
  } catch {
    return { behaviors: [], routes: [] };
  }
}

function testEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST") || key === "NODE_CHANNEL_FD")
      delete env[key];
  }
  return env;
}

function tapName(line) {
  const ok = /^ok \d+ - (.*)$/u.exec(line.trim());
  const notOk = /^not ok \d+ - (.*)$/u.exec(line.trim());
  if (ok) return { match: "pass", name: ok[1].replace(/ # .*$/u, "") };
  if (notOk) return { match: "fail", name: notOk[1].replace(/ # .*$/u, "") };
  return null;
}

function classifyOutput(projectDir, output, status, signal, stdout, stderr) {
  const spec = JSON.parse(
    readFileSync(join(projectDir, "behavior-spec.json"), "utf8"),
  );
  const { behaviors, routes } = generatedTables(projectDir);
  const passed = new Set();
  const failed = new Set();
  for (const line of output.split("\n")) {
    const tap = tapName(line);
    if (tap?.match === "pass") passed.add(tap.name);
    if (tap?.match === "fail") failed.add(tap.name);
  }
  const features = spec.features.map((feature) => {
    const running = `feature ${feature.id}`;
    const absent = `unimplemented ${feature.id}`;
    let match = "not-run";
    if (failed.has(running) || failed.has(absent)) match = "fail";
    else if (passed.has(running)) match = "pass";
    else if (passed.has(absent)) match = "unimplemented";
    const behavior = behaviors.find((item) => item.id === feature.id);
    const route = behavior?.handler
      ? (routes.find((item) => item.key === behavior.handler) ?? null)
      : null;
    return {
      id: feature.id,
      name: feature.name,
      match,
      test_name: match === "pass" ? running : absent,
      route: route
        ? {
            method: route.method,
            path: route.path,
            success_status: route.success_status,
          }
        : null,
      meaning: MEANING[match],
    };
  });
  const implemented = features.filter(
    (feature) => feature.match === "pass",
  ).length;
  const unimplemented = features.filter(
    (feature) => feature.match === "unimplemented",
  ).length;
  const failedCount = features.filter(
    (feature) => feature.match === "fail",
  ).length;
  const notRun = features.filter(
    (feature) => feature.match === "not-run",
  ).length;
  return {
    schema_version: VERIFY_SCHEMA,
    exit_code: status,
    signal,
    features,
    implemented,
    unimplemented,
    failed: failedCount,
    not_run: notRun,
    total: features.length,
    ratio: features.length === 0 ? null : implemented / features.length,
    quote_test_passed:
      status === 0 && passed.has("source does not contain spec quotes"),
    stdout: stdout ?? "",
    stderr: stderr ?? "",
  };
}

/**
 * Run the product tests.
 * pass means an HTTP route test passed.
 * unimplemented means the feature was not built.
 * fail means a test failed.
 */
export function verifyRebuild(projectDir, execPath = process.execPath) {
  const child = spawnSync(
    execPath,
    ["--test", "--test-reporter=tap", "test/product.test.mjs"],
    { cwd: projectDir, encoding: "utf8", env: testEnv() },
  );
  return classifyOutput(
    projectDir,
    `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
    child.status,
    child.signal,
    child.stdout,
    child.stderr,
  );
}

/**
 * Same verdict as verifyRebuild. Each TAP ok / not ok line is reported as it arrives.
 */
export function verifyRebuildLive(
  projectDir,
  { onEvent, execPath = process.execPath } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      execPath,
      ["--test", "--test-reporter=tap", "test/product.test.mjs"],
      { cwd: projectDir, env: testEnv() },
    );
    let stdout = "";
    let stderr = "";
    const pending = { stdout: "", stderr: "" };
    const take = (chunk, into) => {
      const text = chunk.toString("utf8");
      if (into === "stdout") stdout += text;
      else stderr += text;
      pending[into] += text;
      let newline = pending[into].indexOf("\n");
      while (newline >= 0) {
        const line = pending[into].slice(0, newline);
        pending[into] = pending[into].slice(newline + 1);
        newline = pending[into].indexOf("\n");
        const tap = tapName(line);
        if (!tap || typeof onEvent !== "function") continue;
        onEvent({
          source: "verify",
          phase: "test",
          match: tap.match,
          test_name: tap.name,
          message:
            tap.match === "pass"
              ? `Test passed: ${tap.name}`
              : `Test failed: ${tap.name}`,
        });
      }
    };
    child.stdout.on("data", (chunk) => take(chunk, "stdout"));
    child.stderr.on("data", (chunk) => take(chunk, "stderr"));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve(
        classifyOutput(
          projectDir,
          `${stdout}\n${stderr}`,
          status,
          signal,
          stdout,
          stderr,
        ),
      );
    });
  });
}
