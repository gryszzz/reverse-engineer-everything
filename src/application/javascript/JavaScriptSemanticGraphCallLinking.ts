import type { JsonValue } from "../../domain/jsonValue.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import type {
  JavaScriptSemanticCallSite,
  JavaScriptSemanticCallable,
  JavaScriptSemanticIr,
} from "../../domain/javascript/javascriptSemanticIr.js";
import type { JavaScriptModuleResolutionMode } from "../../domain/javascript/javascriptModuleResolutionMode.js";
import type { JavaScriptSemanticGraphNode } from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import { sourceRangesEqual } from "../../domain/javascript/javascriptStaticAnalysisHelpers.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";
import { inferredSemanticEvidence } from "./JavaScriptSemanticGraphEvidence.js";
import {
  addSemanticGraphRelation,
  type SemanticGraphProjectionState,
} from "./JavaScriptSemanticGraphConstruction.js";

const IMPORTED_CALL_LIMITATION =
  "The callee is the unique function exported under this name from the resolved module. Re-exports, computed names, and later assignments are not followed.";

export interface SameFileCallContext {
  readonly ir: JavaScriptSemanticIr;
  readonly state: SemanticGraphProjectionState;
  readonly callSiteNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly callableNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
}

/** Export names whose callable is this function, for a later cross-file link. */
export const exportedNamesForCallable = (
  callableId: string,
  ir: JavaScriptSemanticIr,
): string[] => {
  const names = new Set<string>();
  for (const link of ir.moduleLinks) {
    if (link.callableId !== callableId || link.exportedName === null) continue;
    if (link.kind !== "export" && link.kind !== "commonjs-export") continue;
    names.add(link.exportedName);
  }
  return [...names];
};

/** Additive call-site properties for one unique imported or namespace callee. */
export const importedCallProperties = (
  call: JavaScriptSemanticCallSite,
  ir: JavaScriptSemanticIr,
): Readonly<Record<string, JsonValue>> => {
  if (call.resolution === "exact") return {};
  const target = importedTarget(call, ir);
  if (target === null) return {};
  return {
    imported_specifier: target.specifier,
    imported_name: target.importedName,
    resolution_mode: target.resolutionMode,
  };
};

/**
 * Link `this.method()` and `instance.method()` when the class declaration
 * in this file names exactly one method. Imported calls stay unresolved here.
 */
export const projectSameFileCalls = (context: SameFileCallContext): void => {
  for (const call of context.ir.callSites) {
    if (call.resolution === "exact") continue;
    const targetId = sameFileCallee(call, context.ir);
    if (targetId === null) continue;
    addSemanticGraphRelation(context.state, {
      source: context.callSiteNodes.get(call.callSiteId),
      target: context.callableNodes.get(targetId),
      relation: "calls",
      resolution: "resolved",
    });
  }
};

/** Link imported call sites once every file's exported function nodes exist. */
export const linkImportedSemanticCalls = (
  state: SemanticGraphProjectionState,
): void => {
  const nodes = [...state.nodes.values()];
  const files = stubFiles(nodes);
  const exportsByName = indexExports(nodes);
  for (const site of nodes) {
    if (site.kind !== "call-site") continue;
    const target = resolveImportedCallee(site, files, exportsByName);
    if (target === undefined) continue;
    const evidence = inferredSemanticEvidence(
      state.evidenceContexts.resolve(site.evidence),
    );
    addSemanticGraphRelation(state, {
      source: site,
      target,
      relation: "calls",
      resolution: "resolved",
      evidence: {
        ...evidence,
        limitations: [...evidence.limitations, IMPORTED_CALL_LIMITATION],
      },
    });
  }
};

interface ImportedTarget {
  readonly specifier: string;
  readonly importedName: string;
  readonly resolutionMode: JavaScriptModuleResolutionMode;
}

const importedTarget = (
  call: JavaScriptSemanticCallSite,
  ir: JavaScriptSemanticIr,
): ImportedTarget | null => {
  const reference = ir.references.find(
    (item) =>
      item.role === "read" &&
      item.bindingId !== null &&
      sourceRangesEqual(item.location, call.calleeLocation),
  );
  if (reference?.bindingId !== undefined && reference.bindingId !== null) {
    const direct = originTarget(ir, reference.bindingId, null);
    if (direct !== null) return direct;
  }
  const member = memberRead(call, ir);
  if (
    member?.objectBindingId === null ||
    member?.propertyPath?.[0] === undefined
  )
    return null;
  return originTarget(ir, member.objectBindingId, member.propertyPath[0]);
};

const originTarget = (
  ir: JavaScriptSemanticIr,
  bindingId: string,
  memberName: string | null,
): ImportedTarget | null => {
  const binding = ir.bindings.find((item) => item.bindingId === bindingId);
  if (binding?.provenance.status !== "module") return null;
  const origin = binding.provenance.origins[0];
  if (origin === undefined) return null;
  const importedName =
    memberName === null
      ? origin.importedPath.length === 1
        ? origin.importedPath[0]
        : undefined
      : origin.importedPath.length === 0 || origin.importedPath[0] === "*"
        ? memberName
        : undefined;
  if (
    importedName === undefined ||
    importedName === "*" ||
    importedName === "[dynamic]"
  )
    return null;
  if (typeOnlyImport(ir, origin.specifier, importedName)) return null;
  return {
    specifier: origin.specifier,
    importedName,
    resolutionMode: origin.resolutionMode ?? "import",
  };
};

const typeOnlyImport = (
  ir: JavaScriptSemanticIr,
  specifier: string,
  importedName: string,
): boolean => {
  const links = ir.moduleLinks.filter(
    (link) =>
      link.specifier === specifier &&
      (link.importedName === importedName || link.importedName === "*"),
  );
  return links.length > 0 && links.every((link) => link.kind === "type-import");
};

const memberRead = (
  call: JavaScriptSemanticCallSite,
  ir: JavaScriptSemanticIr,
) =>
  ir.objectOperations.find(
    (operation) =>
      operation.kind === "read" &&
      operation.propertyPath?.length === 1 &&
      sourceRangesEqual(operation.location, call.calleeLocation),
  );

const sameFileCallee = (
  call: JavaScriptSemanticCallSite,
  ir: JavaScriptSemanticIr,
): string | null => {
  const member = memberRead(call, ir);
  const name = member?.propertyPath?.[0];
  if (name === undefined) return null;
  if (member?.objectBindingId != null)
    return constructedMethod(ir, member.objectBindingId, name);
  if (receiverIsNamed(call, ir)) return null;
  return methodOnCallerClass(call, ir, name);
};

const receiverIsNamed = (
  call: JavaScriptSemanticCallSite,
  ir: JavaScriptSemanticIr,
): boolean =>
  ir.references.some(
    (reference) =>
      reference.role === "read" &&
      reference.location.start.line === call.calleeLocation.start.line &&
      reference.location.start.column === call.calleeLocation.start.column,
  );

const methodOnCallerClass = (
  call: JavaScriptSemanticCallSite,
  ir: JavaScriptSemanticIr,
  name: string,
): string | null => {
  const caller = ir.callables.find(
    (callable) => callable.callableId === call.callerCallableId,
  );
  if (caller === undefined) return null;
  const owner = innermostClass(ir, caller.location);
  if (owner === null) return null;
  return uniqueMethod(ir, owner, name);
};

const constructedMethod = (
  ir: JavaScriptSemanticIr,
  bindingId: string,
  name: string,
): string | null => {
  const flows = ir.callResultFlows.filter(
    (flow) => flow.bindingId === bindingId,
  );
  if (flows.length !== 1) return null;
  const flow = flows[0];
  if (flow === undefined) return null;
  const construct = ir.callSites.find(
    (site) => site.callSiteId === flow.callSiteId,
  );
  if (
    construct?.kind !== "construct" ||
    construct.resolution !== "exact" ||
    construct.calleeCallableIds.length !== 1
  )
    return null;
  const classId = construct.calleeCallableIds[0];
  const owner = ir.callables.find(
    (callable) => callable.callableId === classId && callable.kind === "class",
  );
  if (owner === undefined) return null;
  return uniqueMethod(ir, owner, name);
};

const innermostClass = (
  ir: JavaScriptSemanticIr,
  location: JavaScriptSourceRange,
): JavaScriptSemanticCallable | null => {
  const owners = ir.callables.filter(
    (callable) =>
      callable.kind === "class" && rangeContains(callable.location, location),
  );
  if (owners.length === 0) return null;
  return owners.reduce((inner, candidate) =>
    rangeContains(inner.location, candidate.location) ? candidate : inner,
  );
};

const uniqueMethod = (
  ir: JavaScriptSemanticIr,
  owner: JavaScriptSemanticCallable,
  name: string,
): string | null => {
  const methods = ir.callables.filter(
    (callable) =>
      callable.kind === "method" &&
      callable.name === name &&
      rangeContains(owner.location, callable.location),
  );
  return methods.length === 1 ? (methods[0]?.callableId ?? null) : null;
};

const rangeContains = (
  outer: JavaScriptSourceRange,
  inner: JavaScriptSourceRange,
): boolean =>
  (outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line &&
      outer.start.column <= inner.start.column)) &&
  (outer.end.line > inner.end.line ||
    (outer.end.line === inner.end.line &&
      outer.end.column >= inner.end.column));

const indexExports = (
  nodes: readonly JavaScriptSemanticGraphNode[],
): Map<string, JavaScriptSemanticGraphNode[]> => {
  const exportsByName = new Map<string, JavaScriptSemanticGraphNode[]>();
  for (const node of nodes) {
    if (node.kind !== "function") continue;
    const names = node.properties.exported_names;
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (typeof name !== "string" || name.length === 0) continue;
      const key = `${node.identity.module_path}\u0000${name}`;
      const existing = exportsByName.get(key) ?? [];
      if (!existing.includes(node)) existing.push(node);
      exportsByName.set(key, existing);
    }
  }
  return exportsByName;
};

const resolveImportedCallee = (
  site: JavaScriptSemanticGraphNode,
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
  exportsByName: ReadonlyMap<string, JavaScriptSemanticGraphNode[]>,
): JavaScriptSemanticGraphNode | undefined => {
  const specifier = site.properties.imported_specifier;
  const importedName = site.properties.imported_name;
  if (typeof specifier !== "string" || typeof importedName !== "string")
    return undefined;
  if (!files.has(site.identity.module_path)) return undefined;
  const resolution = resolveArtifactPathByContext({
    declaredPath: specifier,
    sourcePath: site.identity.module_path,
    context: "module-specifier",
    files,
    moduleKind: resolutionMode(site.properties.resolution_mode),
  });
  if (resolution.resolution_status !== "resolved") return undefined;
  const targets = exportsByName.get(
    `${resolution.resolved_path}\u0000${importedName}`,
  );
  return targets?.length === 1 ? targets[0] : undefined;
};

const resolutionMode = (
  value: JsonValue | undefined,
): JavaScriptModuleResolutionMode =>
  value === "require" || value === "compiler-dependent" || value === "import"
    ? value
    : "import";

const stubFiles = (
  nodes: readonly JavaScriptSemanticGraphNode[],
): Map<string, JavaScriptArtifactFile> => {
  const files = new Map<string, JavaScriptArtifactFile>();
  for (const node of nodes) {
    const path = node.identity.module_path;
    if (
      path.length === 0 ||
      path === "unknown-semantic-root" ||
      files.has(path)
    )
      continue;
    files.set(path, {
      path,
      container_sha256: "0".repeat(64),
      sha256: node.identity.artifact_sha256,
      bytes: 0,
      inventory_artifact_id: `art_${node.identity.artifact_sha256}`,
      kind: "javascript",
      unpacked: true,
      text: { included: false, reason: "not-applicable" },
    });
  }
  return files;
};
