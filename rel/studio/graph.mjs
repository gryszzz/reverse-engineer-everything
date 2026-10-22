const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const asString = (value) =>
  typeof value === "string" || typeof value === "number" ? String(value) : null;

export function relationshipBasis(evidence) {
  const confidence = asString(evidence?.confidence);
  const state = asString(evidence?.state);
  const authority = asString(evidence?.authority) ?? "";
  if (confidence === "observed" || state === "observed") return "observed";
  if (confidence === "derived" || state === "derived") return "derived";
  if (
    confidence === "inferred" ||
    state === "inferred" ||
    authority.toLowerCase().includes("static")
  )
    return "inferred";
  return "unclassified";
}

export function interpretRelationship(operation, basis) {
  if (operation === "analyze_javascript_application") {
    if (basis === "observed")
      return "The Evidence confidence or state says observed. This operation is still static JavaScript analysis; the studio has no separate runtime trace for this relationship.";
    if (basis === "derived")
      return "Derived by a static analysis rule. This is not a captured execution.";
    if (basis === "inferred")
      return "Static inference. This is not a captured execution.";
    return "The record did not classify this relationship as observed, derived, or inferred. It is not treated as a captured execution.";
  }
  return "Shown from the fields stored on this Evidence record.";
}

function nodeLabel(node) {
  const identity = node?.identity;
  if (
    identity?.strategy === "canonical-path" &&
    typeof identity.path === "string"
  )
    return identity.path;
  if (
    identity?.strategy === "source-map-original" &&
    typeof identity.original_source === "string"
  )
    return identity.original_source;
  const labels = [];
  for (const observation of node?.observations ?? []) {
    if (typeof observation?.properties?.path === "string")
      labels.push(observation.properties.path);
    else if (typeof observation?.label === "string")
      labels.push(observation.label);
  }
  if (typeof node?.label === "string" && node.label !== "")
    labels.push(node.label);
  return labels[0] ?? null;
}

function endpoint(byId, id) {
  const key = asString(id);
  if (key === null) throw new Error("Missing graph endpoint identifier.");
  const node = byId.get(key);
  const label = node ? nodeLabel(node) : null;
  return {
    id: key,
    label: label ?? key,
    kind: asString(node?.kind),
    group: label ?? "unlabeled",
    present: Boolean(node),
  };
}

function matchesFind(parts, find) {
  if (!find) return true;
  return parts
    .filter((part) => typeof part === "string")
    .join("\n")
    .toLowerCase()
    .includes(find);
}

function parseQuery(query) {
  const find = query.find ?? "";
  const limit = query.limit ?? 80;
  const offset = query.offset ?? 0;
  if (typeof find !== "string" || find.length > 160)
    throw new Error("The filter must be at most 160 characters.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("The graph limit must be an integer from 1 to 200.");
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000)
    throw new Error("The graph offset is out of range.");
  const relation = query.relation ?? "";
  const basis = query.basis ?? "";
  if (typeof relation !== "string" || relation.length > 80)
    throw new Error("The relation filter is invalid.");
  if (
    basis !== "" &&
    !["observed", "derived", "inferred", "unclassified"].includes(basis)
  )
    throw new Error("The basis filter is invalid.");
  return { find: find.trim().toLowerCase(), limit, offset, relation, basis };
}

function tally(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

/** Project a bounded window of application-graph edges actually stored on Evidence. */
export function projectApplicationGraph(record, query = {}) {
  const options = parseQuery(query);
  const graph = record?.normalized_result?.graph;
  if (
    !isObject(graph) ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  )
    throw new Error(
      "Application graph is not present on this Evidence record.",
    );
  const byId = new Map(
    graph.nodes.filter(isObject).map((node) => [asString(node.node_id), node]),
  );
  const relationCounts = {};
  const basisCounts = {};
  const matched = [];
  for (const edge of graph.edges) {
    if (!isObject(edge) || !isObject(edge.evidence)) continue;
    const basis = relationshipBasis(edge.evidence);
    const relation = asString(edge.relation) ?? "unknown";
    tally(relationCounts, relation);
    tally(basisCounts, basis);
    if (options.relation && relation !== options.relation) continue;
    if (options.basis && basis !== options.basis) continue;
    const source = endpoint(byId, edge.source_node_id);
    const target = endpoint(byId, edge.target_node_id);
    const location =
      edge.evidence.location?.available === true
        ? edge.evidence.location.value
        : null;
    const entry = {
      edge_id: asString(edge.edge_id),
      relation,
      source,
      target,
      location: isObject(location) ? location : null,
      state: asString(edge.evidence.state),
      confidence: asString(edge.evidence.confidence),
      authority: asString(edge.evidence.authority),
      basis,
      interpretation: interpretRelationship(record.operation, basis),
      limitations: Array.isArray(edge.evidence.limitations)
        ? edge.evidence.limitations
            .filter((item) => typeof item === "string")
            .slice(0, 8)
        : [],
    };
    if (
      !matchesFind(
        [
          entry.edge_id,
          entry.relation,
          entry.source.label,
          entry.source.id,
          entry.target.label,
          entry.target.id,
          entry.location ? JSON.stringify(entry.location) : null,
          entry.state,
          entry.confidence,
          entry.authority,
        ],
        options.find,
      )
    )
      continue;
    matched.push(entry);
  }
  const page = matched.slice(options.offset, options.offset + options.limit);
  const nodes = new Map();
  for (const edge of page) {
    nodes.set(edge.source.id, edge.source);
    nodes.set(edge.target.id, edge.target);
  }
  return {
    graph: "application",
    operation: asString(record.operation),
    evidence_id: asString(record.evidence_id),
    graph_id: asString(graph.graph_id),
    coverage: graph.coverage ?? null,
    total_nodes: graph.nodes.length,
    total_edges: graph.edges.length,
    relation_counts: relationCounts,
    basis_counts: basisCounts,
    matching: matched.length,
    offset: options.offset,
    displayed: page.length,
    truncated: options.offset + page.length < matched.length,
    window_nodes: nodes.size,
    omitted_nodes: Math.max(0, graph.nodes.length - nodes.size),
    nodes: [...nodes.values()],
    edges: page,
    execution_note:
      "Edges are copied from the saved application graph. Static inference and derivation are not observed executions. Nodes without an edge in this window are omitted rather than invented.",
  };
}
