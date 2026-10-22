const KINDS = new Set(["node", "module", "function", "edge", "finding"]);

function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function strings(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string").slice(0, limit);
}

function pack(title, textBody, facts, unknowns, evidenceIds) {
  const ids = evidenceIds.filter((id) => typeof id === "string" && id !== "");
  return {
    source: "local-template",
    model: null,
    title,
    text: textBody,
    facts,
    hypotheses: [],
    unknowns,
    evidence_ids: [...new Set(ids)],
  };
}

function explainNode(subject) {
  const label = text(subject.label) ?? text(subject.id) ?? "unlabeled";
  const nodeKind = text(subject.node_kind);
  const evidenceId = text(subject.evidence_id);
  const role = subject.kind === "function" ? "function" : subject.kind;
  const facts = [`Recorded ${role} “${label}”.`];
  if (nodeKind) facts.push(`Stored node kind: ${nodeKind}.`);
  if (text(subject.group) && text(subject.group) !== label)
    facts.push(`Display group: ${text(subject.group)}.`);
  if (evidenceId) facts.push(`Evidence ${evidenceId}.`);
  const unknowns = [
    "This template restates stored fields. It does not describe what the code does at runtime.",
  ];
  if (!evidenceId)
    unknowns.push("No Evidence id was attached to this selection.");
  if (subject.kind === "function")
    unknowns.push(
      "No function body was stored with this selection, so its behavior is unknown.",
    );
  if (subject.kind === "module")
    unknowns.push(
      "A recovered module identity is not a copy of its source and is not a verified implementation.",
    );
  return pack(
    `Explain this ${role}`,
    `${facts[0]} ${unknowns[0]}`,
    facts,
    unknowns,
    evidenceId ? [evidenceId] : [],
  );
}

function explainEdge(subject) {
  const relation = text(subject.relation) ?? "unknown relation";
  const from = text(subject.source?.label) ?? text(subject.from) ?? "unknown";
  const to = text(subject.target?.label) ?? text(subject.to) ?? "unknown";
  const evidenceId = text(subject.evidence_id);
  const facts = [`${from} -[${relation}]-> ${to}.`];
  for (const [name, value] of [
    ["State", subject.state],
    ["Confidence", subject.confidence],
    ["Authority", subject.authority],
    ["Basis", subject.basis],
  ]) {
    const item = text(value);
    if (item) facts.push(`${name}: ${item}.`);
  }
  const interpretation = text(subject.interpretation);
  if (interpretation) facts.push(interpretation);
  if (evidenceId) facts.push(`Evidence ${evidenceId}.`);
  const unknowns = [
    "A stored relationship is not an observed execution.",
    ...strings(subject.limitations, 8),
  ];
  if (!evidenceId)
    unknowns.push("No Evidence id was attached to this relationship.");
  return pack(
    "Explain this relationship",
    `${facts[0]} ${unknowns[0]}`,
    facts,
    unknowns,
    evidenceId ? [evidenceId] : [],
  );
}

function explainFinding(subject) {
  const sentence = text(subject.text);
  const evidenceId = text(subject.evidence_id);
  const path = text(subject.path);
  const unknowns = [
    "A finding is only as strong as the Evidence it cites.",
    ...strings(subject.unknowns, 8),
  ];
  if (!evidenceId) {
    const rejected =
      "This selection cites no Evidence id, so it is not treated as a fact.";
    return pack(
      "Explain this finding",
      rejected,
      [],
      [
        rejected,
        ...(sentence ? [`Uncited text was withheld: ${sentence}`] : []),
        ...unknowns,
      ],
      [],
    );
  }
  const facts = [];
  if (sentence) facts.push(sentence);
  facts.push(`Evidence ${evidenceId}.`);
  if (path) facts.push(`Path: ${path}.`);
  return pack(
    "Explain this finding",
    sentence
      ? `${sentence} Cited Evidence: ${evidenceId}.`
      : `This finding cites Evidence ${evidenceId} and has no sentence stored.`,
    facts,
    unknowns,
    [evidenceId],
  );
}

/** Plain-English explanation from fields the caller already loaded. No model. */
export function explainSubject(subject) {
  const kind = text(subject?.kind);
  if (!kind || !KINDS.has(kind)) {
    return pack(
      "Nothing to explain",
      "Select a function, module, graph node, edge, or finding that the studio already loaded.",
      [],
      ["No explainable subject was provided."],
      [],
    );
  }
  if (kind === "edge") return explainEdge(subject);
  if (kind === "finding") return explainFinding(subject);
  return explainNode(subject);
}
