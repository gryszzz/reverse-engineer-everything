import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitHandoff } from "../handoff/emit.mjs";
import { runProductPipeline } from "../pipeline/run.mjs";
import {
  ingestScout,
  ingestSpec,
  listOpportunities,
} from "../opportunities/board.mjs";
import { scaffoldRebuild } from "../rebuild/scaffold.mjs";
import { verifyRebuild } from "../rebuild/verify.mjs";
import { studioError } from "./errors.mjs";

const BOX_SHARED = "/home/box/shared";
const OWNED_WEB = fileURLToPath(
  new URL("../../experiments/ree-bench/web/", import.meta.url),
);

export function opportunityDirectory(root) {
  return join(root, "opportunities");
}

export function readOpportunityBoard(root) {
  return listOpportunities(opportunityDirectory(root));
}

export function ingestOpportunity(root, value) {
  if (!value || typeof value !== "object")
    throw studioError("The board ingest body must be a JSON object.", 400);
  const directory = opportunityDirectory(root);
  if (value.schema_version === "ree.outside-in.behavior-spec.v1")
    ingestSpec(directory, value);
  else ingestScout(directory, value);
  return listOpportunities(directory);
}

function slug(name) {
  const value = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return value || "rebuild";
}

/** Build HTTP features that name an endpoint, run their tests, and write a dry-run handoff. */
export function createBuild(root, body) {
  const productName = body?.product_name;
  const spec = body?.spec;
  if (!spec || typeof spec !== "object")
    throw studioError("Build requires a behavior spec object.", 400);
  const outDir = join(root, "builds", slug(productName));
  let built;
  try {
    built = scaffoldRebuild({ spec, productName, outDir });
  } catch (error) {
    throw studioError(
      error instanceof Error ? error.message : "Rebuild failed.",
      400,
    );
  }
  const verify = verifyRebuild(outDir);
  const onBox = existsSync(BOX_SHARED);
  let handoffDir = null;
  let handoffError = null;
  try {
    const emitted = emitHandoff({
      projectDir: outDir,
      verify,
      scout: body.scout ?? null,
      blastDir: onBox ? null : join(root, "blasts"),
    });
    handoffDir = emitted.directory;
  } catch (error) {
    handoffError = error instanceof Error ? error.message : "Handoff failed.";
  }
  return {
    build_id: built.build_id,
    out_dir: outDir,
    feature_count: built.feature_count,
    dry_run: true,
    handoff_dir: handoffDir,
    handoff_error: handoffError,
    box_path_used: onBox,
    verify: {
      schema_version: verify.schema_version,
      exit_code: verify.exit_code,
      implemented: verify.implemented,
      unimplemented: verify.unimplemented,
      failed: verify.failed,
      not_run: verify.not_run,
      total: verify.total,
      ratio: verify.ratio,
      features: verify.features,
      quote_test_passed: verify.quote_test_passed,
    },
  };
}

/** Start the owned web fixture pipeline and return before the stages finish. */
export function startOwnedPipeline(root, body) {
  if (body?.fixture !== "web")
    throw studioError(
      "The studio pipeline runs only the owned web fixture.",
      400,
    );
  const productName =
    typeof body.product_name === "string" && body.product_name.trim()
      ? body.product_name.trim()
      : "Board Desk";
  const runId = "run_" + randomBytes(8).toString("hex");
  const outDir = join(root, "pipelines", runId);
  const pending = runProductPipeline({
    target: OWNED_WEB,
    outDir,
    productName,
    runId,
    pace: () => new Promise((resolvePace) => setTimeout(resolvePace, 20)),
  });
  pending.catch((error) => {
    const path = join(outDir, "run.json");
    if (existsSync(path)) return;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: "ree.pipeline.run.v1",
        run_id: runId,
        finished: true,
        code: 2,
        message: error instanceof Error ? error.message : "Pipeline failed.",
        stages: [],
        dry_run: true,
        notified_blast: false,
        guard_sign_off: "not-submitted",
        approved_for_vault_copy: false,
      }) + "\n",
    );
  });
  return { run_id: runId, status: "running" };
}

export function readPipelineRun(root, runId) {
  if (!/^run_[a-f0-9]{16}$/u.test(runId))
    throw studioError("Unknown pipeline run.", 404);
  const path = join(root, "pipelines", runId, "run.json");
  if (!existsSync(path)) throw studioError("Pipeline run not found.", 404);
  return JSON.parse(readFileSync(path, "utf8"));
}
