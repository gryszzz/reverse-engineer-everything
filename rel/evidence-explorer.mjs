import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { summarizeEvidence } from "./evidence-summary.mjs";

export const MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;
const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const string = (v) =>
  typeof v === "string" || typeof v === "number" ? String(v) : null;
const nodeLabels = (node) => {
  const identity = node.identity;
  if (identity?.strategy === "canonical-path") return [identity.path];
  if (identity?.strategy === "source-map-original")
    return [identity.original_source];
  return [
    ...new Set(
      (node.observations ?? []).flatMap((observation) => {
        const path = observation.properties?.path;
        return typeof path === "string"
          ? [path]
          : typeof observation.label === "string"
            ? [observation.label]
            : [];
      }),
    ),
  ];
};
const semanticNodeLabels = (node) =>
  [node.label, node.kind]
    .filter((label) => typeof label === "string" && label !== "")
    .filter((label, index, labels) => labels.indexOf(label) === index);
const limitText = (v) =>
  String(v ?? "not provided")
    .replaceAll(/[\r\n|]/gu, " ")
    .slice(0, 240);
const semanticTerms = (value) => {
  const text = String(value ?? "");
  const rawTerms = text.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? [];
  const identifierTerms =
    text
      .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}_$]+/gu) ?? [];
  return new Set([...rawTerms, ...identifierTerms]);
};
const semanticCoverageSummary = (coverage) => {
  if (!isObject(coverage)) return null;
  const families = Array.isArray(coverage.families)
    ? coverage.families
        .filter(isObject)
        .slice(0, 40)
        .map((family) => ({
          family: string(family.family) ?? "unknown",
          status: string(family.status) ?? "unknown",
          retained_relations: Number.isSafeInteger(family.retained_relations)
            ? family.retained_relations
            : null,
          omitted_relations: Number.isSafeInteger(family.omitted_relations)
            ? family.omitted_relations
            : null,
          unknown_count: Number.isSafeInteger(family.unknown_count)
            ? family.unknown_count
            : Array.isArray(family.unknown_ids)
              ? family.unknown_ids.length
              : null,
        }))
    : [];
  const limits = Array.isArray(coverage.limits)
    ? coverage.limits.filter((item) => typeof item === "string").slice(0, 12)
    : [];
  return {
    status: string(coverage.status) ?? "unknown",
    truncated:
      typeof coverage.truncated === "boolean" ? coverage.truncated : null,
    omitted_nodes: Number.isSafeInteger(coverage.omitted_nodes)
      ? coverage.omitted_nodes
      : null,
    omitted_relations: Number.isSafeInteger(coverage.omitted_relations)
      ? coverage.omitted_relations
      : null,
    families,
    omitted_family_count: Math.max(
      0,
      (Array.isArray(coverage.families) ? coverage.families.length : 0) -
        families.length,
    ),
    limits,
    omitted_limit_count: Math.max(
      0,
      (Array.isArray(coverage.limits) ? coverage.limits.length : 0) -
        limits.length,
    ),
  };
};

export function exploreEvidence(record, { find = "", limit = 12 } = {}) {
  if (typeof find !== "string" || find.length > 160)
    throw new Error("The filter must be at most 160 characters of text.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 40)
    throw new Error("The relationship limit must be between 1 and 40.");
  // The presentation checks reject error-only output, mismatched semantic graphs,
  // or missing Evidence identities. This is still not a digest revalidation.
  const summary = summarizeEvidence(record);
  const graph = record.normalized_result.graph;
  const byId = new Map(
    graph.nodes.filter(isObject).map((node) => [node.node_id, node]),
  );
  const resolveEndpoint = (id) => {
    const key = string(id);
    if (key === null)
      throw new Error("Missing canonical graph endpoint identifier.");
    const node = byId.get(key);
    const labels = node ? nodeLabels(node) : [];
    return {
      id: key,
      label: labels.length ? labels.join(" / ") : key,
      labels,
    };
  };
  const edges = [];
  const normalizedFind = find.trim().toLowerCase();
  let matching = 0;
  for (const edge of graph.edges) {
    if (!isObject(edge)) continue;
    const source = resolveEndpoint(edge.source_node_id);
    const target = resolveEndpoint(edge.target_node_id);
    if (!isObject(edge.evidence))
      throw new Error("Missing relationship Evidence.");
    const rawLocation =
      edge.evidence.location?.available === true
        ? edge.evidence.location.value
        : null;
    const entry = {
      edge_id: string(edge.edge_id),
      relation: string(edge.relation) ?? "unknown",
      source,
      target,
      location: rawLocation === null ? null : JSON.stringify(rawLocation),
      state: string(edge.evidence.state),
      confidence: string(edge.evidence.confidence),
      authority: string(edge.evidence.authority),
      coverage: edge.evidence.coverage ?? null,
      limitations: Array.isArray(edge.evidence.limitations)
        ? edge.evidence.limitations.filter((item) => typeof item === "string")
        : [],
    };
    if (normalizedFind) {
      const searchableText = [
        entry.edge_id,
        entry.relation,
        ...entry.source.labels,
        entry.source.id,
        ...entry.target.labels,
        entry.target.id,
        entry.location,
        entry.state,
        entry.confidence,
        entry.authority,
        entry.coverage === null ? null : JSON.stringify(entry.coverage),
        ...entry.limitations,
      ]
        .filter((value) => typeof value === "string")
        .join("\n")
        .toLowerCase();
      if (!searchableText.includes(normalizedFind)) continue;
    }
    matching += 1;
    if (edges.length < limit) edges.push(entry);
  }
  return {
    status: "saved-static-evidence-not-runtime-proof",
    evidence_id: summary.evidence_id,
    artifact_sha256: summary.artifact_sha256,
    counts: summary.counts,
    graph_coverage: summary.graph_coverage,
    semantic_coverage: summary.semantic_coverage,
    limitations: summary.limitations,
    find,
    matching,
    displayed: edges.length,
    truncated: matching > edges.length,
    edges,
  };
}

/** Build a reusable search over one saved semantic graph and its Evidence contexts. */
export function createSemanticEvidenceSearcher(record) {
  const summary = summarizeEvidence(record);
  const graph = record.normalized_result.semantic_graph;
  const available =
    isObject(graph) &&
    Array.isArray(graph.nodes) &&
    Array.isArray(graph.relations);
  const validateOptions = (find, limit) => {
    if (typeof find !== "string" || find.length > 160)
      throw new Error("The filter must be at most 160 characters of text.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 40)
      throw new Error("The relationship limit must be between 1 and 40.");
  };
  if (!available)
    return ({ find = "", limit = 12 } = {}) => {
      validateOptions(find, limit);
      return {
        status: "semantic-graph-unavailable",
        evidence_id: summary.evidence_id,
        artifact_sha256: summary.artifact_sha256,
        semantic_graph_id: string(graph?.graph_id),
        counts: { nodes: null, relations: null },
        coverage: semanticCoverageSummary(
          graph?.coverage ?? summary.semantic_coverage,
        ),
        find,
        matching: null,
        displayed: 0,
        truncated: false,
        relations: [],
      };
    };
  const byId = new Map(
    graph.nodes.filter(isObject).map((node) => [string(node.node_id), node]),
  );
  const contexts = new Map(
    (Array.isArray(graph.evidence_contexts) ? graph.evidence_contexts : [])
      .filter(isObject)
      .map((context) => [string(context.context_id), context]),
  );
  const resolveEndpoint = (id) => {
    const key = string(id);
    if (key === null)
      throw new Error("Missing canonical semantic graph endpoint identifier.");
    const node = byId.get(key);
    const labels = node ? semanticNodeLabels(node) : [];
    return {
      id: key,
      label: labels[0] ?? key,
      labels,
      kind: string(node?.kind),
    };
  };
  const indexedRelations = [];
  for (const relation of graph.relations) {
    if (!isObject(relation)) continue;
    if (!isObject(relation.evidence))
      throw new Error("Missing semantic relationship Evidence.");
    const source = resolveEndpoint(relation.source_node_id);
    const target = resolveEndpoint(relation.target_node_id);
    const rawLocation =
      relation.evidence.location?.available === true
        ? relation.evidence.location.value
        : null;
    const context = contexts.get(string(relation.evidence.context_id)) ?? {};
    const entry = {
      relation_id: string(relation.relation_id),
      relation: string(relation.relation) ?? "unknown",
      source,
      target,
      resolution: string(relation.resolution) ?? "unknown",
      location: rawLocation === null ? null : JSON.stringify(rawLocation),
      evidence_context_id: string(relation.evidence.context_id),
      state: string(context.state ?? relation.evidence.state),
      confidence: string(context.confidence ?? relation.evidence.confidence),
      authority: string(context.authority ?? relation.evidence.authority),
      extractor: string(context.extractor?.name),
      limitations: Array.isArray(context.limitations)
        ? context.limitations.filter((item) => typeof item === "string")
        : [],
    };
    const searchableText = [
      entry.relation_id,
      entry.relation,
      entry.resolution,
      ...entry.source.labels,
      entry.source.id,
      ...entry.target.labels,
      entry.target.id,
      entry.location,
      entry.state,
      entry.confidence,
      entry.authority,
      entry.extractor,
      ...entry.limitations,
    ]
      .filter((value) => typeof value === "string")
      .join("\n");
    indexedRelations.push({
      entry,
      searchableTerms: semanticTerms(searchableText),
    });
  }
  return ({ find = "", limit = 12 } = {}) => {
    validateOptions(find, limit);
    const queryTerms = semanticTerms(find);
    const relations = [];
    let matching = 0;
    for (const indexed of indexedRelations) {
      if ([...queryTerms].some((term) => !indexed.searchableTerms.has(term)))
        continue;
      matching += 1;
      if (relations.length < limit) relations.push(indexed.entry);
    }
    return {
      status: "saved-static-semantic-evidence-not-runtime-proof",
      evidence_id: summary.evidence_id,
      artifact_sha256: summary.artifact_sha256,
      semantic_graph_id: string(graph.graph_id),
      counts: { nodes: graph.nodes.length, relations: graph.relations.length },
      coverage: semanticCoverageSummary(
        graph.coverage ?? summary.semantic_coverage,
      ),
      find,
      matching,
      displayed: relations.length,
      truncated: matching > relations.length,
      relations,
    };
  };
}

/** Search saved semantic relations separately from the structural application graph. */
export function exploreSemanticEvidence(record, options) {
  return createSemanticEvidenceSearcher(record)(options);
}

export function asText(result) {
  const out = [
    "REE / Saved Evidence Explorer",
    "Evidence: " + result.evidence_id,
    "Artifact: " + result.artifact_sha256,
    "Recorded graph: " +
      result.counts.nodes +
      " nodes, " +
      result.counts.edges +
      " edges",
    "Matching: " + result.matching + ", displayed: " + result.displayed,
    "",
  ];
  for (const [i, e] of result.edges.entries()) {
    out.push(
      String(i + 1) +
        ". " +
        limitText(e.source.label) +
        " --[" +
        limitText(e.relation) +
        "]--> " +
        limitText(e.target.label),
      "   Source location: " + limitText(e.location),
      "   State / confidence / authority: " +
        [e.state, e.confidence, e.authority].map(limitText).join(" / "),
    );
  }
  if (!result.edges.length)
    out.push("No recorded relationships match the query.");
  if (result.truncated)
    out.push(
      "Display truncated. Narrow --find or increase --limit (maximum 40).",
    );
  out.push(
    "",
    "Evidence boundaries:",
    "- The saved graph describes static relationships, not runtime execution.",
    "- Missing source locations or labels are not guessed.",
    "- Original analyzer output is retained; this projection does not independently verify digests.",
    "- Structural coverage does not imply complete semantic understanding.",
    ...result.limitations.map((l) => "- " + limitText(l)),
  );
  return out.join("\n");
}

const semanticLocationText = (location) => {
  if (typeof location !== "string") return "location not provided";
  try {
    const parsed = JSON.parse(location);
    if (typeof parsed.source === "string") {
      const line = Number.isSafeInteger(parsed.start?.line)
        ? ":" + parsed.start.line
        : "";
      const column = Number.isSafeInteger(parsed.start?.column)
        ? ":" + parsed.start.column
        : "";
      return parsed.source + line + column;
    }
    if (typeof parsed.path === "string") return parsed.path;
  } catch {
    return location;
  }
  return location;
};

export function asSemanticText(result) {
  const out = [
    "REE / Saved Semantic Evidence Explorer",
    "Evidence: " + result.evidence_id,
    "Artifact: " + result.artifact_sha256,
    "Semantic graph: " +
      (result.semantic_graph_id ?? "not identified") +
      " (" +
      (result.counts.nodes ?? "unknown") +
      " nodes, " +
      (result.counts.relations ?? "unknown") +
      " relations)",
    "Coverage: " + limitText(result.coverage?.status),
    "Matching: " +
      (result.matching ?? "unknown") +
      ", displayed: " +
      result.displayed,
    "",
  ];
  if (result.status === "semantic-graph-unavailable") {
    out.push("This Evidence record does not expose semantic relations.");
  } else {
    for (const [i, relation] of result.relations.entries()) {
      out.push(
        String(i + 1) +
          ". " +
          limitText(relation.source.label) +
          " --[" +
          limitText(relation.relation) +
          "]--> " +
          limitText(relation.target.label),
        "   Source location: " +
          limitText(semanticLocationText(relation.location)),
        "   Resolution / state / confidence / authority: " +
          [
            relation.resolution,
            relation.state,
            relation.confidence,
            relation.authority,
          ]
            .map(limitText)
            .join(" / "),
        "   Relation / context: " +
          limitText(relation.relation_id) +
          " / " +
          limitText(relation.evidence_context_id),
      );
    }
    if (result.relations.length === 0)
      out.push("No recorded semantic relations match the query.");
  }
  if (result.truncated)
    out.push(
      "Display truncated. Narrow --find or increase --limit (maximum 40).",
    );
  out.push(
    "",
    "Evidence boundaries:",
    "- Semantic relations are static syntax-derived evidence; they do not establish execution or behavior.",
    "- Candidate or resolved relations retain the analyzer's scope and uncertainty.",
    "- This view searches saved relation labels and metadata, not source text or every literal value.",
    "- Original analyzer output is retained; this projection does not independently verify digests.",
  );
  return out.join("\n");
}

export function asDot(result) {
  const quote = (v) =>
    '"' +
    String(v ?? "?")
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll(/[\r\n]/gu, " ") +
    '"';
  const lines = [
    "digraph REE {",
    '  graph [label="Saved REA static relationships (NOT runtime)", labelloc=t];',
    "  rankdir=LR;",
    "  node [shape=box];",
  ];
  for (const edge of result.edges) {
    const from = edge.source.id ?? "?";
    const to = edge.target.id ?? "?";
    lines.push(
      "  " + quote(from) + " [label=" + quote(edge.source.label) + "];",
      "  " + quote(to) + " [label=" + quote(edge.target.label) + "];",
      "  " +
        quote(from) +
        " -> " +
        quote(to) +
        " [label=" +
        quote(edge.relation) +
        "];",
    );
  }
  return [...lines, "}"].join("\n");
}

const readEvidenceRecord = (path) => {
  if (typeof path !== "string" || !path)
    throw new Error("Supply a saved evidence.json path.");
  const file = resolve(path);
  const meta = statSync(file);
  if (!meta.isFile() || meta.size > MAX_EVIDENCE_FILE_BYTES)
    throw new Error("Evidence must be a regular JSON file of at most 64 MiB.");
  return JSON.parse(readFileSync(file, "utf8"));
};

export function readEvidence(path, options) {
  return exploreEvidence(readEvidenceRecord(path), options);
}

export function readSemanticEvidence(path, options) {
  return exploreSemanticEvidence(readEvidenceRecord(path), options);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    const file = args.shift();
    let find = "";
    let limit = 12;
    let mode = "text";
    let semantic = false;
    while (args.length) {
      const option = args.shift();
      if (option === "--find" && args.length) find = args.shift();
      else if (option === "--limit" && args.length)
        limit = Number(args.shift());
      else if (option === "--semantic") semantic = true;
      else if (option === "--json" && mode === "text") mode = "json";
      else if (option === "--dot" && mode === "text") mode = "dot";
      else throw new Error("Unsupported or conflicting option: " + option);
    }
    if (semantic && mode === "dot")
      throw new Error(
        "DOT output currently supports the application graph only.",
      );
    const result = semantic
      ? readSemanticEvidence(file, { find, limit })
      : readEvidence(file, { find, limit });
    console.log(
      mode === "json"
        ? JSON.stringify(result, null, 2)
        : mode === "dot"
          ? asDot(result)
          : semantic
            ? asSemanticText(result)
            : asText(result),
    );
  } catch (error) {
    console.error("REE Evidence Explorer: " + error.message);
    process.exitCode = 2;
  }
}
