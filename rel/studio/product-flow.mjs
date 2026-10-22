import { existsSync } from "node:fs";
import { join } from "node:path";
import { emitHandoff } from "../handoff/emit.mjs";
import {
  ingestScout,
  ingestSpec,
  listOpportunities,
} from "../opportunities/board.mjs";
import { scaffoldRebuild } from "../rebuild/scaffold.mjs";
import { verifyRebuild } from "../rebuild/verify.mjs";
import { studioError } from "./errors.mjs";

const BOX_SHARED = "/home/box/shared";

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

/** Scaffold, run declaration tests, and write a dry-run handoff. */
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
      accounted: verify.accounted,
      missing: verify.missing,
      total: verify.total,
      ratio: verify.ratio,
      features: verify.features,
      quote_test_passed: verify.quote_test_passed,
    },
  };
}
