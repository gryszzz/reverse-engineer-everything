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

function asList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : null;
}

function setDelta(leftList, rightList) {
  const left = [...new Set(leftList)].sort();
  const right = [...new Set(rightList)].sort();
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  const onlyLeft = left.filter((item) => !rightSet.has(item));
  const onlyRight = right.filter((item) => !leftSet.has(item));
  let shared = 0;
  for (const item of left) if (rightSet.has(item)) shared += 1;
  return {
    status: "compared",
    only_left: onlyLeft.slice(0, 80),
    only_right: onlyRight.slice(0, 80),
    only_left_omitted: Math.max(0, onlyLeft.length - 80),
    only_right_omitted: Math.max(0, onlyRight.length - 80),
    shared_count: shared,
  };
}

function identityList(record, pattern) {
  const nodes = record?.normalized_result?.graph?.nodes;
  if (!Array.isArray(nodes)) return null;
  const found = [];
  let matchedKind = false;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const kind = typeof node.kind === "string" ? node.kind : "";
    if (!pattern.test(kind)) continue;
    matchedKind = true;
    const identity = node.identity;
    const label =
      (identity?.strategy === "canonical-path" &&
      typeof identity.path === "string"
        ? identity.path
        : null) ?? (typeof node.label === "string" ? node.label : null);
    if (label) found.push(label);
  }
  return matchedKind ? found : null;
}

function fileIdentities(record) {
  const nodes = record?.normalized_result?.graph?.nodes;
  if (!Array.isArray(nodes)) return null;
  const found = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const identity = node.identity;
    if (
      identity?.strategy === "canonical-path" &&
      typeof identity.path === "string"
    )
      found.push(identity.path);
    else if (typeof node.label === "string" && node.label.includes("/"))
      found.push(node.label);
  }
  return found;
}

function dimension(left, right, unknownReason) {
  if (left === null || right === null)
    return {
      status: "unknown",
      reason: unknownReason,
      only_left: [],
      only_right: [],
      shared_count: null,
    };
  return setDelta(left, right);
}

/**
 * Compare two caller-built snapshots.
 * A null list means that dimension was not stored. It is not an empty set.
 */
export function compareLab(left, right) {
  const leftEdges = asList(left?.dependencies);
  const rightEdges = asList(right?.dependencies);
  return {
    kind: "diff-lab",
    note: "Structural listings are directory entries. Evidence identities and edge ids are quoted from saved records. None of these dimensions describe behavior.",
    left: {
      label: left?.label ?? null,
      evidence_id: left?.evidence_id ?? null,
    },
    right: {
      label: right?.label ?? null,
      evidence_id: right?.evidence_id ?? null,
    },
    structural: dimension(
      asList(left?.files),
      asList(right?.files),
      "A directory listing was not available for both versions.",
    ),
    evidence_files: dimension(
      asList(left?.evidence_files),
      asList(right?.evidence_files),
      "One version has no Evidence file identities, so a missing path is not a deletion.",
    ),
    functions: dimension(
      asList(left?.functions),
      asList(right?.functions),
      "No function identities were stored on both versions. Absence is not a function diff.",
    ),
    dependencies: dimension(
      leftEdges,
      rightEdges,
      "Dependency edge ids were not stored on both versions.",
    ),
    strings: dimension(
      asList(left?.strings),
      asList(right?.strings),
      "No string identities were stored on both versions.",
    ),
    behavior: {
      status: "unknown",
      reason:
        "No behavior evidence was compared. Counts, paths, and edge ids do not establish a behavior change.",
      evidence_ids: [left?.evidence_id, right?.evidence_id].filter(
        (id) => typeof id === "string",
      ),
    },
    text:
      typeof left?.text === "string" && typeof right?.text === "string"
        ? {
            status: "shown",
            note: "Line diff of the two files that were dropped. This is source text, not Evidence, and behavior is unknown.",
            lines: boundedLineDiff(left.text, right.text),
          }
        : {
            status: "unknown",
            reason:
              "A text diff is shown only when both versions are small text files.",
          },
  };
}

export function boundedLineDiff(left, right) {
  const a = String(left).split("\n");
  const b = String(right).split("\n");
  if (a.length > 200 || b.length > 200) return [];
  const rows = a.length + 1;
  const cols = b.length + 1;
  const score = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      score[i][j] =
        a[i] === b[j]
          ? score[i + 1][j + 1] + 1
          : Math.max(score[i + 1][j], score[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length && out.length < 80) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (score[i + 1][j] >= score[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length && out.length < 80) out.push(`- ${a[i++]}`);
  while (j < b.length && out.length < 80) out.push(`+ ${b[j++]}`);
  return out;
}

export function factsFromEvidence(record) {
  if (!record || typeof record !== "object")
    return {
      evidence_id: null,
      evidence_files: null,
      functions: null,
      dependencies: null,
      strings: null,
    };
  const edges = record.normalized_result?.graph?.edges;
  return {
    evidence_id:
      typeof record.evidence_id === "string" ? record.evidence_id : null,
    evidence_files: fileIdentities(record),
    functions: identityList(record, /function/i),
    strings: identityList(record, /string/i),
    dependencies: Array.isArray(edges)
      ? edges
          .map((edge) => edge?.edge_id)
          .filter((id) => typeof id === "string")
      : null,
  };
}
