import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { handoffRequest } from "./emit.mjs";
import { stableId } from "../opportunities/board.mjs";
import {
  SHARED_BOARD_SCHEMA,
  redactExportedText,
} from "../opportunities/shared.mjs";

export const SHARED_RUN_SCHEMA = "ree.shared.run.v1";
export const SHARED_PUBLISH_SCHEMA = "ree.shared.publish.v1";
export const DEFAULT_BOX_SHARED = "/home/box/shared";
export const DEFAULT_BOX_BOARD = "/home/box/shared/ree-board";

const BUILD_ID = /^bld_[a-f0-9]{16}$/u;
const RUN_ID = /^run_[a-f0-9]{16}$/u;
const FINDING_ID = /^fnd_[a-f0-9]{16}$/u;

const NOTE =
  "Approval flags record intent. Launch, publish, and payment were not performed. Guard was not called. Blast was not notified. Scale was not called.";

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

/**
 * REE_SHARED_BOARD wins when it is set. A missing directory is not created.
 * Otherwise /home/box/shared/ree-board is used only when that directory exists.
 */
export function resolveSharedBoardDir({
  env = process.env,
  boxBoard = DEFAULT_BOX_BOARD,
} = {}) {
  const configured = env.REE_SHARED_BOARD;
  if (typeof configured === "string" && configured.trim()) {
    const dir = configured.trim();
    return isDirectory(dir) ? dir : null;
  }
  return isDirectory(boxBoard) ? boxBoard : null;
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

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function writeText(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : text + "\n");
}

function findingReason(featureId, match, reasons) {
  if (featureId && reasons.has(featureId)) return reasons.get(featureId);
  if (match === "pass") return null;
  if (match === "fail") return "the behavior test failed";
  if (match === "not-run") return "the feature test did not run";
  if (match === "unimplemented") return "the feature was not built";
  return null;
}

function featureRow(runId, feature, verifyById, reasons) {
  const key = feature.id ?? feature.name ?? "feature";
  const checked = feature.id ? verifyById.get(feature.id) : null;
  return {
    id: stableId("fnd_", [runId, "feature", key]),
    kind: "feature",
    feature_id: feature.id ?? null,
    name: feature.name ?? null,
    match: checked?.match ?? null,
    reason: findingReason(feature.id, checked?.match, reasons),
    citations: feature.citations ?? [],
    citation_present: feature.citation_present === true,
  };
}

function endpointRow(runId, endpoint) {
  const key = [endpoint.method, endpoint.path, endpoint.operation_id]
    .map((part) => part ?? "")
    .join(" ");
  return {
    id: stableId("fnd_", [runId, "endpoint", key]),
    kind: "endpoint",
    method: endpoint.method ?? null,
    path: endpoint.path ?? null,
    operation_id: endpoint.operation_id ?? null,
    citation_present: endpoint.citation_present === true,
    citations: endpoint.citations ?? [],
    match: null,
    reason: null,
  };
}

function findingRows({ runId, findings, verify, leftOut }) {
  const reasons = new Map(
    (leftOut ?? [])
      .filter((item) => item && item.id)
      .map((item) => [item.id, item.reason ?? null]),
  );
  const verifyById = new Map(
    (verify?.features ?? []).map((feature) => [feature.id, feature]),
  );
  const rows = [
    ...(findings?.features ?? []).map((feature) =>
      featureRow(runId, feature, verifyById, reasons),
    ),
    ...(findings?.endpoints ?? []).map((endpoint) =>
      endpointRow(runId, endpoint),
    ),
  ];
  for (const row of rows) {
    if (!FINDING_ID.test(row.id))
      throw new Error("finding id must look like fnd_ and 16 hex characters.");
  }
  return rows;
}

function requestPicks(verify) {
  return (verify?.features ?? [])
    .filter((feature) => feature.match === "pass")
    .map((feature) => ({
      id: null,
      finding_id: null,
      feature_id: feature.id ?? null,
      name: feature.name ?? null,
      route: feature.route ?? null,
    }));
}

function requestsFor({ buildId, productName, verify, asked }) {
  const picks = requestPicks(verify);
  return {
    guard: handoffRequest({
      to: "guard",
      buildId,
      productName,
      picks,
      approvalRequested: asked.guard,
      note:
        "Guard was not called. This verdict request is the file a person can send. " +
        NOTE,
    }),
    blast: handoffRequest({
      to: "blast",
      buildId,
      productName,
      picks,
      approvalRequested: asked.blast,
      note:
        "Blast was not notified. This handoff file is the request a person can send. " +
        NOTE,
    }),
    scale: handoffRequest({
      to: "scale",
      buildId,
      productName,
      picks,
      approvalRequested: asked.scale,
      note:
        "Scale was not called. This handoff file is the request a person can send. " +
        NOTE,
    }),
  };
}

function citationLines(citations) {
  return (citations ?? []).map((item) => {
    const url = redactExportedText(String(item?.url ?? ""));
    const when = item?.fetched_at ? ` fetched ${item.fetched_at}` : "";
    return `- ${url}${when}`;
  });
}

function markdown(row) {
  const lines = [
    `# ${row.id}`,
    "",
    `kind: ${row.kind}`,
    `citation_present: ${row.citation_present === true}`,
  ];
  if (row.kind === "feature") {
    lines.push(
      `feature_id: ${row.feature_id ?? ""}`,
      `name: ${row.name ?? ""}`,
      `match: ${row.match ?? ""}`,
      `reason: ${row.reason ?? ""}`,
    );
  } else {
    lines.push(
      `method: ${row.method ?? ""}`,
      `path: ${row.path ?? ""}`,
      `operation_id: ${row.operation_id ?? ""}`,
    );
  }
  lines.push("", "## Citations", ...citationLines(row.citations), "", NOTE, "");
  return redactExportedText(lines.join("\n"));
}

function writeFindings(sharedDir, rows) {
  const names = [];
  for (const row of rows) {
    const relativePath = `findings/${row.id}.md`;
    const path = join(sharedDir, relativePath);
    if (existsSync(path) && statSync(path).isDirectory())
      throw new Error("Shared finding path is a directory: " + row.id);
    writeText(path, markdown(row));
    names.push(relativePath);
  }
  return names;
}

function readBoard(path) {
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Shared board.json could not be read.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Shared board.json is not an object.");
  return parsed;
}

function runEntry({
  runId,
  buildId,
  productName,
  now,
  asked,
  findingNames,
  requestNames,
  boxReady,
  verdictName,
}) {
  return {
    schema_version: SHARED_RUN_SCHEMA,
    run_id: runId,
    build_id: buildId,
    product_name: productName ?? null,
    posted_at: now.toISOString(),
    dry_run: true,
    called: {
      guard: false,
      blast: false,
      scale: false,
      launch: false,
      publish: false,
      payment: false,
    },
    approvals: asked,
    launch: {
      dry_run: true,
      performed: false,
      approval_requested: asked.launch,
    },
    publish: {
      dry_run: true,
      performed: false,
      approval_requested: false,
      note: "No publish step is implemented. Nothing was published.",
    },
    payment: {
      dry_run: true,
      performed: false,
      approval_requested: asked.vault,
      note: "Vault approval records intent. No payment was taken.",
    },
    findings: findingNames,
    requests: requestNames,
    guard_verdict: boxReady ? `guard/verdicts/${verdictName}` : null,
    note: NOTE,
  };
}

function appendRun(sharedDir, entry, current) {
  const board = current ?? {
    schema_version: SHARED_BOARD_SCHEMA,
    items: [],
    note: NOTE,
  };
  const runs = Array.isArray(board.runs) ? board.runs : [];
  board.runs = runs.filter((item) => item?.run_id !== entry.run_id);
  board.runs.push(entry);
  writeJson(join(sharedDir, "board.json"), board);
  return board;
}

/**
 * Write the shared board when its directory already exists.
 * Also write a run-local Guard verdict request.
 * Does not create /home/box/shared. Does not call Guard, Blast, or Scale.
 * Launch, publish, and payment are recorded and not performed.
 */
export function publishSharedPipeline({
  sharedDir = null,
  outDir,
  boxShared = DEFAULT_BOX_SHARED,
  runId,
  buildId,
  productName,
  findings,
  verify,
  leftOut = [],
  approvals = {},
  now = new Date(),
}) {
  if (!RUN_ID.test(runId))
    throw new Error("run id must look like run_ and 16 hex characters.");
  if (!BUILD_ID.test(buildId))
    throw new Error("build id must look like bld_ and 16 hex characters.");
  const asked = approvalsOf(approvals);
  const rows = findingRows({ runId, findings, verify, leftOut });
  const requests = requestsFor({
    buildId,
    productName,
    verify,
    asked,
  });
  const verdictName = `${buildId}.json`;
  const localVerdict = join(outDir, "guard", "verdicts", verdictName);
  const boxReady = isDirectory(boxShared);
  const verdictPath = boxReady
    ? join(boxShared, "guard", "verdicts", verdictName)
    : localVerdict;
  writeJson(localVerdict, requests.guard);
  if (verdictPath !== localVerdict) writeJson(verdictPath, requests.guard);

  const existingBoard = sharedDir
    ? readBoard(join(sharedDir, "board.json"))
    : null;
  const findingNames = sharedDir ? writeFindings(sharedDir, rows) : [];
  const requestNames = [];
  if (sharedDir) {
    for (const [name, document] of Object.entries(requests)) {
      const relativePath = `requests/${name}.json`;
      writeJson(join(sharedDir, relativePath), document);
      requestNames.push(relativePath);
    }
    appendRun(
      sharedDir,
      runEntry({
        runId,
        buildId,
        productName,
        now,
        asked,
        findingNames,
        requestNames,
        boxReady,
        verdictName,
      }),
      existingBoard,
    );
  }

  const marker = {
    schema_version: SHARED_PUBLISH_SCHEMA,
    shared_dir: sharedDir,
    dry_run: true,
    called: {
      guard: false,
      blast: false,
      scale: false,
      launch: false,
      publish: false,
      payment: false,
    },
    approvals: asked,
    guard_verdict: verdictPath,
    findings: findingNames,
    requests: requestNames,
    note: NOTE,
  };
  writeJson(join(outDir, "shared-board.json"), marker);
  return marker;
}
