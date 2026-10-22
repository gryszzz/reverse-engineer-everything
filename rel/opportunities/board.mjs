import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertValidBehaviorSpec } from "../outside-in/validate.mjs";
import { formatParseErrors, parseScoutTarget } from "./parse.mjs";

export const BOARD_SCHEMA = "ree.opportunities.board.v1";

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
