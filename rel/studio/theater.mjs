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

/** Events derived only after Evidence has been written. */
export function evidenceTimeline(record) {
  const facts = graphFacts(record);
  const events = [];
  if (typeof record?.evidence_id === "string")
    events.push({
      source: "evidence",
      phase: "evidence",
      message: `Evidence minted ${record.evidence_id}`,
      evidence_id: record.evidence_id,
    });
  const stats = record?.normalized_result?.statistics;
  if (stats && Number.isSafeInteger(stats.parsed_javascript_files))
    events.push({
      source: "evidence",
      phase: "statistics",
      message: `Evidence records ${stats.parsed_javascript_files} parsed JavaScript files, ${stats.modules} modules, and ${stats.findings} findings.`,
    });
  for (const module of facts.modules.slice(0, 40))
    events.push({
      source: "evidence",
      phase: "module",
      file: module.file,
      message: `Recovered module identity from Evidence: ${module.file}. Source text was not copied.`,
      identity: "recovered",
      implementation: "not-written",
      verification: "unverified",
    });
  for (const edge of facts.imports.slice(0, 40))
    events.push({
      source: "evidence",
      phase: "edge",
      from: edge.from,
      to: edge.to,
      specifier: edge.specifier,
      message: `Inferred import recorded in Evidence: ${edge.from} imports ${edge.specifier} (${edge.state}).`,
      basis: edge.state,
    });
  return events;
}
