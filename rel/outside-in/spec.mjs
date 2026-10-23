import {
  CLEAN_ROOM_STATEMENT,
  MODE,
  QUOTE_MAX,
  SCHEMA_VERSION,
  SIMILARITY_THRESHOLD,
  USER_AGENT,
} from "./constants.mjs";
import { slug } from "./text.mjs";

export function emptyExtraction() {
  return {
    features: [],
    workflows: [],
    integrations: [],
    limitations: [],
    plans: [],
    reviews: [],
    changes: [],
    omitted: [],
    api: {
      styles: new Set(),
      servers: [],
      auth: [],
      rate_limits: [],
      endpoints: [],
      unknowns: [],
    },
    unknowns: [],
  };
}

export function citationFor(doc) {
  return { url: doc.url, fetched_at: doc.fetchedAt, role: doc.role };
}

export function addHtmlExtraction(bundle, extracted, citation, roles) {
  const wanted = new Set(roles);
  if (wanted.has("root") || wanted.has("docs")) {
    for (const feature of extracted.features) {
      bundle.features.push({ ...cleanFeature(feature), citations: [citation] });
    }
  }
  if (wanted.has("root")) {
    for (const workflow of extracted.workflows) {
      bundle.workflows.push({ ...workflow, citations: [citation] });
    }
    for (const integration of extracted.integrations) {
      bundle.integrations.push({ ...integration, citations: [citation] });
    }
  }
  if (wanted.has("root") || wanted.has("reviews")) {
    for (const limitation of extracted.limitations) {
      bundle.limitations.push({ ...limitation, citations: [citation] });
    }
    for (const review of extracted.reviews) {
      bundle.limitations.push({ ...review, citations: [citation] });
    }
  }
  if (wanted.has("pricing") || wanted.has("root")) {
    for (const plan of extracted.plans)
      bundle.plans.push({ ...plan, citations: [citation] });
  }
  bundle.unknowns.push(...extracted.unknowns);
}

export function addApi(bundle, api, citation) {
  if (!api || api.error) {
    bundle.api.unknowns.push(api?.error ?? "API document was not recognized.");
    return;
  }
  bundle.api.styles.add(api.style);
  for (const server of api.servers ?? []) {
    bundle.api.servers.push({ url: server, citations: [citation] });
  }
  for (const auth of api.auth ?? []) {
    bundle.api.auth.push({
      name: auth.name,
      style: auth.style,
      placement: auth.placement ?? null,
      citations: [citation],
    });
  }
  for (const limit of api.rateLimits ?? []) {
    bundle.api.rate_limits.push({
      limit: limit.limit,
      window: limit.window ?? null,
      scope: limit.scope,
      citations: [citation],
    });
  }
  for (const endpoint of api.endpoints ?? []) {
    for (const limit of endpoint.rateLimits ?? []) {
      bundle.api.rate_limits.push({
        limit: limit.limit,
        window: limit.window ?? null,
        scope: limit.scope,
        citations: [citation],
      });
    }
    if (endpoint.unresolvedParameters) {
      bundle.api.unknowns.push(
        `${endpoint.unresolvedParameters} parameter refs were not resolved on ${endpoint.method} ${endpoint.path}.`,
      );
    }
    if (endpoint.unresolvedBody) {
      bundle.api.unknowns.push(
        `The JSON request body on ${endpoint.method} ${endpoint.path} could not be read.`,
      );
    }
    const record = {
      method: endpoint.method,
      path: endpoint.path,
      operation_id: endpoint.operationId ?? null,
      parameters: endpoint.parameters ?? [],
      response_codes: endpoint.responseCodes ?? [],
      citations: [citation],
    };
    if (endpoint.body === "json") record.body = "json";
    if (endpoint.summary) record.summary = endpoint.summary;
    bundle.api.endpoints.push(record);
  }
}

export function addMarkdown(bundle, markdown, citation) {
  for (const feature of markdown.features) {
    bundle.features.push({ ...cleanFeature(feature), citations: [citation] });
  }
  if (markdown.codeBlockCount > 0) {
    bundle.omitted.push({
      kind: "fenced-code",
      count: markdown.codeBlockCount,
      citations: [citation],
    });
  }
}

export function addChanges(bundle, feed, citation) {
  if (feed.error) bundle.unknowns.push(feed.error);
  for (const change of feed.changes ?? []) {
    bundle.changes.push({ ...change, citations: [citation] });
  }
  bundle.unknowns.push(...(feed.unknowns ?? []));
}

export function buildSpec({
  request,
  documents,
  refusals,
  bundle,
  generatedAt,
  llm,
  findings,
}) {
  assignIds(bundle.features, "feature");
  assignIds(bundle.workflows, "workflow");
  const usable = documents.length;
  const status =
    usable === 0 ? "refused" : refusals.length > 0 ? "partial" : "completed";
  const styles = [...bundle.api.styles];
  const spec = {
    schema_version: SCHEMA_VERSION,
    clean_room: true,
    clean_room_statement: CLEAN_ROOM_STATEMENT,
    mode: MODE,
    status,
    generated_at: generatedAt,
    target: { name: request.target.name, urls: [...request.target.urls] },
    collector: {
      name: "ree-outside-in",
      version: "1",
      user_agent: USER_AGENT,
      platform: process.platform,
      headless_browser: false,
      authentication: "none",
      source_acquisition: "public-http-get",
    },
    llm,
    sources: documents.map(sourceRecord),
    refusals,
    features: bundle.features,
    workflows: bundle.workflows,
    api: {
      style:
        styles.length === 0
          ? "unknown"
          : styles.length === 1
            ? styles[0]
            : "mixed",
      servers: bundle.api.servers,
      auth: bundle.api.auth,
      rate_limits: bundle.api.rate_limits,
      endpoints: bundle.api.endpoints,
      unknowns: unique(bundle.api.unknowns),
    },
    pricing: { plans: bundle.plans, unknowns: [] },
    integrations: bundle.integrations,
    limitations: bundle.limitations,
    changes: bundle.changes,
    omitted: bundle.omitted,
    similarity: {
      threshold: SIMILARITY_THRESHOLD,
      quote_max: QUOTE_MAX,
      flagged: findings.length > 0,
      findings,
    },
    coverage: coverage(request, documents, refusals, bundle),
  };
  return spec;
}

function cleanFeature(feature) {
  const record = {
    name: feature.name,
    detail: feature.detail,
    origin: feature.origin,
  };
  if (feature.quote) record.quote = feature.quote;
  return record;
}

function sourceRecord(doc) {
  return {
    url: doc.url,
    role: doc.role,
    status: doc.status,
    content_type: doc.contentType || "application/octet-stream",
    fetched_at: doc.fetchedAt,
    sha256: doc.sha256,
    bytes: doc.bytes,
    robots: { allowed: true, rule: doc.robots?.rule ?? null },
    cache: { hit: Boolean(doc.cacheHit) },
  };
}

function assignIds(items, prefix) {
  const used = new Set();
  for (const item of items) {
    const base = `${prefix}:${slug(item.name)}`;
    let id = base;
    let number = 2;
    while (used.has(id)) {
      id = `${base}-${number}`;
      number += 1;
    }
    used.add(id);
    item.id = id;
  }
}

function coverage(request, documents, refusals, bundle) {
  const unknowns = [...bundle.unknowns];
  if (!request.pricingUrl) unknowns.push("No pricing URL was supplied.");
  if (!request.changelogUrl) unknowns.push("No changelog URL was supplied.");
  if (request.reviewUrls.length === 0)
    unknowns.push("No review URLs were supplied.");
  if (request.docs.length === 0)
    unknowns.push(
      "No documentation URL was supplied. The API surface is unknown.",
    );
  if (documents.length === 0) unknowns.push("No public page could be fetched.");
  for (const refusal of refusals) {
    unknowns.push(`Refused ${refusal.role} URL (${refusal.reason}).`);
  }
  return {
    examined_urls: documents.map((doc) => doc.url),
    unknowns: unique(unknowns),
  };
}

function unique(items) {
  return [...new Set(items)];
}
