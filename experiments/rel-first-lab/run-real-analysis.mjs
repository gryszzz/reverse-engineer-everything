import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { markdownReport } from "./report.mjs";
import { runStaticAnalysis } from "../../rel/analyze-static.mjs";

// Run from the repository checkout and keep every generated file outside Git.
const repository = fileURLToPath(new URL("../../", import.meta.url));
const lab = fileURLToPath(new URL("./", import.meta.url));
let output;
const run = (args, filename, timeout) => {
  const out = openSync(join(output, filename), "wx");
  const err = openSync(join(output, `${filename}.stderr.txt`), "wx");
  const started = performance.now();
  let result;
  try {
    result = spawnSync(process.execPath, args, {
      cwd: repository,
      stdio: ["ignore", out, err],
      timeout,
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const elapsedMs = Math.round(performance.now() - started);
  if (result.error || result.status !== 0) {
    throw new Error(
      `${filename} failed (status=${result.status}, signal=${result.signal ?? "none"}, duration=${elapsedMs}ms): ${result.error?.message ?? "see stderr artifact"}`,
    );
  }
  return elapsedMs;
};
try {
  const analysis = runStaticAnalysis({
    target: lab,
    out: process.argv[2],
    authorized: true,
    question:
      "Which static relationships explain the source-owned search demo?",
  });
  output = analysis.output;
  const summary = JSON.parse(
    readFileSync(join(output, "summary.json"), "utf8"),
  );
  const verifyMs = run(
    [join(lab, "verify.mjs")],
    "lab-verification.txt",
    15000,
  );
  const cliMs = run(
    [join(lab, "cli.mjs"), "bridge"],
    "observed-search.txt",
    15000,
  );
  writeFileSync(
    join(output, "summary.json"),
    JSON.stringify(
      {
        ...summary,
        durations_ms: {
          sample_verify: verifyMs,
          sample_cli: cliMs,
          rea_static_analysis: summary.timing_ms.analyze_and_project,
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(output, "REE_EVIDENCE_REPORT.md"),
    markdownReport(summary),
  );
  console.log(
    `REE REAL ANALYZER VERIFIED: ${summary.counts.nodes} graph nodes, ${summary.counts.edges} edges; Evidence ${summary.evidence_id}`,
  );
  console.log(`Local output: ${output}`);
} catch (error) {
  console.error(`REE analysis incomplete: ${error.message}`);
  process.exitCode = 1;
}
