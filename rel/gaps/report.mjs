import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GAPS_SCHEMA = "ree.gaps.v1";
export const GAPS_TITLE = "What we can't read or build yet";

const STANDING = [
  "A path with more than one {name} segment is not expanded.",
  "GraphQL operations, workflows, and rate limits are not built.",
  "Original source is not copied. Login bypass and protection bypass are not attempted.",
  "Native, mobile, wasm, managed, firmware, and Java providers are not run from this list.",
];

/**
 * Gaps for one product directory.
 * Counts are not a percentage of the original product.
 * A line that repeats a forbidden name is dropped.
 */
export function collectGaps({ projectDir, readReport = null, forbidden = [] }) {
  const items = [];
  const seen = new Set();
  let hidden = 0;
  const add = (kind, text) => {
    const line = oneLine(text);
    if (!line) return;
    if (forbidden.some((name) => name && line.includes(String(name)))) {
      hidden += 1;
      return;
    }
    if (seen.has(line)) return;
    seen.add(line);
    items.push({ kind, text: line });
  };

  const provenance = readJson(join(projectDir, "provenance.json"));
  for (const item of provenance?.left_out ?? [])
    add("build", featureLine(item));
  for (const limit of provenance?.generator_limits ?? []) add("build", limit);

  const capabilities = readJson(join(projectDir, "capabilities.json"));
  if (!capabilities) {
    add(
      "build",
      "No capability report was saved, so storage, relations, search, accounts, roles, webhooks, pricing, OpenAPI, and deploy are not listed one by one.",
    );
  } else {
    for (const item of capabilities.capabilities ?? []) {
      if (item?.status === "left-out")
        add("build", `${item.id}: ${item.reason ?? "Left out."}`);
    }
  }

  const read =
    readReport ??
    readJson(join(projectDir, "read.json")) ??
    readJson(join(projectDir, "..", "read.json"));
  if (!read) {
    add(
      "read",
      "No read report was saved with this product. Skipped documents are not listed.",
    );
  } else {
    const skipped = Array.isArray(read.skipped) ? read.skipped : [];
    if (skipped.length === 0)
      add("read", "The read report lists no skipped document.");
    const shown = skipped.slice(0, 40);
    for (const item of shown) {
      const target = item?.target || item?.url || item?.path || "an input";
      const reason = item?.reason || "No reason was recorded.";
      add("read", `Skipped ${target}. ${reason}`);
    }
    if (skipped.length > shown.length)
      add(
        "read",
        `${skipped.length - shown.length} more skipped inputs were not listed.`,
      );
  }

  for (const line of STANDING) add("limit", line);
  if (hidden > 0)
    add(
      "limit",
      hidden === 1
        ? "One gap was omitted because its text repeated a recorded name."
        : `${hidden} gaps were omitted because their text repeated a recorded name.`,
    );

  return {
    schema_version: GAPS_SCHEMA,
    title: GAPS_TITLE,
    note: "These lines are gaps. They are not a percentage of the original product.",
    items,
  };
}

export function gapLines(report) {
  return [
    `## ${report.title}`,
    "",
    report.note,
    "",
    ...report.items.map((item) => `- ${item.text}`),
    "",
  ];
}

function featureLine(item) {
  const id = item?.id || "feature";
  const reason = oneLine(item?.reason);
  return reason ? `${id}: ${reason}.` : `${id} was left out.`;
}

function oneLine(value) {
  const text = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return text || null;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
