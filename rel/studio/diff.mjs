export function compareSummaries(left, right) {
  const names = new Set([
    ...Object.keys(left?.relationships ?? {}),
    ...Object.keys(right?.relationships ?? {}),
  ]);
  const relationshipDeltas = [];
  for (const relation of [...names].sort()) {
    const leftCount = left?.relationships?.[relation] ?? 0;
    const rightCount = right?.relationships?.[relation] ?? 0;
    if (leftCount !== rightCount)
      relationshipDeltas.push({
        relation,
        left: leftCount,
        right: rightCount,
      });
  }
  return {
    kind: "summary-count-comparison",
    note: "This compares retained summary counts from two static runs. It is not an REA version comparison and it does not explain behavior.",
    left: {
      evidence_id: left?.evidence_id ?? null,
      counts: left?.counts ?? null,
    },
    right: {
      evidence_id: right?.evidence_id ?? null,
      counts: right?.counts ?? null,
    },
    relationship_deltas: relationshipDeltas.slice(0, 40),
    relationship_deltas_omitted: Math.max(0, relationshipDeltas.length - 40),
  };
}

export function applicationEdgeIds(record) {
  const edges = record?.normalized_result?.graph?.edges;
  if (!Array.isArray(edges)) return [];
  return edges
    .map((edge) => edge?.edge_id)
    .filter((id) => typeof id === "string");
}

export function compareEdgeIds(leftIds, rightIds) {
  const left = new Set(leftIds);
  const right = new Set(rightIds);
  const onlyLeft = [...left].filter((id) => !right.has(id)).sort();
  const onlyRight = [...right].filter((id) => !left.has(id)).sort();
  let shared = 0;
  for (const id of left) if (right.has(id)) shared += 1;
  return {
    kind: "edge-id-set-comparison",
    note: "Set difference of recorded application-graph edge ids. An id missing here is not evidence that a behavior is absent.",
    only_left: onlyLeft.slice(0, 40),
    only_right: onlyRight.slice(0, 40),
    only_left_omitted: Math.max(0, onlyLeft.length - 40),
    only_right_omitted: Math.max(0, onlyRight.length - 40),
    shared_count: shared,
  };
}
