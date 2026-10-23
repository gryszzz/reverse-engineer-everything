import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PARSE_FILE = /^Parsing and projecting (\S+) \((\d+)\/(\d+)\)$/u;

/** One engine stderr progress line, or null when the line is not progress. */
export function parseProgressLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const update = parsed?.rea_progress;
  if (
    !update ||
    typeof update.phase !== "string" ||
    typeof update.message !== "string"
  )
    return null;
  const event = {
    source: "engine-progress",
    phase: update.phase,
    message: update.message,
    completed: Number.isFinite(update.completed) ? update.completed : null,
    total: Number.isFinite(update.total) ? update.total : null,
    sequence: Number.isSafeInteger(update.sequence) ? update.sequence : null,
    terminal: update.terminal === true,
  };
  const parsedFile = PARSE_FILE.exec(update.message);
  if (parsedFile) {
    event.file = parsedFile[1];
    event.file_index = Number(parsedFile[2]);
    event.file_total = Number(parsedFile[3]);
  }
  return event;
}

export function appendTimeline(directory, event) {
  const path = join(directory, "timeline.jsonl");
  const prior = existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).length
    : 0;
  if (prior >= 500) return prior;
  appendFileSync(
    path,
    `${JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() })}\n`,
  );
  return prior + 1;
}

export function readTimeline(directory) {
  const path = join(directory, "timeline.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(0, 500)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event && typeof event.message === "string" ? [event] : [];
      } catch {
        return [];
      }
    });
}

function moduleFile(node) {
  if (node?.kind !== "javascript-module") return null;
  if (node.identity?.namespace !== "source-module") return null;
  const key = node.identity?.key;
  if (typeof key !== "string" || !key.includes(":")) return null;
  const file = key.slice(key.lastIndexOf(":") + 1);
  if (!/^[A-Za-z0-9._/-]+$/u.test(file) || file.includes("..")) return null;
  return { node_id: node.node_id, file };
}

/** Module identities and import edges present in a JavaScript Evidence record. */
export function graphFacts(record) {
  const graph = record?.normalized_result?.graph;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const modules = nodes.flatMap((node) => {
    const module = moduleFile(node);
    return module ? [module] : [];
  });
  const byId = new Map(modules.map((module) => [module.node_id, module.file]));
  const imports = [];
  for (const edge of edges) {
    if (edge?.relation !== "imports") continue;
    const from = byId.get(edge.source_node_id);
    const specifier = edge.properties?.specifier;
    const resolved = edge.properties?.resolved_path;
    if (!from || typeof specifier !== "string") continue;
    const target =
      modules.find((module) => module.file === resolved)?.file ?? null;
    imports.push({
      from,
      specifier,
      to: target,
      state: edge.evidence?.state ?? "unrecorded",
      authority: edge.evidence?.authority ?? null,
    });
  }
  return { modules, imports };
}

const ABSENT_STEP =
  "No progress line names this fact. It was read from Evidence.";

function producingStep(prior, phases, file) {
  const events = Array.isArray(prior) ? prior : [];
  if (file) {
    const parsed = events.find(
      (event) =>
        event?.source === "engine-progress" &&
        event.phase === "parse_javascript_source" &&
        event.file === file,
    );
    if (parsed)
      return { phase: parsed.phase, message: parsed.message, note: null };
  }
  for (const phase of phases) {
    const hit = events.find(
      (event) => event?.source === "engine-progress" && event.phase === phase,
    );
    if (hit) return { phase: hit.phase, message: hit.message, note: null };
  }
  return { phase: null, message: null, note: ABSENT_STEP };
}

function factState(evidence) {
  const state = evidence?.state;
  if (state === "observed" || state === "inferred" || state === "derived")
    return { state, authority: evidence.authority ?? null };
  return { state: "unrecorded", authority: null };
}

function semanticFact(record, node) {
  const contexts = record?.normalized_result?.semantic_graph?.evidence_contexts;
  const context = (contexts ?? []).find(
    (item) => item.context_id === node?.evidence?.context_id,
  );
  return {
    ...factState(context),
    location: compactLocation(node?.evidence?.location),
  };
}

function compactLocation(location) {
  const start = location?.start ?? null;
  if (!Number.isInteger(start?.line)) return null;
  return {
    line: start.line,
    column: Number.isInteger(start.column) ? start.column : null,
  };
}

function previewText(value) {
  const flat = String(value).replace(/\s+/gu, " ").trim();
  if (flat.length <= 80) return { preview: flat, truncated: false };
  return { preview: `${flat.slice(0, 80)}…`, truncated: true };
}

/**
 * Facts read from a written Evidence record.
 * Nothing here is invented from a phase name.
 */
export function evidenceFacts(record) {
  const semantic = record?.normalized_result?.semantic_graph;
  const nodes = new Map(
    (semantic?.nodes ?? []).map((node) => [node.node_id, node]),
  );
  const functions = [];
  const strings = [];
  const behaviors = [];
  for (const node of semantic?.nodes ?? []) {
    const fact = semanticFact(record, node);
    if (node.kind === "function" && node.properties?.name) {
      functions.push({
        node_id: node.node_id,
        module_path: node.identity?.module_path ?? null,
        name: node.properties.name,
        ...fact,
      });
    }
    if (node.kind === "literal" && typeof node.properties?.value === "string") {
      const shown = previewText(node.properties.value);
      strings.push({
        node_id: node.node_id,
        module_path: node.identity?.module_path ?? null,
        text_length: node.properties.value.length,
        ...shown,
        ...fact,
      });
    }
    if (
      node.kind === "expression" &&
      typeof node.properties?.behavior === "string" &&
      typeof node.properties?.detail === "string"
    ) {
      const owner = node.function_node_id
        ? nodes.get(node.function_node_id)
        : null;
      behaviors.push({
        node_id: node.node_id,
        module_path: owner?.identity?.module_path ?? null,
        function_name: owner?.properties?.name ?? null,
        behavior: node.properties.behavior,
        detail: node.properties.detail,
        ...fact,
      });
    }
  }
  const calls = [];
  for (const relation of semantic?.relations ?? []) {
    if (relation.relation !== "calls" || relation.resolution !== "resolved")
      continue;
    const site = nodes.get(relation.source_node_id);
    const callee = nodes.get(relation.target_node_id);
    const caller = site?.function_node_id
      ? nodes.get(site.function_node_id)
      : null;
    if (!caller?.properties?.name || !callee?.properties?.name) continue;
    const fact = semanticFact(record, caller);
    calls.push({
      relation_id: relation.relation_id ?? null,
      from: caller.identity?.module_path ?? null,
      to: callee.identity?.module_path ?? null,
      from_name: caller.properties.name,
      to_name: callee.properties.name,
      location: compactLocation(site?.evidence?.location) ?? fact.location,
      state: fact.state,
      authority: fact.authority,
    });
  }
  const endpoints = [];
  for (const list of [
    record?.normalized_result?.api?.endpoints,
    record?.api?.endpoints,
  ]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item?.method !== "string" || typeof item?.path !== "string")
        continue;
      endpoints.push({
        method: item.method,
        path: item.path,
        operation_id:
          typeof item.operation_id === "string" ? item.operation_id : null,
        summary:
          typeof item.summary?.text === "string" ? item.summary.text : null,
      });
    }
  }
  const hypotheses = [];
  for (const list of [
    record?.hypotheses,
    record?.normalized_result?.hypotheses,
    record?.normalized_result?.finite_hypotheses,
  ]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const status =
        typeof item?.status === "string"
          ? item.status
          : typeof item?.decision === "string"
            ? item.decision
            : null;
      if (!status) continue;
      hypotheses.push({
        status,
        text:
          typeof item.statement === "string"
            ? item.statement
            : typeof item.text === "string"
              ? item.text
              : typeof item.id === "string"
                ? item.id
                : "unlabeled",
      });
    }
  }
  return { functions, calls, strings, behaviors, endpoints, hypotheses };
}

/** Events derived only after Evidence has been written. */
export function evidenceTimeline(record, prior = []) {
  const facts = graphFacts(record);
  const recovered = evidenceFacts(record);
  const evidenceId =
    typeof record?.evidence_id === "string" ? record.evidence_id : null;
  const events = [];
  if (evidenceId)
    events.push({
      source: "evidence",
      phase: "evidence",
      message: `Evidence minted ${evidenceId}`,
      evidence_id: evidenceId,
      produced_by: producingStep(prior, [
        "create_javascript_application_evidence",
        "hash_javascript_application_evidence",
        "validate_javascript_application_evidence",
      ]),
    });
  const stats = record?.normalized_result?.statistics;
  if (stats && Number.isSafeInteger(stats.parsed_javascript_files)) {
    const registrations = Number.isSafeInteger(stats.modules)
      ? String(stats.modules)
      : "not recorded";
    const findings = Number.isSafeInteger(stats.findings)
      ? String(stats.findings)
      : "not recorded";
    events.push({
      source: "evidence",
      phase: "statistics",
      message:
        `Evidence records ${stats.parsed_javascript_files} parsed JavaScript files` +
        ` and ${facts.modules.length} source modules.` +
        ` Bundler registrations: ${registrations}.` +
        ` Engine findings counter: ${findings}.`,
    });
  }
  for (const module of facts.modules.slice(0, 40))
    events.push({
      source: "evidence",
      phase: "module",
      file: module.file,
      node_id: module.node_id,
      evidence_id: evidenceId,
      message: `Recovered module identity from Evidence: ${module.file}. Source text was not copied.`,
      identity: "recovered",
      implementation: "not-written",
      verification: "unverified",
      state: "unrecorded",
      produced_by: producingStep(prior, [], module.file),
    });
  for (const edge of facts.imports.slice(0, 40))
    events.push({
      source: "evidence",
      phase: "edge",
      from: edge.from,
      to: edge.to,
      specifier: edge.specifier,
      evidence_id: evidenceId,
      state: edge.state,
      authority: edge.authority,
      message: `Import recorded in Evidence: ${edge.from} imports ${edge.specifier} (${edge.state}).`,
      basis: edge.state,
      produced_by: producingStep(prior, [
        "build_javascript_application_graph",
        "seal_javascript_application_graph",
      ]),
    });
  const semanticStep = [
    "build_javascript_semantic_graph",
    "seal_javascript_semantic_graph",
  ];
  for (const item of recovered.functions.slice(0, 40)) {
    const where = item.module_path ? `${item.module_path}:` : "";
    events.push({
      source: "evidence",
      phase: "function",
      file: item.module_path,
      node_id: item.node_id,
      evidence_id: evidenceId,
      fact: `${where}${item.name}`,
      state: item.state,
      authority: item.authority,
      location: item.location,
      message: `Function read from Evidence: ${where}${item.name} (${item.state}).`,
      produced_by: producingStep(prior, semanticStep),
    });
  }
  for (const item of recovered.calls.slice(0, 40)) {
    const label = `${item.from ?? "?"}:${item.from_name}->${item.to ?? "?"}:${item.to_name}`;
    events.push({
      source: "evidence",
      phase: "call",
      from: item.from,
      to: item.to,
      relation_id: item.relation_id,
      evidence_id: evidenceId,
      fact: label,
      state: item.state,
      authority: item.authority,
      location: item.location,
      message: `Call recorded in Evidence: ${label} (${item.state}).`,
      produced_by: producingStep(prior, semanticStep),
    });
  }
  for (const item of recovered.strings.slice(0, 24)) {
    const clipped = item.truncated
      ? " The line shows the first 80 characters."
      : "";
    events.push({
      source: "evidence",
      phase: "string",
      file: item.module_path,
      node_id: item.node_id,
      evidence_id: evidenceId,
      fact: item.preview,
      text_length: item.text_length,
      state: item.state,
      authority: item.authority,
      location: item.location,
      message: `String literal read from Evidence: ${item.preview} (${item.state}).${clipped}`,
      produced_by: producingStep(prior, semanticStep),
    });
  }
  for (const item of recovered.behaviors.slice(0, 24)) {
    const owner =
      item.function_name && item.module_path
        ? `${item.module_path}:${item.function_name} `
        : "";
    const pathNote =
      item.behavior === "network" ? " No request path was stored." : "";
    events.push({
      source: "evidence",
      phase: "behavior",
      file: item.module_path,
      node_id: item.node_id,
      evidence_id: evidenceId,
      fact: `${owner}${item.behavior} ${item.detail}`,
      state: item.state,
      authority: item.authority,
      location: item.location,
      message: `Behavior read from Evidence: ${owner}${item.behavior} ${item.detail} (${item.state}).${pathNote}`,
      produced_by: producingStep(prior, semanticStep),
    });
  }
  for (const item of recovered.endpoints.slice(0, 12)) {
    const name = item.operation_id ?? item.summary ?? "unnamed";
    events.push({
      source: "evidence",
      phase: "endpoint",
      evidence_id: evidenceId,
      fact: `${item.method} ${item.path}`,
      message: `Endpoint stored in Evidence: ${item.method} ${item.path} (${name}).`,
      produced_by: producingStep(prior, semanticStep),
    });
  }
  for (const item of recovered.hypotheses.slice(0, 12)) {
    const shown = previewText(item.text);
    events.push({
      source: "evidence",
      phase: "hypothesis",
      evidence_id: evidenceId,
      state: item.status,
      fact: shown.preview,
      message: `Hypothesis ${item.status}: ${shown.preview}`,
      produced_by: producingStep(prior, []),
    });
  }
  return events;
}
