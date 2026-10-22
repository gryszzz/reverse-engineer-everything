function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasApplicationGraph(record) {
  const graph = record?.normalized_result?.graph;
  return (
    isObject(graph) && Array.isArray(graph.nodes) && Array.isArray(graph.edges)
  );
}

function resourceLabel(resources, index) {
  const resource = resources?.[index];
  if (!resource) return `resource ${index}`;
  const part = (identity) => {
    if (!identity || typeof identity !== "object") return "unrecorded";
    if (identity.kind === "name") return identity.name;
    if (identity.kind === "id") return String(identity.id);
    return "unrecorded";
  };
  return `resource ${index} type ${part(resource.type)} name ${part(resource.name)}`;
}

function peRelationships(result) {
  const resources = Array.isArray(result?.resources) ? result.resources : [];
  const nodes = new Map();
  const edges = [];
  const groups = Array.isArray(result?.icon_groups) ? result.icon_groups : [];
  for (const group of groups) {
    if (!Number.isInteger(group?.resource_index)) continue;
    const sourceId = `resource:${group.resource_index}`;
    const source = {
      id: sourceId,
      label: resourceLabel(resources, group.resource_index),
      group: "icon-group",
      present: Boolean(resources[group.resource_index]),
    };
    nodes.set(sourceId, source);
    const images = Array.isArray(group.images) ? group.images : [];
    for (const [imageIndex, image] of images.entries()) {
      const candidates = Array.isArray(image?.candidate_resource_indices)
        ? image.candidate_resource_indices
        : [];
      for (const candidate of candidates) {
        if (!Number.isInteger(candidate)) continue;
        const targetId = `resource:${candidate}`;
        const target = {
          id: targetId,
          label: resourceLabel(resources, candidate),
          group: "resource",
          present: Boolean(resources[candidate]),
        };
        nodes.set(targetId, target);
        edges.push({
          edge_id: `icon:${group.resource_index}:${imageIndex}:${candidate}`,
          relation: "candidate_resource_indices",
          source,
          target,
          location: {
            path: `normalized_result.icon_groups[${groups.indexOf(group)}].images[${imageIndex}].candidate_resource_indices`,
          },
          state: "recorded",
          confidence: "derived",
          authority: "shipped-artifact",
          basis: "derived",
          interpretation:
            "Icon candidate recorded on the PE resource Evidence. Language fallback and image decoding were not observed.",
          limitations: [],
        });
      }
    }
  }
  return { nodes: [...nodes.values()], edges };
}

function recordedRelationships(record) {
  if (record?.operation === "inspect_pe_resources")
    return peRelationships(record.normalized_result);
  return { nodes: [], edges: [] };
}

function matches(edge, find) {
  if (!find) return true;
  return [edge.edge_id, edge.relation, edge.source.label, edge.target.label]
    .join("\n")
    .toLowerCase()
    .includes(find);
}

function providerNote(record) {
  const id = record?.provider?.id ?? "unrecorded";
  const operation = record?.operation ?? "unrecorded";
  return `Provider ${id}, operation ${operation}. The studio copies relationships stored on this Evidence record and does not add any.`;
}

/** Evidence window for a record that has no JavaScript application graph. */
export function projectEngineEvidence(record, { find = "", limit = 12 } = {}) {
  const normalized = find.trim().toLowerCase();
  const recorded = recordedRelationships(record);
  const matched = recorded.edges.filter((edge) => matches(edge, normalized));
  const edges = matched.slice(0, limit);
  return {
    kind: "engine-record",
    status: "saved-engine-evidence",
    evidence_id: record?.evidence_id ?? null,
    provider: record?.provider ?? null,
    operation: record?.operation ?? null,
    find,
    matching: matched.length,
    displayed: edges.length,
    truncated: matched.length > edges.length,
    edges,
    graph_note:
      recorded.edges.length === 0
        ? "This Evidence record has no relationship list the studio knows how to project."
        : "Relationships below are fields on the engine Evidence, not a new analysis.",
  };
}

/** Graph window with the same recorded relationships, or an empty window. */
export function projectEngineGraph(record, { find = "", limit = 80 } = {}) {
  const view = projectEngineEvidence(record, { find, limit });
  const nodeIds = new Set();
  for (const edge of view.edges) {
    nodeIds.add(edge.source.id);
    nodeIds.add(edge.target.id);
  }
  const recorded = recordedRelationships(record);
  return {
    graph: "engine-record",
    operation: record?.operation ?? null,
    provider: record?.provider ?? null,
    evidence_id: record?.evidence_id ?? null,
    total_nodes: recorded.nodes.length,
    total_edges: recorded.edges.length,
    matching: view.matching,
    displayed: view.displayed,
    truncated: view.truncated,
    offset: 0,
    nodes: recorded.nodes.filter((node) => nodeIds.has(node.id)),
    edges: view.edges,
    execution_note: providerNote(record),
  };
}
