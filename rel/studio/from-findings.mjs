import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CLEAN_ROOM_STATEMENT,
  QUOTE_MAX,
  SCHEMA_VERSION,
  SIMILARITY_THRESHOLD,
  USER_AGENT,
} from "../outside-in/constants.mjs";
import { evidenceFacts } from "./theater.mjs";

const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/u;

function slug(name) {
  const value = String(name)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 40);
  return value || "fact";
}

function featureId(name, used) {
  const base = `feature:${slug(name)}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  const id = `${base}-${index}`;
  used.add(id);
  return id;
}

/**
 * A behavior spec whose features are names already stored in Evidence.
 * HTTP endpoints are copied only when the record stored a method and a path.
 */
export function draftSpecFromEvidence(
  record,
  { evidencePath, now = new Date() } = {},
) {
  const evidenceId = record?.evidence_id;
  if (!EVIDENCE_ID.test(evidenceId ?? ""))
    throw new Error("Evidence id is missing, so no spec was drafted.");
  const facts = evidenceFacts(record);
  const bytes = evidencePath
    ? readFileSync(evidencePath)
    : Buffer.from(JSON.stringify({ evidence_id: evidenceId }));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const fetchedAt = now.toISOString();
  const url = `evidence:${evidenceId}`;
  const citation = { url, fetched_at: fetchedAt, role: "evidence" };
  const used = new Set();
  const features = [];
  const candidates = facts.functions.filter(
    (item) => typeof item.name === "string" && item.name.length > 0,
  );
  for (const item of candidates.slice(0, 24)) {
    if (item.name.length > 160) continue;
    const where = item.module_path ? `${item.module_path}:` : "";
    features.push({
      id: featureId(item.name, used),
      name: item.name,
      detail:
        `Recovered function ${where}${item.name}. Static Evidence. Not an invented HTTP endpoint.`.slice(
          0,
          240,
        ),
      origin: "evidence-function",
      citations: [citation],
    });
  }
  if (features.length === 0) {
    for (const item of facts.behaviors.slice(0, 24)) {
      const name = `${item.behavior} ${item.detail}`.trim();
      if (!name || name.length > 160) continue;
      features.push({
        id: featureId(name, used),
        name,
        detail:
          "Recovered behavior from static Evidence. No HTTP endpoint was stored with it.".slice(
            0,
            240,
          ),
        origin: "evidence-behavior",
        citations: [citation],
      });
    }
  }
  const endpoints = [];
  for (const item of facts.endpoints.slice(0, 24)) {
    endpoints.push({
      method: item.method,
      path: item.path,
      operation_id: item.operation_id,
      parameters: [],
      response_codes: [],
      citations: [citation],
      ...(item.summary
        ? {
            summary: {
              text: item.summary.slice(0, 160),
              attributed_quote: true,
            },
          }
        : {}),
    });
  }
  const endpointNote =
    endpoints.length === 0
      ? "No HTTP endpoint with a method and a path was stored. None were invented."
      : "Endpoints below are the method and path stored in Evidence.";
  const spec = {
    schema_version: SCHEMA_VERSION,
    clean_room: true,
    clean_room_statement: CLEAN_ROOM_STATEMENT,
    mode: "outside-in",
    status: features.length > 0 ? "completed" : "partial",
    generated_at: fetchedAt,
    target: { name: "Evidence record", urls: [url] },
    collector: {
      name: "ree-outside-in",
      version: "1",
      user_agent: USER_AGENT,
      platform: process.platform,
      headless_browser: false,
      authentication: "none",
      source_acquisition: "public-http-get",
    },
    llm: {
      used: false,
      provider: null,
      ree_remote_calls: "not-performed",
      transport: "none",
      summary: null,
      error: null,
    },
    sources: [
      {
        url,
        role: "evidence",
        status: 0,
        content_type: "application/json",
        fetched_at: fetchedAt,
        sha256,
        bytes: bytes.length,
        robots: { allowed: true, rule: null },
        cache: { hit: false },
      },
    ],
    refusals: [],
    features,
    workflows: [],
    api: {
      style: endpoints.length > 0 ? "unknown" : "unknown",
      servers: [],
      auth: [],
      rate_limits: [],
      endpoints,
      unknowns: [endpointNote],
    },
    pricing: { plans: [], unknowns: [] },
    integrations: [],
    limitations: [],
    changes: [],
    omitted: [],
    similarity: {
      threshold: SIMILARITY_THRESHOLD,
      quote_max: QUOTE_MAX,
      flagged: false,
      findings: [],
    },
    coverage: {
      examined_urls: [url],
      unknowns: [
        "Features were read from a local Evidence record. No public HTTP document was fetched for this draft.",
        "The behavior-spec schema still labels the collector as public-http-get. That label is the schema value, not a fetch.",
      ],
    },
  };
  return {
    spec,
    features: features.map((feature) => ({
      id: feature.id,
      name: feature.name,
      detail: feature.detail,
      evidence_id: evidenceId,
      checked: true,
    })),
    endpoints: endpoints.map((item) => ({
      method: item.method,
      path: item.path,
      operation_id: item.operation_id,
    })),
    note:
      features.length === 0
        ? "This Evidence record has no named function or behavior to put in a spec. No features were invented."
        : `${endpointNote} Checked features stay in the spec. Rebuild gives each feature a data model, write rules, and CRUD routes. A path with one {name} segment gets get, update, and delete on the parent collection. JSON request bodies are accepted. Any other path template is left out. The collector field is the schema value public-http-get; this draft did not fetch a document.`,
  };
}

/** Keep only feature ids that are already in the spec. */
export function specWithFeatures(spec, featureIds) {
  if (!Array.isArray(featureIds)) return spec;
  if (!spec || !Array.isArray(spec.features))
    throw new Error("The spec has no feature list.");
  const known = new Set(spec.features.map((feature) => feature.id));
  for (const id of featureIds) {
    if (typeof id !== "string" || !known.has(id))
      throw new Error(`Feature ${String(id)} is not in this spec.`);
  }
  if (featureIds.length === 0) {
    const endpoints = spec.api?.endpoints;
    if (Array.isArray(endpoints) && endpoints.length > 0)
      return { ...spec, features: [] };
    throw new Error("Select at least one feature.");
  }
  const wanted = new Set(featureIds);
  return {
    ...spec,
    features: spec.features.filter((feature) => wanted.has(feature.id)),
  };
}
