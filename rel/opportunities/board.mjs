import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assertValidBehaviorSpec } from "../outside-in/validate.mjs";
import { formatParseErrors, parseScoutTarget } from "./parse.mjs";

export const BOARD_SCHEMA = "ree.opportunities.board.v1";
export const FINDING_SCHEMA = "ree.board.finding.v1";
export const PICK_SCHEMA = "ree.board.pick.v1";
export const EXPORT_SCHEMA = "ree.board.export.v1";

function emptyBoard() {
  return { schema_version: BOARD_SCHEMA, items: [] };
}

export function readBoard(directory) {
  const path = join(directory, "board.json");
  if (!existsSync(path)) return emptyBoard();
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed.schema_version !== BOARD_SCHEMA)
    throw new Error("Opportunity board schema is not " + BOARD_SCHEMA);
  if (!Array.isArray(parsed.items))
    throw new Error("Opportunity board items are missing.");
  return parsed;
}

export function writeBoard(directory, board) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "board.json"),
    JSON.stringify(board, null, 2) + "\n",
  );
  return board;
}

function newId() {
  return "opp_" + randomBytes(8).toString("hex");
}

function upsert(board, item, key) {
  const index = board.items.findIndex((current) => current.key === key);
  if (index === -1) board.items.push(item);
  else board.items[index] = { ...item, id: board.items[index].id };
  return board;
}

/** Keep Scout scores as supplied. Do not invent a second score. */
export function scoutListing(target) {
  return {
    score_source: "scout",
    scores: target.scores,
    confidence: target.confidence,
    market_signal: target.market_signal,
    note: "Scores are the integers in the Scout record. REE did not rescore them.",
  };
}

/** A behavior spec has no 1-5 market scores. Report coverage only. */
export function specListing(spec) {
  return {
    score_source: "spec-coverage",
    scores: null,
    confidence: null,
    coverage: {
      features: spec.features.length,
      limitations: spec.limitations.length,
      plans: spec.pricing.plans.length,
      unknowns: spec.coverage.unknowns.length,
    },
    note: "Outside-in specs do not include Scout market scores. Nothing was invented to fill them.",
  };
}

export function ingestScout(directory, value, now = new Date()) {
  const parsed = parseScoutTarget(value);
  if (!parsed.ok)
    throw new Error(
      "Scout target rejected. " + formatParseErrors(parsed.errors),
    );
  const target = parsed.target;
  const board = readBoard(directory);
  const key = `scout\n${target.target_name}\n${target.url}`;
  upsert(
    board,
    {
      id: newId(),
      key,
      kind: "scout",
      ingested_at: now.toISOString(),
      target_name: target.target_name,
      url: target.url,
      listing: scoutListing(target),
      record: target,
    },
    key,
  );
  return writeBoard(directory, board);
}

export function ingestSpec(directory, value, now = new Date()) {
  const spec = assertValidBehaviorSpec(value);
  const board = readBoard(directory);
  const url = spec.target.urls[0];
  const key = `outside-in\n${spec.target.name}\n${url}`;
  upsert(
    board,
    {
      id: newId(),
      key,
      kind: "outside-in",
      ingested_at: now.toISOString(),
      target_name: spec.target.name,
      url,
      listing: specListing(spec),
      record: {
        schema_version: spec.schema_version,
        generated_at: spec.generated_at,
        target: spec.target,
        clean_room: spec.clean_room,
      },
    },
    key,
  );
  return writeBoard(directory, board);
}

export function listOpportunities(directory) {
  const board = readBoard(directory);
  const scout = board.items
    .filter((item) => item.kind === "scout")
    .sort((left, right) => {
      const total = right.listing.scores.total - left.listing.scores.total;
      if (total !== 0) return total;
      return right.listing.confidence - left.listing.confidence;
    });
  const specs = board.items
    .filter((item) => item.kind === "outside-in")
    .sort((left, right) => left.target_name.localeCompare(right.target_name));
  return { schema_version: board.schema_version, scout, specs };
}

function stableId(prefix, parts) {
  return (
    prefix +
    createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16)
  );
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readJsonFiles(directory, schema) {
  if (!existsSync(directory)) return [];
  const records = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8"));
    if (parsed.schema_version === schema) records.push(parsed);
  }
  return records;
}

function clearRunFiles(directory, schema, runId) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed.schema_version === schema && parsed.run_id === runId)
      rmSync(path);
  }
}

/** A pipeline output directory keeps the board in board/. A board directory is itself. */
export function boardRoot(directory) {
  const nested = join(directory, "board");
  if (
    existsSync(join(nested, "board.json")) ||
    existsSync(join(nested, "findings")) ||
    existsSync(join(nested, "picks"))
  )
    return nested;
  return directory;
}

function findingReason(featureId, match, reasons) {
  if (featureId && reasons.has(featureId)) return reasons.get(featureId);
  if (match === "pass") return null;
  if (match === "fail") return "the behavior test failed";
  if (match === "not-run") return "the feature test did not run";
  if (match === "unimplemented") return "the feature was not built";
  return null;
}

/**
 * Post one JSON file per finding and one JSON file per passing feature.
 * A later post for the same run replaces those files.
 * Guard, Blast, and Scale are not called.
 */
export function postPipelineBoard({
  directory,
  runId,
  findings,
  verify,
  leftOut = [],
  now = new Date(),
}) {
  if (!/^run_[a-f0-9]{16}$/u.test(runId))
    throw new Error("run id must look like run_ and 16 hex characters.");
  const postedAt = now.toISOString();
  const reasons = new Map(
    (leftOut ?? [])
      .filter((item) => item && item.id)
      .map((item) => [item.id, item.reason ?? null]),
  );
  const verifyById = new Map(
    (verify?.features ?? []).map((feature) => [feature.id, feature]),
  );
  const findingsDir = join(directory, "findings");
  const picksDir = join(directory, "picks");
  mkdirSync(findingsDir, { recursive: true });
  mkdirSync(picksDir, { recursive: true });
  clearRunFiles(findingsDir, FINDING_SCHEMA, runId);
  clearRunFiles(picksDir, PICK_SCHEMA, runId);

  const writtenFindings = [];
  const byFeature = new Map();
  for (const feature of findings?.features ?? []) {
    const key = feature.id ?? feature.name ?? "feature";
    const checked = feature.id ? verifyById.get(feature.id) : null;
    const record = {
      schema_version: FINDING_SCHEMA,
      id: stableId("fnd_", [runId, "feature", key]),
      run_id: runId,
      posted_at: postedAt,
      kind: "feature",
      feature_id: feature.id ?? null,
      name: feature.name ?? null,
      citation_present: feature.citation_present === true,
      citations: feature.citations ?? [],
      match: checked?.match ?? null,
      reason: findingReason(feature.id, checked?.match, reasons),
    };
    writeJson(join(findingsDir, record.id + ".json"), record);
    writtenFindings.push(record);
    if (feature.id) byFeature.set(feature.id, record);
  }
  for (const endpoint of findings?.endpoints ?? []) {
    const key = [endpoint.method, endpoint.path, endpoint.operation_id]
      .map((part) => part ?? "")
      .join(" ");
    const record = {
      schema_version: FINDING_SCHEMA,
      id: stableId("fnd_", [runId, "endpoint", key]),
      run_id: runId,
      posted_at: postedAt,
      kind: "endpoint",
      method: endpoint.method ?? null,
      path: endpoint.path ?? null,
      operation_id: endpoint.operation_id ?? null,
      citation_present: endpoint.citation_present === true,
      citations: endpoint.citations ?? [],
    };
    writeJson(join(findingsDir, record.id + ".json"), record);
    writtenFindings.push(record);
  }

  const picks = [];
  for (const feature of verify?.features ?? []) {
    if (feature.match !== "pass") continue;
    const finding = byFeature.get(feature.id);
    const record = {
      schema_version: PICK_SCHEMA,
      id: stableId("pick_", [runId, feature.id]),
      run_id: runId,
      posted_at: postedAt,
      finding_id: finding?.id ?? null,
      feature_id: feature.id,
      name: feature.name ?? null,
      match: "pass",
      route: feature.route ?? null,
    };
    writeJson(join(picksDir, record.id + ".json"), record);
    picks.push(record);
  }
  return { findings: writtenFindings, picks };
}

export function listFindings(directory) {
  return readJsonFiles(
    join(boardRoot(directory), "findings"),
    FINDING_SCHEMA,
  ).sort(
    (left, right) =>
      String(left.name ?? left.path ?? "").localeCompare(
        String(right.name ?? right.path ?? ""),
      ) || left.id.localeCompare(right.id),
  );
}

export function listPicks(directory) {
  return readJsonFiles(join(boardRoot(directory), "picks"), PICK_SCHEMA).sort(
    (left, right) =>
      String(left.name ?? "").localeCompare(String(right.name ?? "")) ||
      left.id.localeCompare(right.id),
  );
}

function copyRecords(records, directory) {
  mkdirSync(directory, { recursive: true });
  const names = [];
  for (const record of records) {
    const name = record.id + ".json";
    writeJson(join(directory, name), record);
    names.push(name);
  }
  return names;
}

/**
 * Copy finding files, pick files, and any Guard, Blast, and Scale request
 * files into a new directory. This does not call those systems.
 */
export function exportBoard({ dataDir, outDir, now = new Date() }) {
  const findings = listFindings(dataDir);
  const picks = listPicks(dataDir);
  mkdirSync(outDir, { recursive: true });
  const findingNames = copyRecords(findings, join(outDir, "findings"));
  const pickNames = copyRecords(picks, join(outDir, "picks"));
  const requests = [];
  const called = { guard: false, blast: false, scale: false };
  const handoffRoot = join(dataDir, "handoff");
  if (existsSync(handoffRoot)) {
    mkdirSync(join(outDir, "requests"), { recursive: true });
    for (const build of readdirSync(handoffRoot)) {
      const source = join(handoffRoot, build, "requests");
      if (!existsSync(source)) continue;
      for (const name of ["guard.json", "blast.json", "scale.json"]) {
        const from = join(source, name);
        if (!existsSync(from)) continue;
        const parsed = JSON.parse(readFileSync(from, "utf8"));
        copyFileSync(from, join(outDir, "requests", name));
        requests.push("requests/" + name);
        const to = parsed.to;
        if (to === "guard" || to === "blast" || to === "scale")
          called[to] = parsed.called === true;
      }
    }
  }
  const manifest = {
    schema_version: EXPORT_SCHEMA,
    exported_at: now.toISOString(),
    dry_run: true,
    called,
    findings: findingNames.map((name) => "findings/" + name),
    picks: pickNames.map((name) => "picks/" + name),
    requests,
    note: "Export copies files. It does not call Guard, notify Blast, or call Scale.",
  };
  writeJson(join(outDir, "export.json"), manifest);
  return manifest;
}
