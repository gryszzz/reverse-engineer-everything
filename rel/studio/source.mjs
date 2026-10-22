import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { studioError } from "./errors.mjs";
import { pathInside } from "./paths.mjs";
import { interpretRelationship, relationshipBasis } from "./graph.mjs";

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function locationValue(evidence) {
  if (!isObject(evidence?.location) || evidence.location.available !== true)
    return null;
  return isObject(evidence.location.value) ? evidence.location.value : null;
}

function findApplicationEdge(record, edgeId) {
  const edges = record?.normalized_result?.graph?.edges;
  if (!Array.isArray(edges)) return null;
  return (
    edges.find((edge) => isObject(edge) && String(edge.edge_id) === edgeId) ??
    null
  );
}

function lineWindow(text, line) {
  const rows = text.split(/\r?\n/u);
  const start = Math.max(1, line - 3);
  const end = Math.min(rows.length, line + 3);
  const lines = [];
  for (let number = start; number <= end; number += 1) {
    lines.push({
      line: number,
      text: rows[number - 1].slice(0, 500),
      highlighted: number === line,
    });
  }
  return lines;
}

/**
 * Read a few lines of a source file named by Evidence, only when that file
 * stays inside the analyzed directory target.
 */
export function readRecordedSource(record, edgeId, targetPath) {
  if (typeof edgeId !== "string" || edgeId.length < 1 || edgeId.length > 200)
    throw studioError("Provide an edge id from this Evidence record.");
  const edge = findApplicationEdge(record, edgeId);
  if (!edge)
    throw studioError("That edge is not in the application graph.", 404);
  const basis = relationshipBasis(edge.evidence);
  const location = locationValue(edge.evidence);
  const shared = {
    edge_id: edgeId,
    basis,
    interpretation: interpretRelationship(record.operation, basis),
    state:
      typeof edge.evidence?.state === "string" ? edge.evidence.state : null,
    confidence:
      typeof edge.evidence?.confidence === "string"
        ? edge.evidence.confidence
        : null,
    authority:
      typeof edge.evidence?.authority === "string"
        ? edge.evidence.authority
        : null,
  };
  if (!location || typeof location.source !== "string")
    return {
      ...shared,
      available: false,
      reason: "This relationship has no recorded source location.",
    };
  const line = location.start?.line;
  if (!Number.isInteger(line) || line < 1)
    return {
      ...shared,
      available: false,
      reason: "The recorded source location has no positive line number.",
    };
  let rootStat;
  try {
    rootStat = statSync(targetPath);
  } catch {
    return {
      ...shared,
      available: false,
      reason: "The analyzed target is not available.",
    };
  }
  if (!rootStat.isDirectory())
    return {
      ...shared,
      available: false,
      reason:
        "Source excerpts are opened only for directory targets. The location remains on the Evidence record.",
    };
  const root = realpathSync(targetPath);
  const lexical = isAbsolute(location.source)
    ? resolve(location.source)
    : resolve(root, location.source);
  if (!pathInside(root, lexical))
    throw studioError(
      "Recorded source path is outside the analyzed target.",
      400,
    );
  if (!existsSync(lexical))
    return {
      ...shared,
      available: false,
      reason: "The recorded source file is not in the target directory.",
    };
  const file = realpathSync(lexical);
  if (!pathInside(root, file))
    throw studioError(
      "Recorded source path resolves outside the analyzed target.",
      400,
    );
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 1_000_000)
    return {
      ...shared,
      available: false,
      reason: "The recorded source file is missing or larger than 1 MiB.",
    };
  return {
    ...shared,
    available: true,
    source: location.source,
    start_line: line,
    lines: lineWindow(readFileSync(file, "utf8"), line),
  };
}
