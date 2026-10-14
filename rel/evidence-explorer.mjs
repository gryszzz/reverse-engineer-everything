import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { summarizeEvidence } from "./evidence-summary.mjs";

const MAX_FILE = 64 * 1024 * 1024;
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
const limitText = (v) =>
  String(v ?? "not provided")
    .replaceAll(/[\r\n|]/gu, " ")
    .slice(0, 240);

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
      limitations: edge.evidence.limitations ?? [],
    };
    if (
      find.trim() &&
      !JSON.stringify({ ...entry, raw: edge })
        .toLowerCase()
        .includes(find.trim().toLowerCase())
    )
      continue;
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

export function readEvidence(path, options) {
  if (typeof path !== "string" || !path)
    throw new Error("Supply a saved evidence.json path.");
  const file = resolve(path);
  const meta = statSync(file);
  if (!meta.isFile() || meta.size > MAX_FILE)
    throw new Error("Evidence must be a regular JSON file of at most 64 MiB.");
  return exploreEvidence(JSON.parse(readFileSync(file, "utf8")), options);
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
    while (args.length) {
      const option = args.shift();
      if (option === "--find" && args.length) find = args.shift();
      else if (option === "--limit" && args.length)
        limit = Number(args.shift());
      else if (option === "--json" && mode === "text") mode = "json";
      else if (option === "--dot" && mode === "text") mode = "dot";
      else throw new Error("Unsupported or conflicting option: " + option);
    }
    const result = readEvidence(file, { find, limit });
    console.log(
      mode === "json"
        ? JSON.stringify(result, null, 2)
        : mode === "dot"
          ? asDot(result)
          : asText(result),
    );
  } catch (error) {
    console.error("REE Evidence Explorer: " + error.message);
    process.exitCode = 2;
  }
}
