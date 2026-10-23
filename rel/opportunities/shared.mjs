import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { listOpportunities } from "./board.mjs";
import { redactUrl } from "../outside-in/policy.mjs";

export const SHARED_BOARD_SCHEMA = "ree.shared.board.v1";
export const SHARED_PICKS_SCHEMA = "ree.shared.picks.v1";
export const SPEC_DRAFT_SCHEMA = "ree.shared.spec-draft.v1";

const VERDICTS = new Set(["build", "skip", "maybe"]);
const OPPORTUNITY_ID = /^opp_[a-f0-9]{16}$/u;
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/giu;

const SHARED_NOTE =
  "Null scores were not stored. REE did not invent them. URL usernames, passwords, and credential query parameters were removed. Guard was not called. Blast was not notified. Scale was not called.";

export function configuredSharedDir(explicit) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const env = process.env.REE_SHARED_BOARD;
  if (typeof env === "string" && env.trim()) return env.trim();
  return null;
}

export function redactExportedText(text) {
  return String(text).replace(URL_IN_TEXT, (match) => redactUrl(match));
}

function redactTree(value) {
  if (typeof value === "string") return redactExportedText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value;
  if (Array.isArray(value)) return value.map((entry) => redactTree(entry));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value))
      out[key] = redactTree(child === undefined ? null : child);
    return out;
  }
  return null;
}

function oneLine(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function scoutBuildability(item) {
  const value = item.listing?.scores?.build_ease;
  return Number.isInteger(value) ? value : null;
}

function whatItDoes(item) {
  if (item.kind === "scout") {
    const category = oneLine(item.record?.category) || "unknown category";
    const weaknesses = (item.record?.weaknesses ?? [])
      .map((entry) => oneLine(entry?.summary))
      .filter(Boolean);
    const weaknessText = weaknesses.length
      ? ` Recorded weaknesses: ${weaknesses.join("; ")}.`
      : "";
    return `Scout category ${category}.${weaknessText} What the product does was not observed.`;
  }
  const features = item.record?.spec_facts?.features ?? [];
  if (!features.length) {
    const count = item.listing?.coverage?.features;
    const counted = Number.isInteger(count)
      ? ` ${count} feature(s) were counted at ingest.`
      : "";
    return `Behavior spec for ${oneLine(item.target_name)}.${counted} Feature names were not stored on this board item, so this export does not invent them.`;
  }
  return `Recorded clean-room features: ${features.map((feature) => oneLine(feature.name)).join("; ")}.`;
}

function findingsSummary(item) {
  const bench = "No bench or accuracy record is stored.";
  if (item.kind === "scout") {
    const build = scoutBuildability(item);
    return [
      `Scout confidence ${item.listing?.confidence}. Score total ${item.listing?.scores?.total}.`,
      build === null
        ? "No buildability score is stored."
        : `Buildability ${build} is Scout scores.build_ease and was not rescored.`,
      bench,
      item.listing?.note ?? "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  const coverage = item.listing?.coverage;
  const status = item.record?.spec_facts?.status;
  return [
    `Features ${coverage?.features ?? "unknown"}. Limitations ${coverage?.limitations ?? "unknown"}. Unknowns ${coverage?.unknowns ?? "unknown"}.`,
    status ? `Spec status ${status}.` : "",
    "No buildability score is stored. Coverage counts are not a buildability score.",
    bench,
    item.listing?.note ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

function marketNotes(item) {
  if (item.kind !== "scout") return null;
  const notes = item.record?.market_signal?.notes;
  return typeof notes === "string" ? notes : "";
}

function publicItem(item) {
  const kind =
    item.kind === "scout" || item.kind === "outside-in" ? item.kind : "unknown";
  return {
    id: item.id,
    title: oneLine(item.target_name),
    what_it_does: whatItDoes(item),
    findings_summary: findingsSummary(item),
    bench_accuracy_confidence: null,
    buildability_score: item.kind === "scout" ? scoutBuildability(item) : null,
    scout_market_notes: marketNotes(item),
    status: "ingested",
    kind,
  };
}

function storedUrls(item) {
  const urls = [];
  if (typeof item.url === "string") urls.push(item.url);
  const targetUrls = item.record?.target?.urls;
  if (Array.isArray(targetUrls)) {
    for (const url of targetUrls) if (typeof url === "string") urls.push(url);
  }
  return [...new Set(urls)];
}

function unknownsFor(item) {
  const facts = item.record?.spec_facts;
  const lines = ["No bench or accuracy record is stored on this opportunity."];
  if (item.kind === "scout") {
    lines.push("This entry is a Scout record, not a behavior spec.");
    lines.push("No product features were observed, so none are listed.");
    if (scoutBuildability(item) !== null)
      lines.push(
        "Buildability is the Scout scores.build_ease integer. REE did not rescore it.",
      );
    return lines;
  }
  if (!facts) {
    lines.push(
      "Feature names and endpoints were not stored on this board item.",
    );
    lines.push(
      "No buildability score is stored. Coverage counts are not a buildability score.",
    );
    return lines;
  }
  if (!facts.features?.length) lines.push("The stored spec lists no features.");
  if ((facts.limitation_count ?? 0) > 0)
    lines.push("Limitation quotes were not copied into this draft.");
  lines.push("Quotes were not copied into this draft.");
  lines.push(
    "No buildability score is stored. Coverage counts are not a buildability score.",
  );
  return lines;
}

function specDraft(item) {
  const facts = item.record?.spec_facts;
  return {
    schema_version: SPEC_DRAFT_SCHEMA,
    opportunity_id: item.id,
    title: oneLine(item.target_name),
    clean_room: true,
    clean_room_statement:
      facts?.clean_room_statement ??
      "Drafted only from facts stored on the Opportunity Board. Original source was not copied. Quotes were not copied.",
    features: (facts?.features ?? []).map((feature) => ({
      id: feature.id ?? null,
      name: feature.name ?? null,
      detail: feature.detail ?? null,
    })),
    endpoints: (facts?.endpoints ?? []).map((endpoint) => ({
      method: endpoint.method ?? null,
      path: endpoint.path ?? null,
      operation_id: endpoint.operation_id ?? null,
      parameters: endpoint.parameters ?? [],
      body: endpoint.body ?? null,
      response_codes: endpoint.response_codes ?? [],
    })),
    unknowns: unknownsFor(item),
    urls: storedUrls(item),
    quotes_copied: false,
  };
}

function reportMarkdown(item, draft) {
  const urls = draft.urls.length
    ? draft.urls.map((url) => `- ${url}`).join("\n")
    : "- No URL was stored.";
  const buildability =
    item.buildability_score === null
      ? "No buildability score is stored."
      : `Score ${item.buildability_score}. For a Scout record this is scores.build_ease and was not rescored.`;
  const bench =
    item.bench_accuracy_confidence === null
      ? "No bench or accuracy record is stored. Nothing was invented."
      : String(item.bench_accuracy_confidence);
  const notes =
    item.scout_market_notes === null
      ? "This entry is not a Scout record."
      : item.scout_market_notes || "(empty)";
  return [
    `# ${item.title}`,
    "",
    `Status: ${item.status}`,
    "",
    "## What it does",
    item.what_it_does,
    "",
    "## Findings",
    item.findings_summary,
    "",
    "## Bench and accuracy",
    bench,
    "",
    "## Buildability",
    buildability,
    "",
    "## Scout market notes",
    notes,
    "",
    "## URLs",
    urls,
    "",
    "## Clean-room draft unknowns",
    ...draft.unknowns.map((line) => `- ${line}`),
    "",
    "Guard was not called. Blast was not notified. Scale was not called.",
    "",
  ].join("\n");
}

function writeText(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : text + "\n");
}

/**
 * Write the Opportunity Board for other agents.
 * Does not copy pipeline pick files, request files, or the process environment.
 * Does not call Guard, Blast, or Scale.
 */
export function exportSharedBoard({ sourceDir, toDir, now = new Date() }) {
  if (resolve(sourceDir) === resolve(toDir))
    throw new Error(
      "The shared folder must be different from the opportunity board directory.",
    );
  const listed = listOpportunities(sourceDir);
  const items = [];
  const findings = [];
  const skipped = [];
  const findingsRoot = join(toDir, "findings");
  rmSync(findingsRoot, { recursive: true, force: true });
  mkdirSync(toDir, { recursive: true });
  for (const item of [...listed.scout, ...listed.specs]) {
    const published = redactTree(publicItem(item));
    const draft = redactTree(specDraft(item));
    items.push(published);
    if (!OPPORTUNITY_ID.test(item.id)) {
      skipped.push(item.id);
      continue;
    }
    const reportName = `findings/${item.id}/report.md`;
    const draftName = `findings/${item.id}/spec-draft.json`;
    writeText(
      join(toDir, reportName),
      redactExportedText(reportMarkdown(published, draft)),
    );
    writeText(join(toDir, draftName), JSON.stringify(draft, null, 2) + "\n");
    findings.push(reportName, draftName);
  }
  const board = {
    schema_version: SHARED_BOARD_SCHEMA,
    exported_at: now.toISOString(),
    items,
    note: SHARED_NOTE,
  };
  writeText(join(toDir, "board.json"), JSON.stringify(board, null, 2) + "\n");
  return {
    schema_version: SHARED_BOARD_SCHEMA,
    exported_at: board.exported_at,
    item_count: items.length,
    findings,
    skipped_ids: skipped,
    dry_run: true,
    called: { guard: false, blast: false, scale: false },
    note: SHARED_NOTE,
  };
}

function agentPickError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "must be an object";
  if (typeof value.agent !== "string" || !value.agent.trim())
    return "agent must be a non-empty string";
  if (typeof value.id !== "string" || !value.id.trim())
    return "id must be a non-empty string";
  if (!VERDICTS.has(value.verdict))
    return "verdict must be build, skip, or maybe";
  if (typeof value.reason !== "string" || !value.reason.trim())
    return "reason must be a non-empty string";
  if (typeof value.angle !== "string" || !value.angle.trim())
    return "angle must be a non-empty string";
  if (typeof value.date !== "string" || Number.isNaN(Date.parse(value.date)))
    return "date must be a date-time string";
  return null;
}

/** Read agent verdict files. Pipeline pick files are rejected, not relabeled. */
export function readSharedPicks(directory) {
  const picks = [];
  const rejected = [];
  const dir = join(directory, "picks");
  if (!existsSync(dir)) return { picks, rejected };
  let names = [];
  try {
    names = readdirSync(dir);
  } catch (error) {
    rejected.push({
      file: "picks",
      reason:
        error instanceof Error ? error.message : "picks could not be read",
    });
    return { picks, rejected };
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      rejected.push({ file: name, reason: "not JSON" });
      continue;
    }
    const reason = agentPickError(parsed);
    if (reason) {
      rejected.push({ file: name, reason });
      continue;
    }
    picks.push({
      agent: parsed.agent,
      id: parsed.id,
      verdict: parsed.verdict,
      reason: parsed.reason,
      angle: parsed.angle,
      date: parsed.date,
    });
  }
  picks.sort(
    (left, right) =>
      left.agent.localeCompare(right.agent) ||
      left.id.localeCompare(right.id) ||
      left.date.localeCompare(right.date),
  );
  return { picks, rejected };
}
