const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value) =>
  typeof value === "string" && value.length > 0 ? value : null;

/** This is a presentation of REA Evidence, NOT an independent validation of its digest. */
export function summarizeEvidence(record) {
  if (!isObject(record)) throw new Error("Expected a JSON Evidence record");
  if (record.error !== undefined)
    throw new Error(`REA returned an error: ${String(record.error)}`);
  if (record.operation !== "analyze_javascript_application") {
    throw new Error(
      `Unexpected Evidence operation: ${String(record.operation)}`,
    );
  }
  const result = record.normalized_result;
  if (
    !isObject(result) ||
    !isObject(result.graph) ||
    !isObject(result.semantic_graph)
  ) {
    throw new Error(
      "Missing REA application or semantic graph; do not report success",
    );
  }
  const graph = result.graph;
  const semantic = result.semantic_graph;
  if (
    !text(record.evidence_id) ||
    !text(graph.graph_id) ||
    !text(result.root_artifact_sha256)
  ) {
    throw new Error("Missing Evidence/graph/artifact identifier");
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error("Graph nodes/edges unavailable");
  }
  if (semantic.application_graph_id !== graph.graph_id) {
    throw new Error("Semantic graph is not bound to application graph");
  }
  if (semantic.root_artifact_sha256 !== result.root_artifact_sha256) {
    throw new Error("Semantic graph does not match source artifact");
  }
  const statistics = isObject(result.statistics) ? result.statistics : {};
  const byKind = {};
  for (const node of graph.nodes) {
    const kind = text(node.kind) ?? "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  const relationships = {};
  for (const edge of graph.edges) {
    const relation = text(edge.relation) ?? "unknown";
    relationships[relation] = (relationships[relation] ?? 0) + 1;
  }
  const seenLimitations = [
    record.limitations,
    result.limitations,
    graph.limitations,
  ]
    .filter(Array.isArray)
    .flat()
    .filter((v) => typeof v === "string");
  return {
    status: "analyzer-evidence-present",
    operation: record.operation,
    evidence_id: record.evidence_id,
    provider: text(record.provider?.id),
    artifact_sha256: result.root_artifact_sha256,
    application_graph_id: graph.graph_id,
    semantic_graph_id: text(semantic.graph_id),
    graph_coverage: graph.coverage ?? null,
    semantic_coverage: semantic.coverage ?? null,
    counts: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      modules: integer(statistics.modules),
      files_parsed: integer(statistics.parsed_javascript_files),
      parse_failures: integer(statistics.parse_failures),
    },
    node_kinds: byKind,
    relationships,
    limitations: [...new Set(seenLimitations)].slice(0, 20),
  };
}

/** Present an engine-produced summary without loading its complete parent graph. */
export function summarizeAnalysisView(record) {
  if (!isObject(record) || record.error !== undefined)
    throw new Error(
      "REA did not return summary Evidence; no report generated.",
    );
  const view = record.normalized_result;
  if (
    record.operation !== "inspect_analysis_view" ||
    !text(record.evidence_id) ||
    !isObject(view) ||
    view.kind !== "summary" ||
    view.parent_operation !== "analyze_javascript_application" ||
    !text(view.parent_evidence_id) ||
    record.parameters?.parent_evidence_id !== view.parent_evidence_id ||
    !record.evidence_links?.includes(view.parent_evidence_id)
  )
    throw new Error("REA summary view was not bound to source Evidence.");
  const summary = view.summary;
  const graph = summary?.graph_summary;
  if (
    !isObject(summary) ||
    !isObject(graph) ||
    !text(graph.application_graph_id) ||
    !text(graph.semantic_graph_id) ||
    integer(graph.nodes) === null ||
    integer(graph.edges) === null ||
    !isObject(graph.node_kinds) ||
    !isObject(graph.relationships) ||
    !isObject(summary.statistics) ||
    !isObject(summary.coverage?.application) ||
    !isObject(summary.coverage?.semantic)
  )
    throw new Error(
      "REA summary lacks graph metadata. Rebuild this fork's runtime.",
    );
  const validCounts = (counts, total) =>
    Object.values(counts).every((count) => integer(count) !== null) &&
    Object.values(counts).reduce((sum, count) => sum + count, 0) === total;
  if (
    !validCounts(graph.node_kinds, graph.nodes) ||
    !validCounts(graph.relationships, graph.edges)
  )
    throw new Error("REA summary graph counts are inconsistent.");
  if (
    !text(summary.root_artifact_sha256) ||
    view.artifact?.sha256 !== summary.root_artifact_sha256
  )
    throw new Error("REA summary does not match its source artifact.");
  if (!Array.isArray(view.limitations) || !Array.isArray(view.unknowns))
    throw new Error("REA summary lacks limitations or unknowns.");
  return {
    status: "analyzer-evidence-present",
    operation: view.parent_operation,
    evidence_id: view.parent_evidence_id,
    view_evidence_id: record.evidence_id,
    projection_provider: text(record.provider?.id),
    artifact_sha256: summary.root_artifact_sha256,
    application_graph_id: graph.application_graph_id,
    semantic_graph_id: graph.semantic_graph_id,
    graph_coverage: summary.coverage.application,
    semantic_coverage: summary.coverage.semantic,
    source_selection: summary.source_selection ?? null,
    counts: {
      nodes: graph.nodes,
      edges: graph.edges,
      modules: integer(summary.statistics.modules),
      files_parsed: integer(summary.statistics.parsed_javascript_files),
      parse_failures: integer(summary.statistics.parse_failures),
    },
    node_kinds: graph.node_kinds,
    relationships: graph.relationships,
    limitations: [
      ...new Set([...(record.limitations ?? []), ...view.limitations]),
    ],
    unknowns: view.unknowns,
  };
}
