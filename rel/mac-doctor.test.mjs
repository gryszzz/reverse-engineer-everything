import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assessMacHost,
  diagnoseMac,
  formatMacDiagnosis,
  supportedNode,
} from "./mac-doctor.mjs";

const fixture = (overrides = {}) => ({
  platform: "darwin",
  architecture: "arm64",
  nodeArchitecture: "arm64",
  rosetta: "no",
  cpuThreads: 8,
  totalMemoryGiB: 8,
  freeMemoryGiB: 4,
  diskFreeGiB: 18,
  nodeVersion: "24.18.0",
  pinnedNode: "24.18.0",
  dependenciesPresent: true,
  runtimeBuilt: true,
  mcpBuilt: true,
  projectConfig: true,
  tools: { codex: true },
  ...overrides,
});

test("uses real REA Node engine support boundaries", () => {
  for (const v of ["22.19.0", "24.11.0", "24.18.0", "26.0.0", "28.4.1"])
    assert.equal(supportedNode(v), true, v);
  for (const v of ["22.16.0", "23.1.0", "24.10.0", "25.1.0", "abc"])
    assert.equal(supportedNode(v), false, v);
});

test("Apple Silicon and Intel Macs receive accurate architecture explanations", () => {
  const m = assessMacHost(fixture());
  assert.equal(m.host.architecture, "arm64");
  assert.equal(m.host.rosetta, "no");
  assert.equal(m.capabilities.visualLab, true);
  assert.match(m.guidance.join(" "), /Low-memory profile/);
  const intel = assessMacHost(
    fixture({
      architecture: "x64",
      nodeArchitecture: "x64",
      rosetta: "unknown",
      totalMemoryGiB: 16,
    }),
  );
  assert.equal(intel.host.architecture, "x64");
  assert.equal(intel.host.rosetta, "unknown");
  assert.doesNotMatch(intel.guidance.join(" "), /Rosetta/);
});

test("Rosetta, low disk space and missing dependencies are actionable, not concealed", () => {
  const r = assessMacHost(
    fixture({
      nodeArchitecture: "x64",
      rosetta: "yes",
      diskFreeGiB: 4,
      nodeVersion: "24.10.0",
      runtimeBuilt: false,
      mcpBuilt: false,
      dependenciesPresent: false,
      tools: {},
    }),
  );
  assert.equal(r.node.supported, false);
  assert.equal(r.capabilities.visualLab, true);
  assert.match(r.guidance.join(" "), /Rosetta/);
  assert.match(r.guidance.join(" "), /10 GiB/);
  assert.match(r.guidance.join(" "), /npm ci/);
  assert.match(
    formatMacDiagnosis(r),
    /No system configuration or software was changed/,
  );
});

test("non-Mac CI still runs diagnosis without pretending to be a Mac", () => {
  const r = assessMacHost(
    fixture({ platform: "linux", rosetta: "not-applicable" }),
  );
  assert.equal(r.host.platform, "linux");
  assert.equal(r.host.rosetta, "not-applicable");
  assert.match(r.guidance.join(" "), /tuned for macOS/);
});

test("actual doctor CLI is read-only, machine-readable and rejects analysis flags", () => {
  const root = fileURLToPath(new URL("../ree.mjs", import.meta.url));
  const raw = execFileSync(process.execPath, [root, "doctor", "--json"], {
    encoding: "utf8",
  });
  const result = JSON.parse(raw);
  assert.equal(result.profile, "macos-first-read-only");
  assert.equal(result.node.current, process.versions.node);
  assert.equal(result.capabilities.projectCodexConfig, true);
  assert.match(formatMacDiagnosis(diagnoseMac()), /REE \/ Mac readiness check/);
  assert.throws(
    () =>
      execFileSync(process.execPath, [root, "doctor", "--run"], {
        stdio: "pipe",
      }),
    /Use doctor/,
  );
});
