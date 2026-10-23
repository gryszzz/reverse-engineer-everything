import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectGaps } from "../gaps/report.mjs";
import {
  collectImprovements,
  publicImprovements,
  specWithImprovements,
} from "../improve/collect.mjs";
import { emitHandoff } from "../handoff/emit.mjs";
import { runProductPipeline } from "../pipeline/run.mjs";
import {
  ingestScout,
  ingestSpec,
  listOpportunities,
  listPicks,
} from "../opportunities/board.mjs";
import {
  configuredSharedDir,
  readSharedPicks,
} from "../opportunities/shared.mjs";
import { packageRebuild, scaffoldRebuild } from "../rebuild/scaffold.mjs";
import { verifyRebuild, verifyRebuildLive } from "../rebuild/verify.mjs";
import { studioError } from "./errors.mjs";
import { draftSpecFromEvidence, specWithFeatures } from "./from-findings.mjs";

const BOX_SHARED = "/home/box/shared";
const OWNED_WEB = fileURLToPath(
  new URL("../../experiments/ree-bench/web/", import.meta.url),
);

export function opportunityDirectory(root) {
  return join(root, "opportunities");
}

function collectPicks(root) {
  const picks = [];
  const seen = new Set();
  const add = (directory) => {
    for (const pick of listPicks(directory)) {
      if (seen.has(pick.id)) continue;
      seen.add(pick.id);
      picks.push(pick);
    }
  };
  const pipelines = join(root, "pipelines");
  if (existsSync(pipelines)) {
    for (const name of readdirSync(pipelines)) {
      const directory = join(pipelines, name);
      if (statSync(directory).isDirectory()) add(directory);
    }
  }
  add(opportunityDirectory(root));
  picks.sort(
    (left, right) =>
      String(left.name ?? "").localeCompare(String(right.name ?? "")) ||
      left.id.localeCompare(right.id),
  );
  return picks;
}

function attachAgentPicks(items, byId) {
  return items.map((item) => ({
    ...item,
    agent_picks: byId.get(item.id) ?? [],
  }));
}

export function readOpportunityBoard(root, options = {}) {
  const listed = listOpportunities(opportunityDirectory(root));
  const sharedDir = configuredSharedDir(options.sharedDir);
  const shared = sharedDir
    ? readSharedPicks(sharedDir)
    : { picks: [], rejected: [] };
  const byId = new Map();
  for (const pick of shared.picks) {
    const list = byId.get(pick.id) ?? [];
    list.push(pick);
    byId.set(pick.id, list);
  }
  const scout = attachAgentPicks(listed.scout, byId);
  const specs = attachAgentPicks(listed.specs, byId);
  const known = new Set([...scout, ...specs].map((item) => item.id));
  return {
    schema_version: listed.schema_version,
    scout,
    specs,
    picks: collectPicks(root),
    agent_picks: shared.picks,
    agent_pick_errors: shared.rejected,
    unmatched_agent_picks: shared.picks.filter((pick) => !known.has(pick.id)),
  };
}

export function ingestOpportunity(root, value) {
  if (!value || typeof value !== "object")
    throw studioError("The board ingest body must be a JSON object.", 400);
  const directory = opportunityDirectory(root);
  if (value.schema_version === "ree.outside-in.behavior-spec.v1")
    ingestSpec(directory, value);
  else ingestScout(directory, value);
  return readOpportunityBoard(root);
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
  const improvements = improvementsFor(spec, body?.improve_board);
  let built;
  try {
    built = scaffoldRebuild({
      spec: specWithImprovements(spec, improvements),
      productName,
      outDir,
      improvements,
    });
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
    gaps: collectGaps({
      projectDir: outDir,
      forbidden: [spec?.target?.name].filter(Boolean),
    }),
    improvements: publicImprovements(
      improvements,
      [spec?.target?.name].filter(Boolean),
    ),
  };
}

function improvementsFor(spec, improveBoard) {
  const target = spec?.target;
  return collectImprovements({
    boxBoard: improveBoard === undefined ? undefined : improveBoard,
    target:
      target && typeof target.name === "string"
        ? {
            name: target.name,
            urls: Array.isArray(target.urls) ? target.urls : [],
            category:
              typeof target.category === "string" ? target.category : null,
          }
        : null,
  });
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

const LIVE_SCHEMA = "ree.studio.live-build.v1";
const LIVE_ID = /^live_[a-f0-9]{16}$/u;

function liveDirectory(root, liveId) {
  return join(root, "live-builds", liveId);
}

function writeLiveStatus(directory, status) {
  const path = join(directory, "status.json");
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(status)}\n`);
  renameSync(temporary, path);
}

function readLiveStatus(root, liveId) {
  if (!LIVE_ID.test(liveId)) throw studioError("Unknown live build.", 404);
  const path = join(liveDirectory(root, liveId), "status.json");
  if (!existsSync(path)) throw studioError("Live build not found.", 404);
  return JSON.parse(readFileSync(path, "utf8"));
}

function publicVerify(verify) {
  if (!verify) return null;
  return {
    schema_version: verify.schema_version,
    exit_code: verify.exit_code,
    signal: verify.signal,
    implemented: verify.implemented,
    unimplemented: verify.unimplemented,
    failed: verify.failed,
    not_run: verify.not_run,
    total: verify.total,
    ratio: verify.ratio,
    features: verify.features,
    quote_test_passed: verify.quote_test_passed,
  };
}

/**
 * Write product files, then run tests, without blocking the HTTP response.
 * The tarball is a later package step.
 */
export function startLiveBuild(root, body) {
  const productName = body?.product_name;
  if (typeof productName !== "string" || !productName.trim())
    throw studioError("A product name is required.", 400);
  let spec = body?.spec ?? null;
  if (body?.record) {
    try {
      spec = draftSpecFromEvidence(body.record, {
        evidencePath: body.evidence_path,
      }).spec;
    } catch (error) {
      throw studioError(
        error instanceof Error ? error.message : "Could not draft a spec.",
        400,
      );
    }
  }
  if (!spec || typeof spec !== "object")
    throw studioError("Build requires a behavior spec or Evidence.", 400);
  if (Array.isArray(body?.feature_ids)) {
    try {
      spec = specWithFeatures(spec, body.feature_ids);
    } catch (error) {
      throw studioError(
        error instanceof Error ? error.message : "Feature selection failed.",
        400,
      );
    }
  }
  const liveId = "live_" + randomBytes(8).toString("hex");
  const directory = liveDirectory(root, liveId);
  const outDir = join(directory, "product");
  mkdirSync(directory, { recursive: true });
  const status = {
    schema_version: LIVE_SCHEMA,
    live_id: liveId,
    status: "running",
    finished: false,
    product_name: productName.trim(),
    out_dir: outDir,
    build_id: null,
    events: [],
    verify: null,
    package_path: null,
    package_ready: false,
    handoff_dir: null,
    handoff_error: null,
    dry_run: true,
    error: null,
  };
  writeLiveStatus(directory, status);
  const push = (event) => {
    status.events.push({ ...event, at: new Date().toISOString() });
    if (status.events.length > 200) status.events.shift();
    writeLiveStatus(directory, status);
  };
  setImmediate(() => {
    void (async () => {
      try {
        const improvements = improvementsFor(spec, body?.improve_board);
        const merged = specWithImprovements(spec, improvements);
        const built = scaffoldRebuild({
          spec: merged,
          productName,
          outDir,
          pack: false,
          onEvent: push,
          improvements,
        });
        status.build_id = built.build_id;
        writeLiveStatus(directory, status);
        const verify = await verifyRebuildLive(outDir, { onEvent: push });
        status.verify = publicVerify(verify);
        status.gaps = collectGaps({
          projectDir: outDir,
          forbidden: [spec?.target?.name].filter(Boolean),
        });
        status.improvements = publicImprovements(
          improvements,
          [spec?.target?.name].filter(Boolean),
        );
        status.finished = true;
        status.package_ready = verify.exit_code === 0 && verify.failed === 0;
        status.status = status.package_ready ? "verified" : "failed";
        if (!status.package_ready)
          status.error =
            verify.failed > 0
              ? "A route test failed, so the product was not offered for packaging."
              : `Product tests exited ${verify.exit_code}.`;
        writeLiveStatus(directory, status);
      } catch (error) {
        status.finished = true;
        status.status = "failed";
        status.package_ready = false;
        status.error =
          error instanceof Error ? error.message : "Live build failed.";
        writeLiveStatus(directory, status);
      }
    })();
  });
  return { live_id: liveId, status: "running" };
}

export function readLiveBuild(root, liveId) {
  return readLiveStatus(root, liveId);
}

/** Write product.tgz and the dry-run handoff after tests have finished. */
export function packageLiveBuild(root, liveId) {
  const status = readLiveStatus(root, liveId);
  if (!status.finished) throw studioError("Tests are still running.", 409);
  if (!status.package_ready)
    throw studioError(
      status.error || "This build is not ready to package.",
      409,
    );
  if (status.package_path) return status;
  const packagePath = packageRebuild(status.out_dir);
  const onBox = existsSync(BOX_SHARED);
  let handoffDir = null;
  let handoffError = null;
  try {
    const emitted = emitHandoff({
      projectDir: status.out_dir,
      verify: status.verify,
      scout: null,
      blastDir: onBox ? null : join(root, "blasts"),
    });
    handoffDir = emitted.directory;
  } catch (error) {
    handoffError = error instanceof Error ? error.message : "Handoff failed.";
  }
  const next = {
    ...status,
    status: "packaged",
    package_path: packagePath,
    handoff_dir: handoffDir,
    handoff_error: handoffError,
    dry_run: true,
  };
  writeLiveStatus(liveDirectory(root, liveId), next);
  return next;
}

export function readPipelineRun(root, runId) {
  if (!/^run_[a-f0-9]{16}$/u.test(runId))
    throw studioError("Unknown pipeline run.", 404);
  const path = join(root, "pipelines", runId, "run.json");
  if (!existsSync(path)) throw studioError("Pipeline run not found.", 404);
  return JSON.parse(readFileSync(path, "utf8"));
}
