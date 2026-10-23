import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeOutsideIn } from "../outside-in/analyze.mjs";
import { coverageDecision, formatCoverageReport } from "./coverage.mjs";
import { scaffoldRebuild } from "./scaffold.mjs";
import { verifyRebuild } from "./verify.mjs";

export const DESK_FIXTURE = fileURLToPath(
  new URL("../../experiments/ree-bench/desk/", import.meta.url),
);

/**
 * Rebuild the owned desk fixture and measure behavior-test coverage.
 * The caller removes `work` when it is finished with the product.
 */
export async function measureDeskCoverage() {
  const work = mkdtempSync(join(tmpdir(), "ree-coverage-"));
  const request = JSON.parse(
    readFileSync(join(DESK_FIXTURE, "request.json"), "utf8"),
  );
  const result = await analyzeOutsideIn({
    ...request,
    fixtureDir: DESK_FIXTURE,
    outDir: join(work, "analysis"),
    now: () => new Date("2026-10-23T00:00:00.000Z"),
  });
  if (result.exitCode !== 0)
    throw new Error("Outside-in refused the desk fixture.");
  const product = join(work, "product");
  scaffoldRebuild({
    spec: result.spec,
    productName: "Desk Kit",
    outDir: product,
    now: new Date("2026-10-23T00:00:00.000Z"),
    pack: false,
  });
  const verify = verifyRebuild(product);
  const planned = JSON.parse(
    readFileSync(join(product, "coverage.json"), "utf8"),
  );
  return {
    work,
    product,
    spec: result.spec,
    verify,
    decision: coverageDecision(verify, planned),
  };
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(
    entry && import.meta.url === pathToFileURL(resolve(entry)).href,
  );
}

if (isMain()) {
  const measured = await measureDeskCoverage();
  console.log(formatCoverageReport(measured.decision));
  const failed = measured.verify.exit_code !== 0 || !measured.decision.passed;
  rmSync(measured.work, { recursive: true, force: true });
  if (failed) process.exit(1);
}
