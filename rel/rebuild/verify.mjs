import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const VERIFY_SCHEMA = "ree.rebuild.verify.v1";

/**
 * Run the scaffold's declaration tests.
 * A pass means the feature id is declared. It is not a runtime behavior match.
 */
export function verifyRebuild(projectDir, execPath = process.execPath) {
  const spec = JSON.parse(
    readFileSync(join(projectDir, "behavior-spec.json"), "utf8"),
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST") || key === "NODE_CHANNEL_FD")
      delete env[key];
  }
  const child = spawnSync(
    execPath,
    ["--test", "--test-reporter=tap", "test/accounted.test.mjs"],
    { cwd: projectDir, encoding: "utf8", env },
  );
  const passed = new Set();
  const failed = new Set();
  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  for (const line of output.split("\n")) {
    const ok = /^ok \d+ - (.+)$/u.exec(line);
    const notOk = /^not ok \d+ - (.+)$/u.exec(line);
    if (ok) passed.add(ok[1]);
    if (notOk) failed.add(notOk[1]);
  }
  const features = spec.features.map((feature) => {
    const name = `accounted ${feature.id}`;
    let match = "not-run";
    if (passed.has(name) && !failed.has(name)) match = "accounted";
    else if (failed.has(name)) match = "missing";
    return {
      id: feature.id,
      name: feature.name,
      match,
      test_name: name,
      meaning:
        "accounted means the id is declared. It does not mean the feature runs.",
    };
  });
  const accounted = features.filter(
    (feature) => feature.match === "accounted",
  ).length;
  return {
    schema_version: VERIFY_SCHEMA,
    exit_code: child.status,
    signal: child.signal,
    features,
    accounted,
    missing: features.length - accounted,
    total: features.length,
    ratio: features.length === 0 ? null : accounted / features.length,
    quote_test_passed:
      child.status === 0 &&
      passed.has("scaffold source does not contain spec quotes"),
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}
