import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { planStaticAnalysis, runStaticAnalysis } from "../analyze-static.mjs";
import {
  blastDirectory,
  BOX_SHARED,
  buildGuardSubmission,
  emitHandoff,
} from "../handoff/emit.mjs";
import {
  publishSharedPipeline,
  resolveSharedBoardDir,
} from "../handoff/shared-publish.mjs";
import { ingestSpec, postPipelineBoard } from "../opportunities/board.mjs";
import { analyzeOutsideIn } from "../outside-in/analyze.mjs";
import { SCHEMA_VERSION } from "../outside-in/constants.mjs";
import { assertValidBehaviorSpec } from "../outside-in/validate.mjs";
import { planProduct, scaffoldRebuild } from "../rebuild/scaffold.mjs";
import { verifyRebuild } from "../rebuild/verify.mjs";

const RUN_SCHEMA = "ree.pipeline.run.v1";
const CHECKPOINT_SCHEMA = "ree.pipeline.checkpoint.v1";
const ACCURACY_SCHEMA = "ree.pipeline.accuracy.v1";
const FINDINGS_SCHEMA = "ree.pipeline.findings.v1";
const STAGES = [
  "scope",
  "investigate",
  "findings",
  "spec",
  "rebuild",
  "verify",
  "package",
  "guard",
  "handoff",
];

const ARTIFACT_SCOPE =
  "Artifact investigation needs --authorized. This directory has no request.json and no behavior spec, so pipeline did not invent a product spec.";
const LIVE_SCOPE =
  "Live document fetch needs --authorized. This run stopped before any request.";
const NOT_A_SPEC =
  "Static analysis produced evidence. It is not a product behavior spec, so rebuild did not invent features.";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function approvalsOf(value = {}) {
  return {
    launch: value.launch === true,
    guard: value.guard === true,
    blast: value.blast === true,
    scale: value.scale === true,
    vault: value.vault === true,
  };
}

function publicVerify(verify) {
  return {
    schema_version: verify.schema_version,
    exit_code: verify.exit_code,
    signal: verify.signal ?? null,
    features: verify.features,
    implemented: verify.implemented,
    unimplemented: verify.unimplemented,
    failed: verify.failed,
    not_run: verify.not_run,
    total: verify.total,
    ratio: verify.ratio,
    quote_test_passed: verify.quote_test_passed,
  };
}

function checkpointPath(outDir, stage) {
  return join(outDir, "checkpoints", stage + ".json");
}

function sameApprovals(left, right) {
  return (
    JSON.stringify(approvalsOf(left)) === JSON.stringify(approvalsOf(right))
  );
}

function reusable(ctx, stage) {
  if (stage.status !== "passed") return false;
  const path = checkpointPath(ctx.outDir, stage.id);
  if (!existsSync(path)) return false;
  const checkpoint = readJson(path);
  if (checkpoint.status !== "passed" || checkpoint.run_id !== ctx.run.run_id)
    return false;
  const outputs = checkpoint.outputs ?? [];
  if (!outputs.every((item) => existsSync(join(ctx.outDir, item))))
    return false;
  if (stage.id === "guard" || stage.id === "handoff") {
    if (!sameApprovals(checkpoint.provenance?.approvals, ctx.run.approvals))
      return false;
  }
  return true;
}

function hydrate(ctx, stageId) {
  const checkpoint = readJson(checkpointPath(ctx.outDir, stageId));
  const provenance = checkpoint.provenance ?? {};
  if (stageId === "scope") ctx.mode = provenance.mode;
  if (provenance.spec_path) {
    ctx.spec = readJson(join(ctx.outDir, provenance.spec_path));
    ctx.analysisDir = join(ctx.outDir, "analysis");
  }
  if (stageId === "rebuild") {
    ctx.productDir = join(ctx.outDir, "product");
    ctx.buildId = provenance.build_id;
  }
  if (stageId === "verify" && existsSync(join(ctx.outDir, "verify.json")))
    ctx.verify = readJson(join(ctx.outDir, "verify.json"));
  if (stageId === "handoff") ctx.handoffDir = provenance.handoff_dir ?? null;
}

async function tick(pace) {
  if (pace) await pace();
  else await new Promise((resolveTick) => setImmediate(resolveTick));
}

function citationsOf(value) {
  const citations = Array.isArray(value?.citations) ? value.citations : [];
  return citations
    .filter((item) => item && typeof item.url === "string")
    .map((item) => ({
      url: item.url,
      fetched_at: item.fetched_at ?? null,
    }));
}

function accuracyReport(spec, verify) {
  const plan = planProduct(spec);
  const expected = plan.behaviors
    .filter((item) => item.status === "implemented")
    .map((item) => item.id);
  const observed = verify.features
    .filter((feature) => feature.match === "pass")
    .map((feature) => feature.id);
  const expectedSet = new Set(expected);
  const falseClaims = observed.filter((id) => !expectedSet.has(id));
  const missed = expected.filter((id) => !observed.includes(id));
  let precision = null;
  let recall = null;
  if (expected.length === 0 && observed.length === 0) {
    precision = null;
    recall = null;
  } else if (observed.length === 0) {
    precision = 1;
    recall = 0;
  } else if (expected.length === 0) {
    precision = 0;
    recall = null;
  } else {
    const hits = observed.filter((id) => expectedSet.has(id)).length;
    precision = hits / observed.length;
    recall = hits / expected.length;
  }
  return {
    schema_version: ACCURACY_SCHEMA,
    kind: "feature-plan",
    not_the_corpus_bench: true,
    note: "This is not node ree.mjs bench. The route tests are the execution check. The oracle is the rebuild plan: a feature is expected when it was given a data model, rules, and CRUD routes.",
    expected_implemented_ids: expected,
    observed_pass_ids: observed,
    false_claims: falseClaims,
    missed,
    precision,
    recall,
    quote_test_passed: verify.quote_test_passed === true,
    failed: verify.failed,
  };
}

function blankRun({ runId, fixture, productName, approvals }) {
  return {
    schema_version: RUN_SCHEMA,
    run_id: runId,
    target: fixture,
    product_name: productName,
    dry_run: true,
    approvals,
    stages: STAGES.map((id) => ({
      id,
      status: "pending",
      checkpoint: `checkpoints/${id}.json`,
    })),
    stopped_at: null,
    finished: false,
    code: null,
    message: null,
    current_stage: null,
    spec_status: null,
    build_id: null,
    product_dir: null,
    package_path: null,
    board_dir: null,
    handoff_dir: null,
    implemented: null,
    unimplemented: null,
    failed: null,
    verify: null,
    notified_blast: false,
    notified_scale: false,
    guard_sign_off: "not-submitted",
    approved_for_vault_copy: false,
    launch_approved: approvals.launch,
    box_copied: false,
    shared_board: null,
    accuracy_path: null,
  };
}

function publish(ctx) {
  const run = ctx.run;
  run.dry_run = true;
  run.notified_blast = false;
  run.notified_scale = false;
  run.guard_sign_off = "not-submitted";
  run.approved_for_vault_copy = false;
  run.launch_approved = run.approvals.launch === true;
  run.product_name = run.product_name;
  run.spec_status = ctx.spec?.status ?? run.spec_status ?? null;
  run.product_dir = ctx.productDir ?? null;
  run.build_id = ctx.buildId ?? run.build_id ?? null;
  run.package_path = ctx.productDir
    ? join(ctx.productDir, "product.tgz")
    : null;
  if (run.package_path && !existsSync(run.package_path))
    run.package_path = null;
  run.board_dir = existsSync(join(ctx.outDir, "board", "board.json"))
    ? join(ctx.outDir, "board")
    : null;
  run.handoff_dir = ctx.handoffDir ?? null;
  run.accuracy_path = existsSync(join(ctx.outDir, "accuracy.json"))
    ? join(ctx.outDir, "accuracy.json")
    : null;
  const sharedMarker = join(ctx.outDir, "shared-board.json");
  if (existsSync(sharedMarker)) {
    const marker = readJson(sharedMarker);
    run.shared_board = marker.shared_dir ?? null;
  }
  if (ctx.verify) {
    run.verify = publicVerify(ctx.verify);
    run.implemented = ctx.verify.implemented;
    run.unimplemented = ctx.verify.unimplemented;
    run.failed = ctx.verify.failed;
  }
  writeJson(join(ctx.outDir, "run.json"), run);
  return run;
}

function isOutsideIn(mode) {
  return (
    mode === "outside-in-fixture" ||
    mode === "outside-in-live" ||
    mode === "outside-in-url" ||
    mode === "ingested-spec"
  );
}

function httpTarget(value) {
  const text = String(value ?? "").trim();
  if (!/^https?:\/\//iu.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("pipeline TARGET must be a directory or an http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password)
    throw new Error("Use a URL without embedded credentials.");
  return url;
}

function urlTargetName(value) {
  const hostname = new URL(value).hostname;
  if (hostname.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname))
    return "REE public read";
  return hostname;
}

function readIngestedSpec(dir) {
  const specPath = join(dir, "behavior-spec.json");
  let spec;
  try {
    spec = readJson(specPath);
  } catch {
    throw new Error("behavior-spec.json could not be read.");
  }
  if (spec?.schema_version !== SCHEMA_VERSION)
    throw new Error(
      "behavior-spec.json is not a ree.outside-in.behavior-spec.v1 document.",
    );
  return spec;
}

function investigateIngested(ctx) {
  const spec = assertValidBehaviorSpec(
    ctx.spec ?? readIngestedSpec(ctx.fixture),
  );
  ctx.spec = spec;
  const analysisDir = join(ctx.outDir, "analysis");
  mkdirSync(analysisDir, { recursive: true });
  writeJson(join(analysisDir, "behavior-spec.json"), spec);
  const reportSrc = join(ctx.fixture, "OUTSIDE_IN_REPORT.md");
  const fallback = [
    "# Ingested behavior spec",
    "",
    "This run copied a completed behavior spec. No network request was made.",
    "",
  ].join("\n");
  writeFileSync(
    join(analysisDir, "OUTSIDE_IN_REPORT.md"),
    existsSync(reportSrc) ? readFileSync(reportSrc, "utf8") : fallback,
  );
  ctx.analysisDir = analysisDir;
  return {
    message: "Copied the ingested behavior spec. No network request was made.",
    outputs: ["analysis/behavior-spec.json", "analysis/OUTSIDE_IN_REPORT.md"],
    provenance: {
      mode: "ingested-spec",
      tool: "ingested-spec",
      spec_status: spec.status,
      spec_path: "analysis/behavior-spec.json",
      network: false,
    },
  };
}

async function stageScope(ctx) {
  if (ctx.url) {
    ctx.mode = "outside-in-url";
    return {
      message: `This URL is the authorization scope. Investigate will request ${ctx.url} and its robots.txt. Requests are rate-limited. There is no login.`,
      outputs: [],
      provenance: {
        mode: "outside-in-url",
        authorization: "url",
        network: true,
        url: ctx.url,
      },
    };
  }
  const requestPath = join(ctx.fixture, "request.json");
  const manifestPath = join(ctx.fixture, "manifest.json");
  const hasRequest = existsSync(requestPath);
  const hasManifest = existsSync(manifestPath);
  if (hasRequest && hasManifest) {
    ctx.mode = "outside-in-fixture";
    return {
      message: "Owned fixture. No network request is made.",
      outputs: [],
      provenance: {
        mode: "outside-in-fixture",
        authorization: "owned-fixture",
        network: false,
      },
    };
  }
  if (!hasRequest && existsSync(join(ctx.fixture, "behavior-spec.json"))) {
    ctx.mode = "ingested-spec";
    ctx.spec = readIngestedSpec(ctx.fixture);
    return {
      message: "Ingested behavior spec. No network request is made.",
      outputs: [],
      provenance: {
        mode: "ingested-spec",
        authorization: "ingested-spec",
        network: false,
      },
    };
  }
  if (hasRequest) {
    if (!ctx.authorized) throw new Error(LIVE_SCOPE);
    ctx.mode = "outside-in-live";
    return {
      message:
        "Live document fetch is authorized. Investigate will request the public URLs in request.json.",
      outputs: [],
      provenance: {
        mode: "outside-in-live",
        authorization: "authorized",
        network: true,
      },
    };
  }
  if (!ctx.authorized) throw new Error(ARTIFACT_SCOPE);
  ctx.mode = "artifact";
  return {
    message:
      "Artifact scope recorded. Static analysis has not started. No product spec was invented.",
    outputs: [],
    provenance: {
      mode: "artifact",
      authorization: "authorized",
      network: false,
    },
  };
}

async function stageInvestigate(ctx) {
  if (ctx.mode === "outside-in-url") {
    const analysisDir = join(ctx.outDir, "analysis");
    const result = await analyzeOutsideIn({
      target: { name: urlTargetName(ctx.url), urls: [ctx.url] },
      fetchImpl: ctx.fetchImpl ?? undefined,
      outDir: analysisDir,
      now: () => ctx.now,
      sleep: ctx.sleep ?? undefined,
      minIntervalMs: ctx.minIntervalMs ?? undefined,
    });
    ctx.spec = result.spec;
    ctx.analysisDir = analysisDir;
    if (result.exitCode !== 0)
      throw new Error(
        `Outside-in status is ${result.spec.status}. Pipeline did not rebuild a product from a refused spec.`,
      );
    return {
      message: "Outside-in wrote a behavior spec from the public page.",
      outputs: ["analysis/behavior-spec.json", "analysis/OUTSIDE_IN_REPORT.md"],
      provenance: {
        mode: "outside-in-url",
        tool: "analyzeOutsideIn",
        spec_status: result.spec.status,
        spec_path: "analysis/behavior-spec.json",
        network: true,
        url: ctx.url,
      },
    };
  }
  if (ctx.mode === "ingested-spec") return investigateIngested(ctx);
  if (ctx.mode === "outside-in-fixture" || ctx.mode === "outside-in-live") {
    const request = readJson(join(ctx.fixture, "request.json"));
    const analysisDir = join(ctx.outDir, "analysis");
    const result = await analyzeOutsideIn({
      ...request,
      fixtureDir: ctx.mode === "outside-in-fixture" ? ctx.fixture : undefined,
      outDir: analysisDir,
      now: () => ctx.now,
    });
    ctx.spec = result.spec;
    ctx.analysisDir = analysisDir;
    if (result.exitCode !== 0)
      throw new Error(
        `Outside-in status is ${result.spec.status}. Pipeline did not rebuild a product from a refused spec.`,
      );
    return {
      message: "Outside-in wrote a behavior spec from the recorded documents.",
      outputs: ["analysis/behavior-spec.json", "analysis/OUTSIDE_IN_REPORT.md"],
      provenance: {
        mode: ctx.mode,
        tool: "analyzeOutsideIn",
        spec_status: result.spec.status,
        spec_path: "analysis/behavior-spec.json",
        network: ctx.mode === "outside-in-live",
      },
    };
  }
  if (ctx.mode !== "artifact")
    throw new Error("Scope did not record an investigation mode.");
  const investigationDir = join(ctx.outDir, "investigation");
  planStaticAnalysis(ctx.fixture, investigationDir, true);
  const result = runStaticAnalysis({
    target: ctx.fixture,
    out: investigationDir,
    authorized: true,
  });
  return {
    message:
      "Static analysis wrote evidence. It did not invent product features.",
    outputs: ["investigation/view-evidence.json"],
    provenance: {
      mode: "artifact",
      tool: "runStaticAnalysis",
      evidence: "investigation/view-evidence.json",
      report: result.report,
    },
  };
}

async function stageFindings(ctx) {
  if (isOutsideIn(ctx.mode)) {
    const spec =
      ctx.spec ?? readJson(join(ctx.outDir, "analysis/behavior-spec.json"));
    ctx.spec = spec;
    const findings = {
      schema_version: FINDINGS_SCHEMA,
      source: "outside-in",
      features: (spec.features ?? []).map((feature) => {
        const citations = citationsOf(feature);
        return {
          id: feature.id ?? null,
          name: feature.name ?? null,
          citations,
          citation_present: citations.length > 0,
        };
      }),
      endpoints: (spec.api?.endpoints ?? []).map((endpoint) => {
        const citations = citationsOf(endpoint);
        return {
          method: endpoint.method ?? null,
          path: endpoint.path ?? null,
          operation_id: endpoint.operation_id ?? null,
          citations,
          citation_present: citations.length > 0,
        };
      }),
    };
    writeJson(join(ctx.outDir, "findings.json"), findings);
    return {
      message:
        "Findings list spec features and endpoints with their citations. A feature with no citation is kept and marked.",
      outputs: ["findings.json"],
      provenance: {
        source: "outside-in",
        spec_path: "analysis/behavior-spec.json",
        feature_count: findings.features.length,
        endpoint_count: findings.endpoints.length,
      },
    };
  }
  const evidence = "investigation/view-evidence.json";
  if (!existsSync(join(ctx.outDir, evidence)))
    throw new Error("Static analysis did not leave view-evidence.json.");
  writeJson(join(ctx.outDir, "findings.json"), {
    schema_version: FINDINGS_SCHEMA,
    source: "static-analysis",
    evidence,
    features: [],
    endpoints: [],
    note: "Evidence is linked. Product features were not invented from it.",
  });
  return {
    message:
      "Findings point at the evidence file. No product features were invented.",
    outputs: ["findings.json"],
    provenance: { source: "static-analysis", evidence },
  };
}

async function stageSpec(ctx) {
  if (!isOutsideIn(ctx.mode)) throw new Error(NOT_A_SPEC);
  const spec =
    ctx.spec ?? readJson(join(ctx.outDir, "analysis/behavior-spec.json"));
  ctx.spec = spec;
  if (spec.status !== "completed")
    throw new Error(
      `Outside-in status is ${spec.status}. Pipeline did not rebuild a product from a refused spec.`,
    );
  return {
    message:
      "The clean-room spec is the outside-in behavior spec. No endpoints were invented.",
    outputs: ["analysis/behavior-spec.json"],
    provenance: {
      spec_path: "analysis/behavior-spec.json",
      spec_status: spec.status,
      schema_version: spec.schema_version,
    },
  };
}

async function stageRebuild(ctx) {
  const productDir = join(ctx.outDir, "product");
  const built = scaffoldRebuild({
    spec: ctx.spec,
    productName: ctx.run.product_name,
    outDir: productDir,
    now: ctx.now,
  });
  ctx.productDir = productDir;
  ctx.buildId = built.build_id;
  ctx.run.build_id = built.build_id;
  return {
    message: "Rebuild wrote the HTTP product from the behavior spec.",
    outputs: [
      "product/provenance.json",
      "product/behavior-spec.json",
      "product/src/server.mjs",
    ],
    provenance: {
      build_id: built.build_id,
      product_name: ctx.run.product_name,
      spec_path: "analysis/behavior-spec.json",
    },
  };
}

async function stageVerify(ctx) {
  const verify = verifyRebuild(ctx.productDir);
  ctx.verify = verify;
  const accuracy = accuracyReport(ctx.spec, verify);
  writeJson(join(ctx.outDir, "accuracy.json"), accuracy);
  writeJson(join(ctx.outDir, "verify.json"), publicVerify(verify));
  const problems = [];
  if (verify.exit_code !== 0) problems.push("the product test process failed");
  if (verify.failed > 0) problems.push("a route test failed");
  if (verify.quote_test_passed !== true)
    problems.push("the quote exclusion test did not pass");
  if (accuracy.false_claims.length > 0 || accuracy.missed.length > 0)
    problems.push(
      "the feature-plan accuracy check found a false claim or a missed route",
    );
  if (problems.length > 0)
    throw new Error(
      problems.join("; ") + ". This accuracy file is not node ree.mjs bench.",
    );
  return {
    message:
      "Route tests passed and the feature-plan accuracy check matched. This is not the corpus bench.",
    outputs: ["verify.json", "accuracy.json"],
    provenance: {
      implemented: verify.implemented,
      unimplemented: verify.unimplemented,
      failed: verify.failed,
      precision: accuracy.precision,
      recall: accuracy.recall,
      not_the_corpus_bench: true,
    },
  };
}

async function stagePackage(ctx) {
  const required = [
    "README.md",
    "PRICING.md",
    "LICENSE",
    "NOTICE",
    "LANDING.md",
    "product.tgz",
  ];
  const missing = required.filter(
    (name) => !existsSync(join(ctx.productDir, name)),
  );
  if (missing.length > 0)
    throw new Error("Product package is missing " + missing.join(", ") + ".");
  const brand = String(ctx.spec?.target?.name ?? "").trim();
  const readme = readFileSync(join(ctx.productDir, "README.md"), "utf8");
  const landing = readFileSync(join(ctx.productDir, "LANDING.md"), "utf8");
  if (brand && (readme.includes(brand) || landing.includes(brand)))
    throw new Error("Customer copy includes the spec target name.");
  const findingsPath = join(ctx.outDir, "findings.json");
  const findings = existsSync(findingsPath)
    ? readJson(findingsPath)
    : { features: [], endpoints: [] };
  const coveragePath = join(ctx.productDir, "coverage.json");
  const leftOut = existsSync(coveragePath)
    ? (readJson(coveragePath).left_out ?? [])
    : [];
  const sharedDir = resolveSharedBoardDir({
    env:
      ctx.sharedDir === undefined
        ? process.env
        : { REE_SHARED_BOARD: ctx.sharedDir },
    ...(ctx.boxBoard ? { boxBoard: ctx.boxBoard } : {}),
  });
  const published = publishSharedPipeline({
    sharedDir,
    outDir: ctx.outDir,
    ...(ctx.boxShared ? { boxShared: ctx.boxShared } : {}),
    runId: ctx.run.run_id,
    buildId: ctx.buildId,
    productName: ctx.run.product_name,
    findings,
    verify: ctx.verify,
    leftOut,
    approvals: ctx.run.approvals,
    now: ctx.now,
  });
  const sharedNote = published.shared_dir
    ? " Findings, a board entry, and dry-run Guard, Blast, and Scale requests were written to the shared board. Those systems were not called. Launch, publish, and payment were not performed."
    : " The shared board directory was not present, so nothing was written there.";
  return {
    message:
      "Package contains the README, pricing draft, landing copy, license, NOTICE, and tarball." +
      sharedNote,
    outputs: [
      ...required.map((name) => `product/${name}`),
      "shared-board.json",
      `guard/verdicts/${ctx.buildId}.json`,
    ],
    provenance: {
      package: "product/product.tgz",
      shared_board: published.shared_dir,
      dry_run: true,
      called: published.called,
    },
  };
}

async function stageGuard(ctx) {
  const guard = buildGuardSubmission({
    projectDir: ctx.productDir,
    verify: ctx.verify,
    now: ctx.now,
    approvalRequested: ctx.run.approvals.guard === true,
  });
  mkdirSync(join(ctx.outDir, "guard"), { recursive: true });
  writeJson(join(ctx.outDir, "guard/submission.json"), guard);
  return {
    message: guard.note,
    outputs: ["guard/submission.json"],
    provenance: {
      approvals: ctx.run.approvals,
      sign_off: "not-submitted",
      called: false,
    },
  };
}

async function stageHandoff(ctx) {
  const boardDir = join(ctx.outDir, "board");
  ingestSpec(boardDir, ctx.spec, ctx.now);
  const findingsPath = join(ctx.outDir, "findings.json");
  const findings = existsSync(findingsPath)
    ? readJson(findingsPath)
    : { features: [], endpoints: [] };
  const coveragePath = join(ctx.productDir, "coverage.json");
  const leftOut = existsSync(coveragePath)
    ? (readJson(coveragePath).left_out ?? [])
    : [];
  const posted = postPipelineBoard({
    directory: boardDir,
    runId: ctx.run.run_id,
    findings,
    verify: ctx.verify,
    leftOut,
    now: ctx.now,
  });
  const emitted = emitHandoff({
    projectDir: ctx.productDir,
    verify: ctx.verify,
    blastDir: join(ctx.outDir, "handoff"),
    now: ctx.now,
    approvals: ctx.run.approvals,
    picks: posted.picks,
  });
  ctx.handoffDir = emitted.directory;
  ctx.run.box_copied = false;
  let message =
    "Handoff files were written. Findings and picks were posted on the board. Blast was not notified. Scale was not called. Vault was not copied. Guard was not called.";
  if (ctx.run.approvals.launch === true && existsSync(BOX_SHARED)) {
    const dest = blastDirectory({ buildId: ctx.buildId });
    cpSync(emitted.directory, dest, { recursive: true });
    ctx.run.box_copied = true;
    message =
      "Handoff files were copied under /home/box/shared. Blast was not notified. Scale was not called. Vault was not copied. Guard was not called.";
  }
  const buildDir = relative(ctx.outDir, emitted.directory);
  return {
    message,
    outputs: [
      "board/board.json",
      ...posted.findings.map((item) => `board/findings/${item.id}.json`),
      ...posted.picks.map((item) => `board/picks/${item.id}.json`),
      `${buildDir}/handoff.json`,
      `${buildDir}/README.md`,
      `${buildDir}/guard/submission.json`,
      `${buildDir}/vault/manifest.json`,
      `${buildDir}/scale/manifest.json`,
      `${buildDir}/requests/guard.json`,
      `${buildDir}/requests/blast.json`,
      `${buildDir}/requests/scale.json`,
    ],
    provenance: {
      approvals: ctx.run.approvals,
      handoff_dir: emitted.directory,
      build_id: ctx.buildId,
      notified_blast: false,
      notified_scale: false,
      approved_for_vault_copy: false,
      box_copied: ctx.run.box_copied,
    },
  };
}

const STAGE_RUNNERS = {
  scope: stageScope,
  investigate: stageInvestigate,
  findings: stageFindings,
  spec: stageSpec,
  rebuild: stageRebuild,
  verify: stageVerify,
  package: stagePackage,
  guard: stageGuard,
  handoff: stageHandoff,
};

function loadRun(outDir, fixture, productName, approvals, resume, runId) {
  const runPath = join(outDir, "run.json");
  if (existsSync(runPath) && !resume)
    throw new Error(
      "This output directory already has a pipeline run. Choose a new directory or pass --resume.",
    );
  if (resume && existsSync(runPath)) {
    const run = readJson(runPath);
    if (run.schema_version !== RUN_SCHEMA)
      throw new Error("run.json is not a pipeline run.");
    if (run.target !== fixture)
      throw new Error(
        "This pipeline run was started for a different target. Choose a new output directory.",
      );
    if (productName) run.product_name = productName;
    const previous = approvalsOf(run.approvals);
    const incoming = approvalsOf(approvals);
    run.approvals = {
      launch: previous.launch || incoming.launch,
      guard: previous.guard || incoming.guard,
      blast: previous.blast || incoming.blast,
      scale: previous.scale || incoming.scale,
      vault: previous.vault || incoming.vault,
    };
    run.finished = false;
    run.stopped_at = null;
    run.code = null;
    run.message = null;
    run.dry_run = true;
    return run;
  }
  if (resume)
    throw new Error(
      "Nothing to resume. This output directory has no run.json.",
    );
  return blankRun({
    runId,
    fixture,
    productName: productName || "REE Product",
    approvals: approvalsOf(approvals),
  });
}

/**
 * Investigation through a dry-run sell package.
 * Each stage writes a checkpoint. A failed stage stops the run.
 * Guard, Blast, Scale, and Vault are files. None of those systems is called.
 */
export async function runProductPipeline({
  target,
  outDir,
  productName = null,
  now = new Date(),
  resume = false,
  authorized = false,
  approvals = {},
  runId = null,
  onStage = null,
  pace = null,
  fetchImpl = null,
  sleep = null,
  minIntervalMs = null,
  sharedDir = undefined,
  boxShared = undefined,
  boxBoard = undefined,
}) {
  if (!target || !outDir)
    throw new Error("Use pipeline TARGET --out DIR [--name NAME].");
  const parsedUrl = httpTarget(target);
  let fixture;
  let url = null;
  if (parsedUrl) {
    fixture = parsedUrl.href;
    url = parsedUrl.href;
  } else {
    fixture = resolve(target);
    if (!existsSync(fixture) || !statSync(fixture).isDirectory())
      throw new Error("pipeline TARGET must be a directory.");
  }
  const id = runId ?? "run_" + randomBytes(8).toString("hex");
  if (!/^run_[a-f0-9]{16}$/u.test(id))
    throw new Error("run id must look like run_ and 16 hex characters.");
  mkdirSync(outDir, { recursive: true });
  const name = typeof productName === "string" ? productName.trim() : "";
  const run = loadRun(outDir, fixture, name || null, approvals, resume, id);
  const ctx = {
    run,
    outDir,
    now,
    fixture,
    url,
    fetchImpl,
    sleep,
    minIntervalMs,
    authorized: authorized === true,
    mode: null,
    spec: null,
    productDir: null,
    buildId: null,
    verify: null,
    handoffDir: null,
    sharedDir,
    boxShared,
    boxBoard,
  };
  publish(ctx);
  for (const stage of run.stages) {
    if (reusable(ctx, stage)) {
      hydrate(ctx, stage.id);
      continue;
    }
    stage.status = "running";
    run.current_stage = stage.id;
    publish(ctx);
    if (onStage)
      onStage({ run_id: run.run_id, id: stage.id, status: "running" });
    await tick(pace);
    const started = new Date();
    try {
      const result = await STAGE_RUNNERS[stage.id](ctx);
      const checkpoint = {
        schema_version: CHECKPOINT_SCHEMA,
        run_id: run.run_id,
        stage: stage.id,
        status: "passed",
        started_at: started.toISOString(),
        finished_at: new Date().toISOString(),
        message: result.message,
        outputs: result.outputs,
        provenance: result.provenance,
      };
      mkdirSync(join(outDir, "checkpoints"), { recursive: true });
      writeJson(checkpointPath(outDir, stage.id), checkpoint);
      stage.status = "passed";
      publish(ctx);
      if (onStage)
        onStage({ run_id: run.run_id, id: stage.id, status: "passed" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const checkpoint = {
        schema_version: CHECKPOINT_SCHEMA,
        run_id: run.run_id,
        stage: stage.id,
        status: "failed",
        started_at: started.toISOString(),
        finished_at: new Date().toISOString(),
        message: reason,
        outputs: [],
        provenance: { failed: true },
      };
      mkdirSync(join(outDir, "checkpoints"), { recursive: true });
      writeJson(checkpointPath(outDir, stage.id), checkpoint);
      stage.status = "failed";
      run.stopped_at = stage.id;
      run.finished = true;
      run.code = 1;
      run.message = `pipeline stopped at ${stage.id}. ${reason}`;
      run.current_stage = stage.id;
      if (onStage)
        onStage({
          run_id: run.run_id,
          id: stage.id,
          status: "failed",
          message: run.message,
        });
      return publish(ctx);
    }
  }
  run.stopped_at = null;
  run.finished = true;
  run.code = 0;
  run.message = null;
  run.current_stage = null;
  return publish(ctx);
}
