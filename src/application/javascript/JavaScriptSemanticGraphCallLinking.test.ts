import { expect, it } from "vitest";

import { buildJavaScriptSemanticGraph } from "./JavaScriptSemanticGraphBuilder.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { analyzeJavaScriptSemantics } from "../../domain/javascript/javascriptSemanticAnalysis.js";
import { resolveJavaScriptSemanticEvidence } from "../../domain/javascript/javascriptSemanticGraph.js";
import type { JavaScriptSemanticGraphNode } from "../../domain/javascript/javascriptSemanticGraphSchemas.js";

const SHA256 = "a".repeat(64);
const GRAPH_ID = `jag_${"b".repeat(64)}`;

const sourceFile = (path: string, source: string): JavaScriptArtifactFile => ({
  path,
  container_sha256: "0".repeat(64),
  sha256: SHA256,
  bytes: Buffer.byteLength(source),
  inventory_artifact_id: `art_${SHA256}`,
  kind: "javascript",
  unpacked: true,
  text: { included: true, value: source },
});

const analysisFor = (
  sources: Readonly<Record<string, string>>,
): JavaScriptArtifactAnalysis => ({
  files: Object.entries(sources).map(([path, source]) => ({
    file: sourceFile(path, source),
    javascript: null,
    semantic: { ir: analyzeJavaScriptSemantics(source) },
  })),
  packages: [],
  json_modules: [],
  html_scripts: [],
  html_stylesheets: [],
  html_elements: [],
  html_element_omissions: 0,
  source_maps: [],
  visited_ast_nodes: 0,
  findings: 0,
  modules: 0,
  parse_failures: 0,
  limitations: [],
});

const graphFor = (sources: Readonly<Record<string, string>>) =>
  buildJavaScriptSemanticGraph({
    rootArtifactSha256: SHA256,
    applicationGraph: { graph_id: GRAPH_ID, nodes: [] },
    analysis: analysisFor(sources),
  });

const callKey = (
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  sourceId: string,
  targetId: string,
): string | null => {
  const site = nodes.get(sourceId);
  const callee = nodes.get(targetId);
  const caller =
    site?.function_node_id === null || site?.function_node_id === undefined
      ? undefined
      : nodes.get(site.function_node_id);
  const callerName = caller?.properties.name;
  const calleeName = callee?.properties.name;
  if (
    typeof callerName !== "string" ||
    typeof calleeName !== "string" ||
    caller === undefined ||
    callee === undefined
  )
    return null;
  return `${caller.identity.module_path}:${callerName}->${callee.identity.module_path}:${calleeName}`;
};

const behaviorKey = (
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  node: JavaScriptSemanticGraphNode,
): string | null => {
  const behavior = node.properties.behavior;
  const detail = node.properties.detail;
  const ownerId = node.function_node_id;
  const owner = ownerId === null ? undefined : nodes.get(ownerId);
  const name = owner?.properties.name;
  if (
    typeof behavior !== "string" ||
    typeof detail !== "string" ||
    typeof name !== "string" ||
    owner === undefined
  )
    return null;
  return `${owner.identity.module_path}:${name} ${behavior} ${detail}`;
};

it("links imported, aliased, dynamic, and class calls and infers behaviors", () => {
  const graph = graphFor({
    "catalog.mjs": `
      export function itemById(items, id) {
        for (const item of items) {
          if (item.id === id) return item;
        }
        return null;
      }
    `,
    "alias.mjs": `
      import { itemById } from "./catalog.mjs";
      const find = itemById;
      export function run(items, id) {
        return find(items, id);
      }
    `,
    "dynamic.mjs": `
      export async function load(items, id) {
        const catalog = await import("./catalog.mjs");
        return catalog.itemById(items, id);
      }
    `,
    "class.mjs": `
      export class Catalog {
        itemById(items, id) {
          for (const item of items) {
            if (item.id === id) return item;
          }
          return null;
        }
        lookup(items, id) {
          return this.itemById(items, id);
        }
      }
      export function run(items, id) {
        const catalog = new Catalog();
        return catalog.itemById(items, id);
      }
    `,
    "effects.mjs": `
      import { spawn } from "node:child_process";
      import { readFileSync } from "node:fs";
      export async function loadRemote(url) {
        const response = await fetch(url);
        return response;
      }
      export function loadLocal(path) {
        return readFileSync(path);
      }
      export function remember(key, value) {
        localStorage.setItem(key, value);
      }
      export function launch(command) {
        spawn(command);
      }
    `,
  });
  const nodes = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const calls = graph.relations
    .filter(
      (relation) =>
        relation.relation === "calls" && relation.resolution === "resolved",
    )
    .map((relation) =>
      callKey(nodes, relation.source_node_id, relation.target_node_id),
    )
    .filter((key) => key !== null)
    .sort();
  expect(calls).toEqual([
    "alias.mjs:run->catalog.mjs:itemById",
    "class.mjs:lookup->class.mjs:itemById",
    "class.mjs:run->class.mjs:Catalog",
    "class.mjs:run->class.mjs:itemById",
    "dynamic.mjs:load->catalog.mjs:itemById",
  ]);
  const imported = graph.relations.find((relation) => {
    if (relation.relation !== "calls") return false;
    return (
      callKey(nodes, relation.source_node_id, relation.target_node_id) ===
      "alias.mjs:run->catalog.mjs:itemById"
    );
  });
  if (imported === undefined) throw new Error("missing imported call");
  const importedEvidence = resolveJavaScriptSemanticEvidence(
    graph,
    imported.evidence,
  );
  expect(importedEvidence.state).toBe("inferred");
  expect(importedEvidence.limitations.join(" ")).toContain("Re-exports");
  expect(importedEvidence.location.available).toBe(true);

  const behaviors = graph.nodes
    .filter((node) => typeof node.properties.behavior === "string")
    .map((node) => {
      const evidence = resolveJavaScriptSemanticEvidence(graph, node.evidence);
      expect(evidence.state).toBe("inferred");
      expect(["high", "medium"]).toContain(evidence.confidence);
      expect(evidence.limitations.length).toBeGreaterThan(0);
      return behaviorKey(nodes, node);
    })
    .filter((key) => key !== null)
    .sort();
  expect(behaviors).toEqual([
    "alias.mjs:run return call",
    "catalog.mjs:itemById read-property id",
    "catalog.mjs:itemById return null",
    "class.mjs:itemById read-property id",
    "class.mjs:itemById return null",
    "class.mjs:lookup return call",
    "class.mjs:run return call",
    "dynamic.mjs:load return call",
    "effects.mjs:launch side-effect spawn",
    "effects.mjs:loadLocal io readFile",
    "effects.mjs:loadLocal return call",
    "effects.mjs:loadRemote network fetch",
    "effects.mjs:remember storage localStorage.setItem",
  ]);
});
