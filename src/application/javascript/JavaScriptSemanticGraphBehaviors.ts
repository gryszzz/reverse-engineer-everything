import { createJavaScriptSemanticGraphNode } from "../../domain/javascript/javascriptSemanticGraph.js";
import type { JavaScriptSemanticGraphNode } from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import type { JavaScriptSemanticIr } from "../../domain/javascript/javascriptSemanticIr.js";
import type { JavaScriptSemanticValue } from "../../domain/javascript/javascriptSemanticValueTypes.js";
import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type { ApplicationGraphEvidence } from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import { addSemanticGraphNode } from "./JavaScriptSemanticGraphConstruction.js";
import { inferredSemanticEvidenceAt } from "./JavaScriptSemanticGraphEvidence.js";
import type { SemanticFlowProjectionContext } from "./JavaScriptSemanticGraphFlowProjection.js";

const STORAGE_OBJECTS = new Set(["localStorage", "sessionStorage"]);
const STORAGE_METHODS = new Set(["getItem", "setItem", "removeItem", "clear"]);

interface BehaviorFact {
  readonly kind:
    | "return"
    | "read-property"
    | "network"
    | "io"
    | "storage"
    | "side-effect";
  readonly detail: string;
  readonly confidence: "high" | "medium";
  readonly location: JavaScriptSourceRange;
  readonly limitation: string;
}

/**
 * Record syntactically visible behavior as inferred facts.
 * The fact is never an observation: static syntax does not prove it runs.
 */
export const projectSemanticBehaviors = (
  context: SemanticFlowProjectionContext,
): void => {
  const facts = collectBehaviorFacts(context.ir);
  for (const [callableId, entries] of facts) {
    const owner = context.callableNodes.get(callableId);
    const name = owner?.properties.name;
    if (owner === undefined || typeof name !== "string" || name.length === 0)
      continue;
    for (const fact of entries.values())
      addBehaviorNode(context, owner, callableId, fact);
  }
};

const addBehaviorNode = (
  context: SemanticFlowProjectionContext,
  owner: JavaScriptSemanticGraphNode,
  callableId: string,
  fact: BehaviorFact,
): void => {
  addSemanticGraphNode(
    context.state,
    createJavaScriptSemanticGraphNode(
      {
        kind: "expression",
        identity: {
          artifact_sha256: context.file.sha256,
          module_path: context.file.path,
          source_range: fact.location,
          role_key: `behavior:${callableId}:${fact.kind}:${fact.detail}`,
        },
        function_node_id: owner.node_id,
        application_node_ids: [],
        label: `${fact.kind} ${fact.detail}`,
        properties: {
          behavior: fact.kind,
          detail: fact.detail,
        },
        evidence: behaviorEvidence(context, fact),
      },
      context.state.evidenceContexts,
    ),
  );
};

const behaviorEvidence = (
  context: SemanticFlowProjectionContext,
  fact: BehaviorFact,
): ApplicationGraphEvidence => {
  const inferred = inferredSemanticEvidenceAt(context.file, fact.location);
  return {
    ...inferred,
    confidence: fact.confidence,
    limitations: [...inferred.limitations, fact.limitation],
  };
};

const collectBehaviorFacts = (
  ir: JavaScriptSemanticIr,
): Map<string, Map<string, BehaviorFact>> => {
  const facts = new Map<string, Map<string, BehaviorFact>>();
  const callCallees = new Set(
    ir.callSites.map((call) => rangeKey(call.calleeLocation)),
  );
  for (const callable of ir.callables)
    for (const site of callable.returnSites) {
      const classified = classifyReturn(site.value);
      if (classified === null) continue;
      retainFact(facts, callable.callableId, {
        kind: "return",
        detail: classified.detail,
        confidence: classified.confidence,
        location: site.location,
        limitation:
          "A direct return is inferred from syntax. It does not prove which branch runs or that the value is unchanged later.",
      });
    }
  for (const operation of ir.objectOperations) {
    if (
      operation.kind !== "read" ||
      operation.ownerCallableId === null ||
      operation.propertyPath?.length !== 1
    )
      continue;
    const property = operation.propertyPath[0];
    if (property === undefined) continue;
    if (callCallees.has(rangeKey(operation.location))) {
      const storage = storageFact(ir, operation.location, property);
      if (storage !== null)
        retainFact(facts, operation.ownerCallableId, {
          kind: "storage",
          detail: storage,
          confidence: "high",
          location: operation.location,
          limitation:
            "A storage call is inferred from the unbound receiver name and method. It does not prove the host provides that object.",
        });
      continue;
    }
    retainFact(facts, operation.ownerCallableId, {
      kind: "read-property",
      detail: property,
      confidence: "high",
      location: operation.location,
      limitation:
        "A static property read does not prove the receiver has that property at runtime.",
    });
  }
  for (const operation of ir.requestOperations) {
    if (operation.kind !== "request" || operation.ownerCallableId === null)
      continue;
    retainFact(facts, operation.ownerCallableId, {
      kind: "network",
      detail: operation.method,
      confidence: "high",
      location: operation.location,
      limitation:
        "A request construction does not prove the request is sent or what it returns.",
    });
  }
  for (const operation of ir.configurationOperations) {
    if (operation.kind !== "file" || operation.ownerCallableId === null)
      continue;
    retainFact(facts, operation.ownerCallableId, {
      kind: "io",
      detail: "readFile",
      confidence: "high",
      location: operation.location,
      limitation:
        "node:fs readFile and readFileSync are not distinguished, and the call is not executed.",
    });
  }
  for (const operation of ir.resourceOperations) {
    if (operation.ownerCallableId === null) continue;
    retainFact(facts, operation.ownerCallableId, {
      kind: "io",
      detail: operation.method,
      confidence: "high",
      location: operation.location,
      limitation:
        "A built-in resource call does not prove the resource is acquired or released.",
    });
  }
  for (const operation of ir.childProcessSpawns) {
    if (operation.ownerCallableId === null) continue;
    retainFact(facts, operation.ownerCallableId, {
      kind: "side-effect",
      detail: operation.method,
      confidence: "medium",
      location: operation.location,
      limitation:
        "A child-process call is a static candidate. It does not prove the process starts.",
    });
  }
  return facts;
};

const classifyReturn = (
  value: JavaScriptSemanticValue,
): {
  readonly detail: string;
  readonly confidence: "high" | "medium";
} | null => {
  if (value.status === "literal" && value.value === null)
    return { detail: "null", confidence: "high" };
  if (
    value.status === "array" &&
    value.unknownItems === false &&
    value.items.length === 0
  )
    return { detail: "empty-array", confidence: "high" };
  if (value.status === "array" && value.items.length > 0)
    return { detail: "array", confidence: "high" };
  if (
    value.status === "unknown" &&
    value.reason === "Unsupported CallExpression value."
  )
    return { detail: "call", confidence: "medium" };
  return null;
};

const storageFact = (
  ir: JavaScriptSemanticIr,
  location: JavaScriptSourceRange,
  method: string,
): string | null => {
  if (!STORAGE_METHODS.has(method)) return null;
  const receiver = ir.references.find(
    (reference) =>
      reference.role === "read" &&
      reference.bindingId === null &&
      STORAGE_OBJECTS.has(reference.name) &&
      reference.location.start.line === location.start.line &&
      reference.location.start.column === location.start.column,
  );
  return receiver === undefined ? null : `${receiver.name}.${method}`;
};

const retainFact = (
  facts: Map<string, Map<string, BehaviorFact>>,
  callableId: string,
  fact: BehaviorFact,
): void => {
  let bucket = facts.get(callableId);
  if (bucket === undefined) {
    bucket = new Map();
    facts.set(callableId, bucket);
  }
  const key = `${fact.kind}\u0000${fact.detail}`;
  if (!bucket.has(key)) bucket.set(key, fact);
};

const rangeKey = (range: JavaScriptSourceRange): string =>
  [range.start.line, range.start.column, range.end.line, range.end.column].join(
    ":",
  );
