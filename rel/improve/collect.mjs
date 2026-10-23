import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  formatParseErrors,
  parseScoutTarget,
} from "../opportunities/parse.mjs";
import { assertValidBehaviorSpec } from "../outside-in/validate.mjs";
import { slug } from "../outside-in/text.mjs";

export const IMPROVE_SCHEMA = "ree.improve.v1";
export const EVIDENCE_SCHEMA = "ree.improve.evidence.v1";
export const SCALE_EVIDENCE_SCHEMA = "ree.scale.evidence.v1";
export const BETTER_TITLE = "What we do better";
export const DEFAULT_BOX_BOARD = "/home/box/shared/ree-board";

const EMPTY_NOTE =
  "No Scout, Scale, or pick evidence was found. The improvement list is empty. Nothing was invented.";
const OFF_NOTE =
  "Improvement was turned off. No evidence was read. The improvement list is empty.";
const LIST_NOTE =
  "Each item quotes a Scout weakness, a Scale pricing or willingness-to-pay record, or a build pick. Willingness-to-pay quotes with a numeric amount come first, higher amount first. Then other Scale pricing quotes, Scout weakness quotes, and accepted build picks. File order breaks ties. A repeated quote keeps the earlier rank. A record is accepted only when it matches the target name, a target URL host, or the target category. A record with no source URL is marked unsourced and excluded. No score was invented. The count is not a percentage of the original product.";
const BUILD_NOTE =
  "No Scout, Scale, or pick file was passed to this build. The improvement list is empty.";

const WEAKNESS_KIND = {
  missing_feature: "feature",
  ux: "ux",
  overpriced: "pricing",
  support: "complaint",
  billing: "complaint",
  lock_in: "complaint",
};

/**
 * Cited improvements only. A missing file is a thrown error for an explicit
 * path. A file that is not Scout, Scale, or a pick is skipped with a reason.
 */
export function collectImprovements({
  evidencePath = null,
  boxBoard = undefined,
  noImprove = false,
  now = new Date(),
  target = null,
} = {}) {
  if (noImprove) {
    return report({
      note: OFF_NOTE,
      status: "empty",
      read: [],
      skipped: evidencePath
        ? [
            {
              target: evidencePath,
              reason: "Improvement was turned off, so this path was not read.",
            },
          ]
        : [],
      items: [],
      now,
    });
  }
  const skipped = [];
  const read = [];
  const candidates = [];
  const paths = [];
  if (evidencePath) paths.push(...expandPath(evidencePath));
  const board = boxBoard === undefined ? defaultBoard() : boxBoard;
  if (board && existsSync(board) && board !== evidencePath)
    paths.push(...expandPath(board));
  const seenPaths = new Set();
  for (const path of paths) {
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    readPath(path, read, skipped, candidates, target);
  }
  const items = rank(candidates, target);
  return report({
    note: items.length === 0 ? EMPTY_NOTE : LIST_NOTE,
    status: items.length === 0 ? "empty" : "listed",
    read,
    skipped,
    items,
    now,
  });
}

export function emptyBuildImprovements(now = new Date()) {
  return report({
    note: BUILD_NOTE,
    status: "empty",
    read: [],
    skipped: [],
    items: [],
    now,
  });
}

/** Append accepted improvements as behavior-spec features. The input is not mutated. */
export function specWithImprovements(spec, improvements, now = new Date()) {
  const items = improvements?.items ?? [];
  if (items.length === 0) return spec;
  const features = [...(spec.features ?? [])];
  const seen = new Set(features.map((feature) => feature.id));
  const readAt = stamp(now);
  const target = spec.target ?? null;
  for (const item of items) {
    const feature = featureFrom(item, readAt, target);
    let id = feature.id;
    let number = 2;
    while (seen.has(id)) {
      id = `${feature.id}-${number}`;
      number += 1;
    }
    feature.id = id;
    features.push(feature);
    seen.add(id);
  }
  const next = { ...spec, features };
  assertValidBehaviorSpec(next);
  return next;
}

export function improvementLines(improvements, forbidden = []) {
  const lines = [`## ${BETTER_TITLE}`, ""];
  if (!improvements) {
    lines.push("No improvement report was saved with this product.", "");
    return lines;
  }
  lines.push(improvements.note ?? EMPTY_NOTE, "");
  const items = improvements.items ?? [];
  if (items.length === 0) {
    lines.push("The list is empty.", "");
    return lines;
  }
  let hidden = 0;
  for (const item of items) {
    const quote = oneLine(item.quote);
    const source = oneLine(item.source);
    const blocked = forbidden.some(
      (name) => name && (quote.includes(name) || source.includes(name)),
    );
    if (blocked) {
      hidden += 1;
      lines.push(
        `- ${item.id} (improvement). The quote repeated a recorded name and was omitted from this file.`,
      );
      continue;
    }
    lines.push(`- ${item.id} (improvement). ${item.kind}. ${quote}`);
    lines.push(`  Record: ${item.record}. Source: ${source}.`);
  }
  if (hidden > 0)
    lines.push(
      hidden === 1
        ? "One quote was omitted because it repeated a recorded name."
        : `${hidden} quotes were omitted because they repeated a recorded name.`,
    );
  lines.push("");
  return lines;
}

export function publicImprovements(improvements, forbidden = []) {
  if (!improvements) {
    return {
      schema_version: IMPROVE_SCHEMA,
      title: BETTER_TITLE,
      note: "No improvement report was saved with this product.",
      status: "empty",
      items: [],
    };
  }
  return {
    schema_version: IMPROVE_SCHEMA,
    title: BETTER_TITLE,
    note: improvements.note,
    status: improvements.status,
    items: (improvements.items ?? []).map((item) => {
      const quote = oneLine(item.quote);
      const source = oneLine(item.source);
      const blocked = forbidden.some(
        (name) => name && (quote.includes(name) || source.includes(name)),
      );
      return {
        id: item.id,
        rank: item.rank,
        kind: item.kind,
        record: item.record,
        source: blocked ? null : source,
        quote: blocked ? null : quote,
        quote_omitted: blocked,
        mark: "improvement",
      };
    }),
  };
}

function report({ note, status, read, skipped, items, now }) {
  return {
    schema_version: IMPROVE_SCHEMA,
    title: BETTER_TITLE,
    generated_at: stamp(now),
    status,
    note,
    read,
    skipped,
    items,
  };
}

function defaultBoard() {
  return existsSync(DEFAULT_BOX_BOARD) ? DEFAULT_BOX_BOARD : null;
}

function expandPath(path) {
  if (!existsSync(path))
    throw new Error("--improvements path was not found: " + path);
  if (statSync(path).isDirectory()) return directoryEntries(path);
  return [path];
}

function directoryEntries(dir) {
  const files = [];
  for (const name of ["scout.json", "scale.json"]) {
    const path = join(dir, name);
    if (existsSync(path) && statSync(path).isFile()) files.push(path);
  }
  for (const name of ["scout", "scale", "picks"])
    collectJson(files, join(dir, name));
  return files;
}

function collectJson(files, dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    if (statSync(path).isFile()) files.push(path);
  }
}

function readPath(path, read, skipped, candidates, target) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    skipped.push({ target: path, reason: "The file is not JSON." });
    return;
  }
  if (value?.schema_version === EVIDENCE_SCHEMA) {
    read.push({ path, kind: "bundle" });
    if (value.scout) takeScout(value.scout, path, skipped, candidates, target);
    if (value.scale) takeScale(value.scale, path, skipped, candidates, target);
    if (Array.isArray(value.picks))
      for (const pick of value.picks)
        takePick(pick, path, skipped, candidates, target);
    if (!value.scout && !value.scale && !Array.isArray(value.picks))
      skipped.push({
        target: path,
        reason: "The evidence file has no scout, scale, or pick records.",
      });
    return;
  }
  if (value?.schema_version === SCALE_EVIDENCE_SCHEMA) {
    read.push({ path, kind: "scale" });
    takeScale(value, path, skipped, candidates, target);
    return;
  }
  const scout = parseScoutTarget(value);
  if (scout.ok) {
    read.push({ path, kind: "scout" });
    takeScout(value, path, skipped, candidates, target);
    return;
  }
  const pickProblem = pickError(value);
  if (!pickProblem) {
    read.push({ path, kind: "pick" });
    takePick(value, path, skipped, candidates, target);
    return;
  }
  if (looksLikePick(value)) {
    skipped.push({ target: path, reason: pickProblem });
    return;
  }
  skipped.push({
    target: path,
    reason:
      "Not a Scout record, a Scale evidence file, or a pick. " +
      formatParseErrors(scout.errors),
  });
}

function takeScout(value, path, skipped, candidates, target) {
  const parsed = parseScoutTarget(value);
  if (!parsed.ok) {
    skipped.push({
      target: path,
      reason: "Scout record was not used. " + formatParseErrors(parsed.errors),
    });
    return;
  }
  const scoutTarget = parsed.target;
  skipped.push({
    target: path,
    reason:
      "Scout scores and market notes were not turned into improvements. Only weakness quotes were used.",
  });
  scoutTarget.weaknesses.forEach((item, index) => {
    const quote = oneLine(item.summary);
    if (!quote) {
      skipped.push({
        target: path,
        reason: `weaknesses[${index}] has no summary.`,
      });
      return;
    }
    acceptCandidate(
      {
        bucket: "scout",
        order: index,
        kind: WEAKNESS_KIND[item.type] ?? "complaint",
        quote,
        record: "scout",
        source: path,
        citation: {
          url: item.evidence_urls[0],
          fetched_at: scoutTarget.found_at,
        },
      },
      {
        targetName: scoutTarget.target_name,
        urls: [scoutTarget.url, item.evidence_urls[0]],
        category: scoutTarget.category,
        texts: [quote, scoutTarget.target_name],
      },
      path,
      skipped,
      candidates,
      target,
    );
  });
}

function takeScale(value, path, skipped, candidates, target) {
  if (value?.schema_version !== SCALE_EVIDENCE_SCHEMA) {
    skipped.push({
      target: path,
      reason:
        "Scale evidence schema_version must be " + SCALE_EVIDENCE_SCHEMA + ".",
    });
    return;
  }
  const allowed = new Set([
    "schema_version",
    "pricing",
    "willingness_to_pay",
    "target_name",
    "url",
    "category",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      skipped.push({
        target: path,
        reason: `Scale field ${key} is not a pricing or willingness-to-pay field, so it was not used.`,
      });
    }
  }
  const identity = {
    targetName: value.target_name,
    urls: [value.url],
    category: value.category,
  };
  readScaleList({
    list: value.willingness_to_pay,
    field: "willingness_to_pay",
    bucket: "wtp",
    path,
    skipped,
    candidates,
    identity,
    target,
  });
  readScaleList({
    list: value.pricing,
    field: "pricing",
    bucket: "pricing",
    path,
    skipped,
    candidates,
    identity,
    target,
  });
}

function readScaleList({
  list,
  field,
  bucket,
  path,
  skipped,
  candidates,
  identity,
  target,
}) {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    skipped.push({
      target: path,
      reason: `Scale ${field} must be an array of quoted records.`,
    });
    return;
  }
  list.forEach((item, index) => {
    const quote = oneLine(item?.quote);
    const url =
      typeof item?.source_url === "string" ? item.source_url.trim() : "";
    if (!quote || !url) {
      skipped.push({
        target: path,
        reason: `Scale ${field}[${index}] needs a quote and a source_url. Nothing was invented.`,
      });
      return;
    }
    const recorded = {};
    if (typeof item.amount === "string" && item.amount.trim())
      recorded.amount = item.amount.trim();
    if (typeof item.currency === "string" && item.currency.trim())
      recorded.currency = item.currency.trim();
    if (typeof item.name === "string" && item.name.trim())
      recorded.name = item.name.trim();
    acceptCandidate(
      {
        bucket,
        order: index,
        amount: recorded.amount ?? null,
        kind: "pricing",
        quote,
        record: "scale",
        source: path,
        recorded: Object.keys(recorded).length ? recorded : null,
        citation: {
          url,
          fetched_at: item.fetched_at,
        },
      },
      {
        targetName: identity?.targetName,
        urls: [...(identity?.urls ?? []), url],
        category: identity?.category,
        texts: [quote, recorded.name],
      },
      path,
      skipped,
      candidates,
      target,
    );
  });
}

function takePick(value, path, skipped, candidates, target) {
  const error = pickError(value);
  if (error) {
    skipped.push({ target: path, reason: error });
    return;
  }
  if (value.verdict !== "build") {
    skipped.push({
      target: path,
      reason: `verdict is ${value.verdict}. The pick was not accepted.`,
      quote: oneLine(value.reason),
    });
    return;
  }
  const quote = oneLine(value.reason);
  const sourceUrl = firstUrl(value.url, value.source_url, value.citation?.url);
  acceptCandidate(
    {
      bucket: "pick",
      order: 0,
      kind: "feature",
      quote,
      record: "pick",
      source: path,
      angle: oneLine(value.angle),
      citation: { url: sourceUrl, fetched_at: value.date },
    },
    {
      targetName: value.target_name || value.target,
      urls: [sourceUrl],
      category: value.category,
      texts: [quote, value.angle, value.target_name, value.target],
    },
    path,
    skipped,
    candidates,
    target,
  );
}

function pickError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "must be an object";
  if (typeof value.agent !== "string" || !value.agent.trim())
    return "agent must be a non-empty string";
  if (typeof value.id !== "string" || !value.id.trim())
    return "id must be a non-empty string";
  if (!["build", "skip", "maybe"].includes(value.verdict))
    return "verdict must be build, skip, or maybe";
  if (typeof value.reason !== "string" || !value.reason.trim())
    return "reason must be a non-empty string";
  if (typeof value.angle !== "string" || !value.angle.trim())
    return "angle must be a non-empty string";
  if (typeof value.date !== "string" || Number.isNaN(Date.parse(value.date)))
    return "date must be a date-time string";
  return null;
}

function looksLikePick(value) {
  return Boolean(value && typeof value === "object" && "verdict" in value);
}

function rank(candidates, target) {
  const order = { wtp: 0, pricing: 1, scout: 2, pick: 3 };
  const sorted = [...candidates].sort((left, right) => {
    const bucket = order[left.bucket] - order[right.bucket];
    if (bucket !== 0) return bucket;
    if (left.bucket === "wtp") {
      const leftAmount = Number(left.amount);
      const rightAmount = Number(right.amount);
      const leftOk = Number.isFinite(leftAmount);
      const rightOk = Number.isFinite(rightAmount);
      if (leftOk && rightOk && leftAmount !== rightAmount)
        return rightAmount - leftAmount;
    }
    return left.order - right.order;
  });
  const seen = new Set();
  const items = [];
  for (const item of sorted) {
    if (seen.has(item.quote)) continue;
    seen.add(item.quote);
    items.push({
      id: improvementId(item),
      rank: items.length + 1,
      kind: item.kind,
      name: humanName(item, target),
      quote: item.quote,
      record: item.record,
      source: item.source,
      citation: item.citation,
      recorded: item.recorded ?? null,
      angle: item.angle ?? null,
      accepted: true,
      unsourced: false,
      mark: "improvement",
    });
  }
  return items;
}

function improvementId(item) {
  const digest = createHash("sha256")
    .update(`${item.record}\n${item.source}\n${item.quote}`)
    .digest("hex")
    .slice(0, 12);
  return `improve:${digest}`;
}

function featureFrom(item, readAt, target) {
  const quote = item.quote.slice(0, 160);
  const name = item.name || humanName(item, target);
  const fetched = normalizeDateTime(item.citation?.fetched_at, readAt);
  return {
    id: `feature:${slug(name)}`,
    name,
    detail: "Cited improvement.",
    origin: "improvement",
    quote: { text: quote, attributed_quote: true },
    citations: [
      {
        url: item.citation.url,
        fetched_at: fetched,
        role: item.record,
      },
    ],
  };
}

function acceptCandidate(
  candidate,
  identity,
  path,
  skipped,
  candidates,
  target,
) {
  if (!matchesTarget(target, identity)) {
    skipped.push({
      target: path,
      reason:
        "The record does not match the target or its category, so it was not accepted.",
      quote: candidate.quote,
    });
    return;
  }
  const url = httpUrl(candidate.citation?.url);
  if (!url) {
    skipped.push({
      target: path,
      reason:
        "The record has no source URL. It was marked unsourced and excluded.",
      unsourced: true,
      quote: candidate.quote,
    });
    return;
  }
  candidate.citation = {
    url,
    fetched_at: normalizeDateTime(candidate.citation?.fetched_at, null),
  };
  candidates.push(candidate);
}

function matchesTarget(target, identity) {
  if (!target) return true;
  const name = oneLine(target.name);
  const hosts = new Set();
  for (const url of target.urls ?? []) {
    const host = hostOf(url);
    if (host) hosts.add(host);
  }
  for (const url of identity.urls ?? []) {
    const host = hostOf(url);
    if (host && hosts.has(host)) return true;
  }
  if (name.length >= 3) {
    const needle = name.toLowerCase();
    const haystacks = [identity.targetName, ...(identity.texts ?? [])];
    if (
      haystacks.some((value) => oneLine(value).toLowerCase().includes(needle))
    )
      return true;
  }
  const left = oneLine(identity.category).toLowerCase();
  const right = oneLine(target.category).toLowerCase();
  return Boolean(left && right && left === right);
}

function humanName(item, target) {
  const brand = oneLine(target?.name);
  const usable = (value) => {
    const line = oneLine(value);
    if (!line || line === item.quote || line.length > 80) return null;
    if (brand.length >= 3 && line.toLowerCase().includes(brand.toLowerCase()))
      return null;
    return line;
  };
  return (
    usable(item.angle) ||
    usable(item.recorded?.name) ||
    usable(item.quote.split(/[.!?]/u)[0].split(/\s+/u).slice(0, 4).join(" ")) ||
    (item.kind === "pricing"
      ? "Pricing change"
      : item.kind === "ux"
        ? "Interface change"
        : item.kind === "complaint"
          ? "Support change"
          : "Added behavior")
  );
}

function firstUrl(...values) {
  for (const value of values) {
    const url = httpUrl(value);
    if (url) return url;
  }
  return null;
}

function httpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function hostOf(value) {
  const url = httpUrl(value);
  if (!url) return null;
  return new URL(url).host.toLowerCase();
}

export function normalizeDateTime(value, fallback = null) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const text = value.trim();
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/u.exec(text);
  const parsed = Date.parse(dateOnly ? `${text}T00:00:00.000Z` : text);
  if (Number.isNaN(parsed)) return fallback;
  return new Date(parsed).toISOString();
}

function oneLine(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function stamp(now) {
  const date = now instanceof Date ? now : new Date(now);
  return date.toISOString();
}
