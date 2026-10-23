import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { analyzeOutsideIn } from "../outside-in/analyze.mjs";
import { MAX_DOCUMENT_BYTES } from "../outside-in/constants.mjs";
import { extractOpenApi } from "../outside-in/extract-openapi.mjs";
import { classifyUrl, extensionBlocked } from "../outside-in/policy.mjs";

export const INGEST_SCHEMA = "ree.ingest-docs.v1";
export const DOCS_ORIGIN = "https://owned.docs";

const MAX_DEPTH = 4;
const MAX_DOCS = 24;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
]);

const NOTE = [
  "A URL ingests that one public document plus robots.txt.",
  "It does not crawl the rest of the site and it does not log in.",
  "A directory is read locally and does not open the network.",
  "Resources are the endpoint paths in the behavior spec.",
  "The behavior spec has no separate resources field.",
].join(" ");

export class IngestError extends Error {
  constructor(message) {
    super(message);
    this.name = "IngestError";
  }
}

/** Public URL or docs directory to a cited behavior spec. No login. */
export async function ingestPublicDocs({
  input,
  outDir,
  name = null,
  fetchImpl = null,
  sleep = null,
  minIntervalMs = null,
  now = null,
} = {}) {
  if (!input || !outDir)
    throw new IngestError("Use ingest-docs <url-or-dir> --out DIR.");
  const source = classifyInput(input);
  if (source.kind === "url") {
    const result = await analyzeOutsideIn({
      target: {
        name: chosenName(name, source.url.hostname),
        urls: [source.url.href],
      },
      outDir,
      fetchImpl: fetchImpl ?? undefined,
      sleep: sleep ?? undefined,
      minIntervalMs: minIntervalMs ?? undefined,
      now: now ?? undefined,
    });
    const ingest = writeIngest(outDir, {
      source: "url",
      input: source.url.href,
      network: true,
      name: result.spec.target.name,
      documents: documentsFrom(result.spec, null),
      skipped: [],
      spec: result.spec,
    });
    return { ...result, ingest };
  }
  const dir = source.path;
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new IngestError(
      "ingest-docs target must be an http(s) URL or a directory.",
    );
  const { selected, skipped } = selectDocuments(dir);
  if (selected.length === 0)
    throw new IngestError(
      "No OpenAPI, HTML, or Markdown documents were found.",
    );
  const request = requestFromDocuments(
    selected,
    chosenName(name, basename(dir)),
  );
  const result = await analyzeOutsideIn({
    ...request,
    fixture: directoryFixture(dir),
    outDir,
    now: now ?? undefined,
    minIntervalMs: minIntervalMs ?? 0,
    fetchImpl:
      fetchImpl ??
      (async () => {
        throw new Error("directory ingest attempted a network fetch");
      }),
  });
  const ingest = writeIngest(outDir, {
    source: "directory",
    input: dir,
    network: false,
    name: result.spec.target.name,
    documents: documentsFrom(result.spec, dir),
    skipped,
    spec: result.spec,
  });
  return { ...result, ingest };
}

export function documentUrl(relativePosix) {
  const parts = String(relativePosix)
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part));
  return `${DOCS_ORIGIN}/${parts.join("/")}`;
}

/** File bytes keyed by the synthetic URL ingest uses for a docs directory. */
export function ownedDocsBodies(root) {
  const bodies = new Map();
  const base = resolve(root);
  function walk(dir, relBase, depth) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        walk(full, rel, depth + 1);
        continue;
      }
      if (!entry.isFile() || extensionBlocked("/" + rel)) continue;
      bodies.set(documentUrl(rel), readFileSync(full, "utf8"));
    }
  }
  walk(base, "", 0);
  return bodies;
}

export function selectDocuments(root) {
  const selected = [];
  const skipped = [];
  const base = resolve(root);
  function walk(dir, relBase, depth) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push({
        path: relBase || ".",
        reason: "directory could not be read",
      });
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".")) {
        skipped.push({ path: rel, reason: "hidden files are not read" });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name))
          skipped.push({ path: rel, reason: "directory skipped" });
        else if (depth >= MAX_DEPTH)
          skipped.push({ path: rel, reason: "deeper than 4 levels" });
        else walk(join(dir, entry.name), rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      considerFile(join(dir, entry.name), rel, selected, skipped);
    }
  }
  walk(base, "", 0);
  return { selected, skipped };
}

function considerFile(full, rel, selected, skipped) {
  if (rel === "robots.txt") return;
  if (extensionBlocked("/" + rel)) {
    skipped.push({
      path: rel,
      reason: "source or binary filenames are not read",
    });
    return;
  }
  if (statSync(full).size > MAX_DOCUMENT_BYTES) {
    skipped.push({ path: rel, reason: "larger than 512 KiB" });
    return;
  }
  const text = readFileSync(full, "utf8");
  const classified = classifyDocument(rel, text);
  if (!classified) {
    skipped.push({
      path: rel,
      reason: "not an OpenAPI, HTML, or Markdown document",
    });
    return;
  }
  if (selected.length >= MAX_DOCS) {
    skipped.push({ path: rel, reason: "past the 24 document limit" });
    return;
  }
  if (classified.role === "pricing" && selected.some((item) => item.pricing)) {
    skipped.push({
      path: rel,
      reason: "another pricing page was already selected",
    });
    return;
  }
  selected.push({ rel, ...classified });
}

function classifyDocument(rel, text) {
  const lower = rel.toLowerCase();
  if (
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".json")
  ) {
    const api = extractOpenApi(text);
    if (api.error) return null;
    return { role: "docs", kind: "openapi", pricing: false };
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    const pricing = /(^|\/)pricing\.html?$/i.test(lower);
    return {
      role: pricing ? "pricing" : "html",
      kind: null,
      pricing,
    };
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown"))
    return { role: "docs", kind: "sdk-readme", pricing: false };
  return null;
}

function requestFromDocuments(selected, name) {
  const root = selected.find((item) => item.role === "html") ?? selected[0];
  const docs = [];
  let pricingUrl = null;
  for (const item of selected) {
    const url = documentUrl(item.rel);
    if (item === root && item.role !== "pricing") continue;
    if (item.role === "pricing") {
      if (item !== root) pricingUrl = url;
      continue;
    }
    docs.push({ url, kind: item.kind });
  }
  return {
    target: { name, urls: [documentUrl(root.rel)] },
    docs,
    pricingUrl,
  };
}

function directoryFixture(root) {
  const base = resolve(root);
  return {
    reads: [],
    requests: [],
    async respond(url) {
      const parsed = new URL(url);
      if (parsed.origin !== DOCS_ORIGIN) return null;
      const rel = decodeURIComponent(parsed.pathname.replace(/^\/+/u, ""));
      if (!rel || rel.includes("\0")) return null;
      const full = resolve(base, rel);
      const relTo = relative(base, full);
      if (relTo.startsWith("..") || isAbsolute(relTo)) return null;
      if (!existsSync(full) || !statSync(full).isFile()) {
        if (rel === "robots.txt")
          return {
            status: 404,
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: "",
          };
        return null;
      }
      return {
        status: 200,
        headers: { "content-type": contentType(rel) },
        body: readFileSync(full, "utf8"),
      };
    },
  };
}

function contentType(rel) {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm"))
    return "text/html; charset=utf-8";
  if (lower.endsWith(".md") || lower.endsWith(".markdown"))
    return "text/markdown; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml"))
    return "application/yaml; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function documentsFrom(spec, dir) {
  return (spec.sources ?? []).map((source) => ({
    url: source.url,
    role: source.role,
    sha256: source.sha256,
    file: dir ? fileForUrl(source.url) : null,
  }));
}

function fileForUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== DOCS_ORIGIN) return null;
    const rel = decodeURIComponent(parsed.pathname.replace(/^\/+/u, ""));
    return rel || null;
  } catch {
    return null;
  }
}

function resourcesFrom(spec) {
  const byPath = new Map();
  for (const endpoint of spec.api?.endpoints ?? []) {
    if (typeof endpoint.path !== "string" || !endpoint.path.startsWith("/"))
      continue;
    const row = byPath.get(endpoint.path) ?? {
      path: endpoint.path,
      citations: [],
    };
    for (const citation of endpoint.citations ?? []) {
      const known = row.citations.some(
        (item) => item.url === citation.url && item.role === citation.role,
      );
      if (!known) row.citations.push(citation);
    }
    byPath.set(endpoint.path, row);
  }
  return [...byPath.values()];
}

function pricingFrom(spec) {
  return (spec.pricing?.plans ?? []).map((plan) => ({
    name: plan.name ?? null,
    price: plan.price?.display ?? null,
    citations: plan.citations ?? [],
  }));
}

function writeIngest(outDir, record) {
  const ingest = {
    schema_version: INGEST_SCHEMA,
    source: record.source,
    input: record.input,
    network: record.network,
    name: record.name,
    status: record.spec.status,
    documents: record.documents,
    resources: resourcesFrom(record.spec),
    features: (record.spec.features ?? []).map((feature) => ({
      id: feature.id,
      name: feature.name,
      citations: feature.citations ?? [],
    })),
    pricing_tiers: pricingFrom(record.spec),
    skipped: record.skipped,
    note: NOTE,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "ingest.json"),
    JSON.stringify(ingest, null, 2) + "\n",
  );
  return ingest;
}

function classifyInput(input) {
  const text = String(input).trim();
  if (/^https?:\/\//iu.test(text)) {
    const policy = classifyUrl(text);
    if (!policy.ok) throw new IngestError(policy.detail);
    return { kind: "url", url: policy.url };
  }
  return { kind: "directory", path: resolve(text) };
}

function chosenName(name, fallback) {
  const text = typeof name === "string" ? name.trim() : "";
  if (text) return text;
  const plain = String(fallback ?? "").trim();
  if (!plain) throw new IngestError("A document name is required.");
  return plain;
}
