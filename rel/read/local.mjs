import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { documentUrl } from "../ingest/docs.mjs";
import { MAX_DOCUMENT_BYTES } from "../outside-in/constants.mjs";
import { extractGraphql } from "../outside-in/extract-graphql.mjs";
import { extractOpenApi } from "../outside-in/extract-openapi.mjs";
import { extractPostman } from "../outside-in/extract-postman.mjs";
import { extensionBlocked } from "../outside-in/policy.mjs";

const MAX_DEPTH = 4;
const MAX_DOCS = 24;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
]);

export function selectProject(root) {
  const selected = [];
  const skipped = [];
  walk(resolve(root), "", 0, selected, skipped);
  return { selected, skipped };
}

function walk(dir, relBase, depth, selected, skipped) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    skipped.push({
      target: relBase || ".",
      reason: "The directory could not be read.",
    });
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.name.startsWith(".")) {
      skipped.push({ target: rel, reason: "Hidden files are not read." });
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name))
        skipped.push({ target: rel, reason: "That directory is skipped." });
      else if (depth >= MAX_DEPTH)
        skipped.push({ target: rel, reason: "Deeper than 4 levels." });
      else walk(join(dir, entry.name), rel, depth + 1, selected, skipped);
      continue;
    }
    if (!entry.isFile()) continue;
    consider(join(dir, entry.name), rel, selected, skipped);
  }
}

function consider(full, rel, selected, skipped) {
  if (rel === "robots.txt") return;
  if (rel === "package.json" || rel.endsWith("/package.json")) {
    skipped.push({
      target: rel,
      reason:
        "package.json supplies the name only. Dependencies are not copied.",
    });
    return;
  }
  const lower = rel.toLowerCase();
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx")
  ) {
    if (!lower.endsWith(".d.ts")) {
      skipped.push({
        target: rel,
        reason: "Implementation source is not copied.",
      });
      return;
    }
  }
  if (extensionBlocked("/" + rel) && !lower.endsWith(".d.ts")) {
    skipped.push({
      target: rel,
      reason: "Source or binary filenames are not read.",
    });
    return;
  }
  if (statSync(full).size > MAX_DOCUMENT_BYTES) {
    skipped.push({ target: rel, reason: "Larger than 512 KiB." });
    return;
  }
  const text = readFileSync(full, "utf8");
  const classified = classifyProjectFile(rel, text);
  if (classified?.bodyKind === "types") {
    if (selected.length >= MAX_DOCS) {
      skipped.push({ target: rel, reason: "Past the 24 document limit." });
      return;
    }
    const names = declarationNames(text);
    if (names.length === 0) {
      skipped.push({
        target: rel,
        reason: "The declaration file had no exported names.",
      });
      return;
    }
    classified.type = "text/markdown; charset=utf-8";
    selected.push({
      rel,
      url: documentUrl(`${rel}.names.md`),
      body: declarationMarkdown(names),
      role: classified.role,
      kind: classified.kind,
      type: classified.type,
    });
    return;
  }
  if (!classified) {
    skipped.push({
      target: rel,
      reason:
        "Not an OpenAPI, Swagger, Postman, GraphQL, HTML, or Markdown document.",
    });
    return;
  }
  if (selected.length >= MAX_DOCS) {
    skipped.push({ target: rel, reason: "Past the 24 document limit." });
    return;
  }
  selected.push({ rel, url: documentUrl(rel), body: text, ...classified });
}

export function classifyProjectFile(rel, text) {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".graphql") || lower.endsWith(".gql")) {
    const api = extractGraphql(text);
    if (api.error) return null;
    return { role: "docs", kind: "graphql", type: "text/plain; charset=utf-8" };
  }
  if (lower.endsWith(".d.ts")) {
    return {
      role: "docs",
      kind: "sdk-readme",
      type: "text/markdown; charset=utf-8",
      bodyKind: "types",
    };
  }
  if (
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".json")
  ) {
    const openapi = extractOpenApi(text);
    if (!openapi.error)
      return {
        role: "docs",
        kind: "openapi",
        type: "application/yaml; charset=utf-8",
      };
    const postman = extractPostman(text);
    if (!postman.error)
      return {
        role: "docs",
        kind: null,
        type: "application/json; charset=utf-8",
      };
    return null;
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    const pricing = /(^|\/)pricing\.html?$/iu.test(lower);
    return {
      role: pricing ? "pricing" : "html",
      kind: null,
      type: "text/html; charset=utf-8",
    };
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown"))
    return {
      role: "docs",
      kind: "sdk-readme",
      type: "text/markdown; charset=utf-8",
    };
  return null;
}

function declarationNames(text) {
  const names = [];
  for (const match of text.matchAll(
    /export\s+(?:declare\s+)?(?:interface|type|class|function|const|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
  )) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function declarationMarkdown(names) {
  const lines = ["# Declaration names", ""];
  for (const name of names) {
    lines.push(
      `## ${name}`,
      "",
      "A declaration name was read. The declaration body was not copied.",
      "",
    );
  }
  return lines.join("\n");
}

export function projectName(root) {
  const manifest = join(resolve(root), "package.json");
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof parsed.name === "string" && parsed.name.trim())
      return parsed.name.trim();
  } catch {
    return null;
  }
  return null;
}

export function relativeInside(root, full) {
  return relative(resolve(root), resolve(full));
}
