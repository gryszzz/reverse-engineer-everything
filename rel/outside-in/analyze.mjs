import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileCache, createMemoryCache } from "./cache.mjs";
import {
  DEFAULT_CACHE_MAX_AGE_MS,
  LIVE_MIN_INTERVAL_MS,
  MAX_EXPLICIT_URLS,
  QUOTE_MAX,
} from "./constants.mjs";
import { extractByFormat, sniffFormat } from "./extract-docs.mjs";
import { extractFeed } from "./extract-feed.mjs";
import { extractHtml } from "./extract-html.mjs";
import { OutsideInError } from "./errors.mjs";
import { createPublicFetcher } from "./fetch.mjs";
import { loadFixtureDirectory } from "./fixtures.mjs";
import { renderReport } from "./report.mjs";
import { applySimilarityGuard, collectQuotes, guardReport } from "./similarity.mjs";
import {
  addApi,
  addChanges,
  addHtmlExtraction,
  addMarkdown,
  buildSpec,
  citationFor,
  emptyExtraction,
} from "./spec.mjs";
import { applySummarizer, resolveSummarizer, unusedLlm } from "./summarizer.mjs";
import { assertValidBehaviorSpec } from "./validate.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function analyzeOutsideIn(input) {
  const request = normalizeRequest(input);
  const summarizer = resolveSummarizer(request);
  assertOutsideRepo(request.outDir, "output");
  assertOutsideRepo(request.cacheDir, "cache");
  const fixture =
    request.fixture ?? (request.fixtureDir ? loadFixtureDirectory(request.fixtureDir) : null);
  const now = request.now ?? (() => new Date());
  const cacheDir = request.cacheDir ?? (request.outDir ? join(request.outDir, "cache") : null);
  if (cacheDir) assertOutsideRepo(cacheDir, "cache");
  const cache = cacheDir
    ? createFileCache(cacheDir, now, request.cacheMaxAgeMs)
    : createMemoryCache(now, request.cacheMaxAgeMs);
  const fetcher = createPublicFetcher({
    now,
    sleep: request.sleep,
    minIntervalMs: request.minIntervalMs ?? (fixture ? 0 : LIVE_MIN_INTERVAL_MS),
    fixture,
    fetchImpl:
      request.fetchImpl ??
      (fixture
        ? async () => {
            throw new Error("fixture mode attempted a network fetch");
          }
        : globalThis.fetch),
    cache,
  });
  const { documents, refusals } = await collect(fetcher, request);
  const bundle = emptyExtraction();
  for (const doc of documents) extractDocument(doc, bundle);
  const spec = buildSpec({
    request,
    documents,
    refusals,
    bundle,
    generatedAt: now().toISOString(),
    llm: unusedLlm(),
    findings: [],
  });
  spec.llm = await applySummarizer(summarizer, spec);
  const bodies = uniqueBodies(documents);
  const findings = applySimilarityGuard(spec, bodies);
  spec.similarity.findings = findings;
  spec.similarity.flagged = findings.length > 0;
  let report = renderReport(spec);
  const guarded = guardReport(report, bodies, {}, collectQuotes(spec));
  if (guarded.findings.length > 0) {
    spec.similarity.findings = [...findings, ...guarded.findings];
    spec.similarity.flagged = true;
    report = guarded.report;
  }
  assertValidBehaviorSpec(spec);
  if (request.outDir) {
    mkdirSync(request.outDir, { recursive: true });
    writeFileSync(join(request.outDir, "behavior-spec.json"), JSON.stringify(spec, null, 2) + "\n");
    writeFileSync(join(request.outDir, "OUTSIDE_IN_REPORT.md"), report);
  }
  return {
    spec,
    report,
    exitCode: spec.status === "refused" ? 3 : 0,
    fetches: fetcher.fetches,
    fixtureReads: fixture?.reads ?? [],
  };
}

export function normalizeRequest(input) {
  const target = input.target ?? { name: input.name, urls: input.urls };
  const name = typeof target?.name === "string" ? target.name.trim() : "";
  const urls = target?.urls ?? [];
  if (!name) throw new OutsideInError("target.name is required.", "USAGE");
  if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== "string"))
    throw new OutsideInError("target.urls must include at least one URL.", "USAGE");
  const docs = (input.docs ?? []).map(normalizeDoc);
  const reviewUrls = input.reviewUrls ?? input.review_urls ?? [];
  if (!Array.isArray(reviewUrls))
    throw new OutsideInError("review_urls must be an array.", "USAGE");
  const pricingUrl = input.pricingUrl ?? input.pricing_url ?? null;
  const changelogUrl = input.changelogUrl ?? input.changelog_url ?? null;
  const count =
    urls.length + docs.length + reviewUrls.length + (pricingUrl ? 1 : 0) + (changelogUrl ? 1 : 0);
  if (count > MAX_EXPLICIT_URLS) {
    throw new OutsideInError(
      `At most ${MAX_EXPLICIT_URLS} explicit URLs are fetched in one run.`,
      "USAGE",
    );
  }
  return {
    target: { name, urls },
    docs,
    pricingUrl,
    changelogUrl,
    reviewUrls,
    fixtureDir: input.fixtureDir ?? input.fixture_dir ?? null,
    fixture: input.fixture ?? null,
    cacheDir: input.cacheDir ?? input.cache_dir ?? null,
    outDir: input.outDir ?? input.out_dir ?? null,
    minIntervalMs: input.minIntervalMs ?? input.min_interval_ms,
    cacheMaxAgeMs: input.cacheMaxAgeMs ?? input.cache_max_age_ms ?? DEFAULT_CACHE_MAX_AGE_MS,
    now: input.now,
    sleep: input.sleep,
    fetchImpl: input.fetchImpl,
    summarizer: typeof input.summarizer === "object" ? input.summarizer : null,
    summarizerChoice:
      input.summarizerChoice ?? (typeof input.summarizer === "string" ? input.summarizer : null),
  };
}

async function collect(fetcher, request) {
  const jobs = [];
  for (const url of request.target.urls) jobs.push({ url, role: "root", kind: null });
  for (const doc of request.docs) jobs.push({ url: doc.url, role: "docs", kind: doc.kind });
  if (request.pricingUrl) jobs.push({ url: request.pricingUrl, role: "pricing", kind: null });
  if (request.changelogUrl)
    jobs.push({ url: request.changelogUrl, role: "changelog", kind: "feed" });
  for (const url of request.reviewUrls) jobs.push({ url, role: "reviews", kind: null });
  const documents = [];
  const refusals = [];
  const seen = new Map();
  for (const job of jobs) {
    if (!seen.has(job.url)) {
      seen.set(job.url, await fetcher.fetch(job.url, job.role));
    }
    const result = seen.get(job.url);
    if (!result.ok) {
      refusals.push({ ...result.refusal, role: job.role });
      continue;
    }
    documents.push({ ...result.document, role: job.role, kind: job.kind });
  }
  return { documents, refusals };
}

function extractDocument(doc, bundle) {
  const citation = citationFor(doc);
  if (doc.role === "changelog") {
    addChanges(bundle, extractFeed(doc.body, QUOTE_MAX), citation);
    return;
  }
  if (doc.role === "pricing" || doc.role === "reviews" || doc.role === "root") {
    addHtmlExtraction(bundle, extractHtml(doc.body, QUOTE_MAX), citation, [doc.role]);
    if (doc.role !== "root") return;
  }
  if (doc.role === "docs" || doc.role === "root") {
    const format = sniffFormat(doc, doc.kind);
    if (doc.role === "root" && format === "html") return;
    const extracted = extractByFormat(doc, format, QUOTE_MAX);
    if (extracted.api) addApi(bundle, extracted.api, citation);
    else if (extracted.markdown) addMarkdown(bundle, extracted.markdown, citation);
    else if (extracted.feed) addChanges(bundle, extracted.feed, citation);
    else if (format === "html")
      addHtmlExtraction(bundle, extractHtml(doc.body, QUOTE_MAX), citation, ["docs"]);
    else bundle.unknowns.push(`A ${doc.role} document in ${format} format was not recognized.`);
  }
}

function uniqueBodies(documents) {
  const bodies = [];
  const seen = new Set();
  for (const doc of documents) {
    if (seen.has(doc.url)) continue;
    seen.add(doc.url);
    bodies.push({ url: doc.url, body: doc.body });
  }
  return bodies;
}

function normalizeDoc(doc) {
  if (typeof doc === "string") return { url: doc, kind: null };
  if (doc && typeof doc.url === "string") return { url: doc.url, kind: doc.kind ?? null };
  throw new OutsideInError("Each docs entry needs a url.", "USAGE");
}

function assertOutsideRepo(dir, label) {
  if (!dir) return;
  const rel = relative(resolve(repoRoot), resolve(dir));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new OutsideInError(
      `Choose a ${label} directory outside the REE repository. Fetched pages are cached bytes and are not clean-room output.`,
      "USAGE",
    );
  }
}
