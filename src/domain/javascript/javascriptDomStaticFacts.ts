import * as t from "@babel/types";

import type {
  JavaScriptDomEventListenerFact,
  JavaScriptDomSourceFacts,
  JavaScriptDomStateWriteFact,
  JavaScriptSourceRange,
} from "./javascriptStaticAnalysisTypes.js";
import { childNodes } from "./javascriptSemanticTraversal.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

const MAX_VISITED_NODES = 100_000;
const MAX_QUERIES = 2_000;
const MAX_LISTENERS = 1_000;
const MAX_WRITES_PER_LISTENER = 200;
const LIMITATION =
  "DOM facts follow literal selectors, direct local bindings, inline callbacks, and uniquely named local functions; dynamic selectors, aliases, lexical shadowing, and runtime conditions can remain unresolved.";

type LocatedNode = t.Node & { readonly loc: t.SourceLocation | null };

interface QueryBinding {
  readonly bindingId: string;
  readonly selector: string;
  readonly selection: "one" | "many";
  readonly location: JavaScriptSourceRange;
}

interface ListenerCandidate {
  readonly node: t.CallExpression | t.OptionalCallExpression;
  readonly targetSelector: string | null;
  readonly targetKind: "selector" | "document" | "unknown";
  readonly targetSelection: "one" | "many" | null;
  readonly scopedBindings: ReadonlyMap<string, QueryBinding>;
  readonly eventName: string | null;
  readonly callback: t.Node | null;
  readonly callbackName: string | null;
}

const emptyFacts = (
  status: JavaScriptDomSourceFacts["status"] = "complete",
  limitations: readonly string[] = [],
): JavaScriptDomSourceFacts => ({
  status,
  queries: [],
  listeners: [],
  limitations: [...limitations],
});

/** Extract a bounded set of DOM query, event, and state-write facts from Babel syntax. */
export const analyzeJavaScriptDomStaticFacts = (
  source: string,
  root: t.Node,
  semanticState: JavaScriptSemanticAnalysisState,
): JavaScriptDomSourceFacts => {
  if (
    !source.includes("querySelector") &&
    !source.includes("addEventListener") &&
    !source.includes("classList") &&
    !source.includes("setAttribute")
  )
    return emptyFacts();

  const walked = walk(root, MAX_VISITED_NODES);
  const limitations: string[] = [];
  if (walked.exceeded) limitations.push("DOM AST visit limit was reached.");
  const nodes = walked.nodes;

  const variableCounts = new Map<string, number>();
  const functionCounts = new Map<string, number>();
  const functions = new Map<string, t.Node>();
  const declarators: t.VariableDeclarator[] = [];
  for (const node of nodes) {
    if (t.isVariableDeclarator(node)) {
      declarators.push(node);
      if (t.isIdentifier(node.id)) increment(variableCounts, node.id.name);
    }
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    )
      for (const parameter of node.params)
        if (t.isIdentifier(parameter))
          increment(variableCounts, parameter.name);
    if (t.isFunctionDeclaration(node) && node.id != null) {
      increment(functionCounts, node.id.name);
      functions.set(node.id.name, node);
    }
    if (
      t.isVariableDeclarator(node) &&
      t.isIdentifier(node.id) &&
      (t.isArrowFunctionExpression(node.init) ||
        t.isFunctionExpression(node.init))
    ) {
      increment(functionCounts, node.id.name);
      functions.set(node.id.name, node.init);
    }
  }

  const queries: JavaScriptDomSourceFacts["queries"][number][] = [];
  const bindings = new Map<string, QueryBinding>();
  for (const declarator of declarators) {
    if (
      !t.isIdentifier(declarator.id) ||
      variableCounts.get(declarator.id.name) !== 1 ||
      !isCall(declarator.init)
    )
      continue;
    const query = querySelector(declarator.init, bindings, semanticState);
    if (query === null) continue;
    const binding = resolveSemanticBindingState(
      semanticState,
      declarator.id,
      declarator.id.name,
    );
    const initializer = semanticStableInitializer(binding, semanticState);
    if (
      binding === undefined ||
      initializer?.node !== declarator.init ||
      initializer.projection.length !== 0
    ) {
      limitations.push(
        "One or more DOM query bindings are reassigned or do not have a stable local initializer.",
      );
      continue;
    }
    if (queries.length >= MAX_QUERIES) {
      limitations.push("DOM query fact limit was reached.");
      break;
    }
    const location = sourceRange(declarator.init);
    if (location === null) continue;
    bindings.set(declarator.id.name, {
      bindingId: binding.bindingId,
      selector: query.selector,
      selection: query.selection,
      location,
    });
    queries.push({
      binding: declarator.id.name,
      selector: query.selector,
      selection: query.selection,
      location,
    });
  }

  if (
    nodes.some(
      (node) =>
        isCall(node) &&
        (memberName(node.callee) === "querySelector" ||
          memberName(node.callee) === "querySelectorAll") &&
        querySelector(node, bindings, semanticState) === null,
    )
  )
    limitations.push(
      "One or more DOM selectors are dynamic, unsupported, or not linked to a unique local query binding.",
    );

  const callbackParameterQueries = new Map<
    t.Node,
    { readonly body: t.Node; readonly selectors: Map<string, QueryBinding> }
  >();
  const handledForEachListeners = new Set<t.Node>();
  for (const node of nodes) {
    if (!isCall(node) || memberName(node.callee) !== "forEach") continue;
    const callee = member(node.callee);
    const query =
      callee === null
        ? null
        : (querySelector(callee.object, bindings, semanticState) ??
          queryBindingFor(callee.object, bindings, semanticState) ??
          null);
    const callback = node.arguments[0];
    if (
      query === null ||
      t.isSpreadElement(callback) ||
      callback === undefined ||
      (!t.isArrowFunctionExpression(callback) &&
        !t.isFunctionExpression(callback))
    )
      continue;
    const parameter = callback.params[0];
    if (!t.isIdentifier(parameter)) continue;
    const parameterBinding = resolveSemanticBindingState(
      semanticState,
      parameter,
      parameter.name,
    );
    if (
      parameterBinding === undefined ||
      parameterBinding.definitions.some(({ kind }) => kind !== "parameter")
    )
      continue;
    callbackParameterQueries.set(callback, {
      body: callback.body,
      selectors: new Map([
        [
          parameter.name,
          {
            bindingId: parameterBinding.bindingId,
            selector: query.selector,
            selection: query.selection,
            location: sourceRange(node) ?? {
              start: { line: 1, column: 0 },
              end: { line: 1, column: 0 },
            },
          },
        ],
      ]),
    });
    for (const child of walk(callback.body, MAX_VISITED_NODES).nodes)
      if (isCall(child) && memberName(child.callee) === "addEventListener")
        handledForEachListeners.add(child);
  }

  const listenerCandidates: ListenerCandidate[] = [];
  for (const node of nodes) {
    if (!isCall(node) || memberName(node.callee) !== "addEventListener")
      continue;
    const receiver = member(node.callee)?.object;
    const eventArgument = callArgument(node, 0);
    const callback = callArgument(node, 1);
    const direct = queryBindingFor(receiver, bindings, semanticState);
    const ownerForEach = [...callbackParameterQueries.entries()].find(
      ([, callbackFacts]) => containsNode(callbackFacts.body, node),
    );
    const forEachBinding =
      ownerForEach === undefined
        ? undefined
        : queryBindingFor(receiver, ownerForEach[1].selectors, semanticState);
    const targetSelector = direct?.selector ?? forEachBinding?.selector ?? null;
    const targetKind = receiverIsDocument(receiver, semanticState)
      ? "document"
      : targetSelector === null
        ? "unknown"
        : "selector";
    const targetSelection =
      direct?.selection ?? forEachBinding?.selection ?? null;
    const callbackName = t.isIdentifier(callback) ? callback.name : null;
    const candidate = {
      node,
      targetSelector,
      targetKind,
      targetSelection,
      scopedBindings: ownerForEach?.[1].selectors ?? new Map(),
      eventName: t.isStringLiteral(eventArgument) ? eventArgument.value : null,
      callback: callback ?? null,
      callbackName,
    } satisfies ListenerCandidate;
    if (handledForEachListeners.has(node) && forEachBinding === undefined)
      continue;
    listenerCandidates.push(candidate);
  }

  const listeners: JavaScriptDomEventListenerFact[] = [];
  for (const candidate of listenerCandidates) {
    if (listeners.length >= MAX_LISTENERS) {
      limitations.push("DOM event listener fact limit was reached.");
      break;
    }
    const location = sourceRange(candidate.node);
    if (location === null) continue;
    const writes: JavaScriptDomStateWriteFact[] = [];
    const visitedFunctions = new Set<string>();
    const collect = (
      callable: t.Node | null,
      chain: readonly string[],
      depth: number,
      scopedBindings: ReadonlyMap<string, QueryBinding> = new Map(),
    ): void => {
      if (callable === null || depth > 4) return;
      const callableNode = callableBody(callable);
      if (callableNode === null) return;
      for (const statement of walkSkippingNestedFunctions(callableNode)) {
        const write = stateWrite(
          statement,
          bindings,
          scopedBindings,
          chain,
          semanticState,
        );
        if (write !== null) {
          if (writes.length < MAX_WRITES_PER_LISTENER) writes.push(write);
          else limitations.push("DOM state-write fact limit was reached.");
        }
        if (!isCall(statement) || !t.isIdentifier(statement.callee)) continue;
        const name = statement.callee.name;
        if (visitedFunctions.has(name) || functionCounts.get(name) !== 1)
          continue;
        const target = functions.get(name);
        if (target === undefined) continue;
        visitedFunctions.add(name);
        collect(target, [...chain, name], depth + 1);
      }
    };
    const inlineScope =
      candidate.callback === null
        ? new Map<string, QueryBinding>()
        : (callbackParameterQueries.get(candidate.callback)?.selectors ??
          new Map<string, QueryBinding>());
    collect(
      candidate.callback,
      [],
      0,
      candidate.scopedBindings.size > 0
        ? candidate.scopedBindings
        : inlineScope,
    );
    const listenerLimitations = [LIMITATION];
    if (candidate.eventName === null)
      listenerLimitations.push("Event name is dynamic or unsupported.");
    if (candidate.targetKind === "unknown")
      listenerLimitations.push(
        "Listener target did not resolve to a literal, unique local DOM query.",
      );
    if (
      candidate.callbackName !== null &&
      functionCounts.get(candidate.callbackName) !== 1
    )
      listenerLimitations.push(
        "Named listener callback is missing or ambiguous in this source file.",
      );
    listeners.push({
      event_name: candidate.eventName,
      target_selector: candidate.targetSelector,
      target_kind: candidate.targetKind,
      target_selection: candidate.targetSelection,
      callback_name: candidate.callbackName,
      location,
      writes: writes.sort(compareSourceRange),
      limitations: listenerLimitations,
    });
    if (candidate.eventName === null || candidate.targetKind === "unknown")
      limitations.push(
        "One or more event registrations have a dynamic event name or unresolved target.",
      );
    if (writes.some(({ target_selector }) => target_selector === null))
      limitations.push(
        "One or more DOM state writes have an unresolved target selector.",
      );
  }

  const status =
    walked.exceeded || limitations.length > 0 ? "partial" : "complete";
  return {
    status,
    queries: queries.sort(compareQuery),
    listeners: listeners.sort((left, right) => compareSourceRange(left, right)),
    limitations: unique(limitations),
  };
};

const querySelector = (
  call: t.Node | null | undefined,
  bindings: ReadonlyMap<string, QueryBinding>,
  semanticState: JavaScriptSemanticAnalysisState,
): { readonly selector: string; readonly selection: "one" | "many" } | null => {
  if (!isCall(call)) return null;
  const method = memberName(call.callee);
  if (method !== "querySelector" && method !== "querySelectorAll") return null;
  const argument = callArgument(call, 0);
  if (!t.isStringLiteral(argument) || argument.value.trim() === "") return null;
  const receiver = member(call.callee)?.object;
  if (receiverIsDocument(receiver, semanticState))
    return {
      selector: argument.value,
      selection: method === "querySelector" ? "one" : "many",
    };
  const parent = queryBindingFor(receiver, bindings, semanticState);
  if (parent === undefined || argument.value.includes(",")) return null;
  return {
    selector: `${parent.selector} ${argument.value}`,
    selection: method === "querySelector" ? "one" : "many",
  };
};

const stateWrite = (
  node: t.Node,
  bindings: ReadonlyMap<string, QueryBinding>,
  scopedBindings: ReadonlyMap<string, QueryBinding>,
  callChain: readonly string[],
  semanticState: JavaScriptSemanticAnalysisState,
): JavaScriptDomStateWriteFact | null => {
  let target: string | null = null;
  let targetBinding: string | null = null;
  let targetQuery: QueryBinding | undefined;
  let kind: JavaScriptDomStateWriteFact["kind"] | null = null;
  let operation: JavaScriptDomStateWriteFact["operation"] | null = null;
  let name: string | null = null;
  let value: string | null = null;
  let valueStatus: JavaScriptDomStateWriteFact["value_status"] = "dynamic";

  if (isCall(node)) {
    const method = memberName(node.callee);
    const calledMember = member(node.callee);
    if (calledMember === null) return null;
    const receiver = calledMember.object;
    const argument = callArgument(node, 0);
    if (
      (method === "add" || method === "remove" || method === "toggle") &&
      memberName(receiver) === "classList" &&
      t.isStringLiteral(argument)
    ) {
      const targetExpression = member(receiver)?.object;
      targetBinding = receiverIdentifier(targetExpression);
      targetQuery = selectorFor(
        targetExpression,
        bindings,
        scopedBindings,
        semanticState,
      );
      target = targetQuery?.selector ?? null;
      if (
        targetBinding === null &&
        isDocumentBody(targetExpression, semanticState)
      )
        target = "body";
      kind = "class";
      operation = method;
      name = argument.value;
      const flag = callArgument(node, 1);
      value = t.isBooleanLiteral(flag) ? String(flag.value) : null;
      valueStatus =
        flag === undefined || t.isBooleanLiteral(flag) ? "literal" : "dynamic";
    } else if (method === "setAttribute" && t.isIdentifier(receiver)) {
      const attribute = callArgument(node, 0);
      if (!t.isStringLiteral(attribute)) return null;
      targetBinding = receiver.name;
      targetQuery = selectorFor(
        receiver,
        bindings,
        scopedBindings,
        semanticState,
      );
      target = targetQuery?.selector ?? null;
      kind = "attribute";
      operation = "set";
      name = attribute.value.toLowerCase();
      const assigned = callArgument(node, 1);
      const literal = literalText(assigned);
      value = literal.value;
      valueStatus = literal.status;
    } else return null;
  } else if (t.isAssignmentExpression(node) && node.operator === "=") {
    if (
      !t.isMemberExpression(node.left) &&
      !t.isOptionalMemberExpression(node.left)
    )
      return null;
    targetBinding = receiverIdentifier(node.left.object);
    targetQuery = selectorFor(
      node.left.object,
      bindings,
      scopedBindings,
      semanticState,
    );
    target = targetQuery?.selector ?? null;
    if (
      targetBinding === null &&
      isDocumentBody(node.left.object, semanticState)
    )
      target = "body";
    const property = memberName(node.left);
    if (property === null) return null;
    name = property;
    operation = "set";
    const literal = literalText(node.right);
    value = literal.value;
    valueStatus = literal.status;
    kind =
      property === "textContent" || property === "innerText"
        ? "text"
        : property === "className"
          ? "class"
          : property === "ariaExpanded"
            ? "attribute"
            : "property";
    if (property === "ariaExpanded") name = "aria-expanded";
  } else return null;

  if (kind === null || operation === null || name === null) return null;
  const location = sourceRange(node);
  if (location === null) return null;
  const targetSelection =
    targetBinding === null
      ? target === "body"
        ? "one"
        : null
      : (targetQuery?.selection ?? null);
  return {
    target_selector: target,
    target_binding: targetBinding,
    target_selection: targetSelection,
    kind,
    operation,
    name,
    value,
    value_status: valueStatus,
    call_chain: [...callChain],
    location,
  };
};

const literalText = (
  node: t.Node | null | undefined,
): {
  readonly value: string | null;
  readonly status: "literal" | "dynamic";
} => {
  if (t.isStringLiteral(node)) return { value: node.value, status: "literal" };
  if (t.isBooleanLiteral(node))
    return { value: String(node.value), status: "literal" };
  if (t.isNumericLiteral(node))
    return { value: String(node.value), status: "literal" };
  if (t.isNullLiteral(node)) return { value: "null", status: "literal" };
  return { value: null, status: "dynamic" };
};

const selectorFor = (
  receiver: t.Node | null | undefined,
  bindings: ReadonlyMap<string, QueryBinding>,
  scopedBindings: ReadonlyMap<string, QueryBinding>,
  semanticState: JavaScriptSemanticAnalysisState,
): QueryBinding | undefined =>
  queryBindingFor(receiver, bindings, semanticState) ??
  queryBindingFor(receiver, scopedBindings, semanticState);

const queryBindingFor = (
  receiver: t.Node | null | undefined,
  bindings: ReadonlyMap<string, QueryBinding>,
  semanticState: JavaScriptSemanticAnalysisState,
): QueryBinding | undefined => {
  if (!t.isIdentifier(receiver)) return undefined;
  const query = bindings.get(receiver.name);
  return query !== undefined &&
    resolveSemanticBindingState(semanticState, receiver, receiver.name)
      ?.bindingId === query.bindingId
    ? query
    : undefined;
};

const walk = (
  root: t.Node,
  limit: number,
): { readonly nodes: t.Node[]; readonly exceeded: boolean } => {
  const nodes: t.Node[] = [];
  const pending = [root];
  while (pending.length > 0 && nodes.length < limit) {
    const node = pending.pop();
    if (node === undefined) continue;
    nodes.push(node);
    for (const child of childNodes(node).toReversed()) pending.push(child);
  }
  return { nodes, exceeded: pending.length > 0 };
};

const walkSkippingNestedFunctions = (root: t.Node): t.Node[] => {
  const result: t.Node[] = [];
  const pending = [root];
  while (pending.length > 0 && result.length < MAX_VISITED_NODES) {
    const node = pending.pop();
    if (node === undefined) continue;
    result.push(node);
    for (const child of childNodes(node).toReversed()) {
      if (child !== root && isFunction(child)) continue;
      pending.push(child);
    }
  }
  return result;
};

const containsNode = (root: t.Node, target: t.Node): boolean =>
  walk(root, MAX_VISITED_NODES).nodes.includes(target);

const callableBody = (node: t.Node): t.Node | null => {
  if (
    t.isFunctionDeclaration(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node)
  )
    return node.body;
  return null;
};

const isFunction = (node: t.Node): boolean =>
  t.isFunctionDeclaration(node) ||
  t.isFunctionExpression(node) ||
  t.isArrowFunctionExpression(node);

const isCall = (
  node: t.Node | null | undefined,
): node is t.CallExpression | t.OptionalCallExpression =>
  t.isCallExpression(node) || t.isOptionalCallExpression(node);

const member = (
  node: t.Node | null | undefined,
): t.MemberExpression | t.OptionalMemberExpression | null =>
  t.isMemberExpression(node) || t.isOptionalMemberExpression(node)
    ? node
    : null;

const memberName = (node: t.Node | null | undefined): string | null => {
  const value = member(node);
  if (value === null) return null;
  if (!value.computed && t.isIdentifier(value.property))
    return value.property.name;
  return value.computed && t.isStringLiteral(value.property)
    ? value.property.value
    : null;
};

const callArgument = (
  call: t.CallExpression | t.OptionalCallExpression,
  index: number,
): t.Node | undefined => {
  const argument = call.arguments[index];
  return t.isNode(argument) ? argument : undefined;
};

const receiverIdentifier = (node: t.Node | null | undefined): string | null =>
  t.isIdentifier(node) ? node.name : null;

const receiverIsDocument = (
  node: t.Node | null | undefined,
  semanticState: JavaScriptSemanticAnalysisState,
): boolean =>
  node != null && isUnshadowedGlobal(node, semanticState, "document");

const isDocumentBody = (
  node: t.Node | null | undefined,
  semanticState: JavaScriptSemanticAnalysisState,
): boolean => {
  const value = member(node);
  return (
    value !== null &&
    memberName(value) === "body" &&
    receiverIsDocument(value.object, semanticState)
  );
};

const sourceRange = (node: t.Node): JavaScriptSourceRange | null => {
  const located = node as LocatedNode;
  if (located.loc === null) return null;
  return {
    start: { line: located.loc.start.line, column: located.loc.start.column },
    end: { line: located.loc.end.line, column: located.loc.end.column },
  };
};

const compareSourceRange = (
  left: { readonly location: JavaScriptSourceRange },
  right: { readonly location: JavaScriptSourceRange },
): number =>
  left.location.start.line - right.location.start.line ||
  left.location.start.column - right.location.start.column ||
  left.location.end.line - right.location.end.line ||
  left.location.end.column - right.location.end.column;

const compareQuery = (
  left: JavaScriptDomSourceFacts["queries"][number],
  right: JavaScriptDomSourceFacts["queries"][number],
): number => compareSourceRange(left, right);

const increment = (values: Map<string, number>, key: string): void => {
  values.set(key, (values.get(key) ?? 0) + 1);
};

const unique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort();
