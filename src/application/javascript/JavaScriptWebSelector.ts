import type { JavaScriptDomStateWriteFact } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type { JavaScriptHtmlElementObservation } from "./JavaScriptArtifactAnalysisTypes.js";

interface AttributeRequirement {
  readonly name: string;
  readonly value: string | null;
}

interface CompoundSelector {
  readonly tag: string | null;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly attributes: readonly AttributeRequirement[];
  readonly pseudos: readonly string[];
  readonly pseudoElement: string | null;
}

interface ParsedSelector {
  readonly compounds: readonly CompoundSelector[];
  /** Combinator joining compounds[i] to compounds[i + 1]. */
  readonly combinators: readonly ("descendant" | "child")[];
}

export type WebSelectorMatch =
  | { readonly status: "matched"; readonly conditions: readonly string[] }
  | { readonly status: "unsupported" }
  | { readonly status: "not-matched" };

/** Match the deliberately narrow, non-executing selector subset used for cross-layer leads. */
export const matchWebSelector = (
  selector: string,
  elements: readonly JavaScriptHtmlElementObservation[],
  target: JavaScriptHtmlElementObservation,
  dynamicWrites: ReadonlyMap<
    number,
    readonly JavaScriptDomStateWriteFact[]
  > = new Map(),
): WebSelectorMatch => {
  const parsed = parseSelectorList(selector);
  if (parsed === null) return { status: "unsupported" };
  let unsupported = false;
  for (const alternative of parsed) {
    const result = matchAt(
      alternative,
      alternative.compounds.length - 1,
      target,
      elements,
      dynamicWrites,
      [],
    );
    if (result === "unsupported") unsupported = true;
    else if (result !== null)
      return { status: "matched", conditions: unique(result) };
  }
  return unsupported ? { status: "unsupported" } : { status: "not-matched" };
};

const matchAt = (
  selector: ParsedSelector,
  compoundIndex: number,
  element: JavaScriptHtmlElementObservation,
  allElements: readonly JavaScriptHtmlElementObservation[],
  dynamicWrites: ReadonlyMap<number, readonly JavaScriptDomStateWriteFact[]>,
  inheritedConditions: readonly string[],
): readonly string[] | null | "unsupported" => {
  const compound = selector.compounds[compoundIndex];
  if (compound === undefined) return null;
  const own = matchCompound(
    compound,
    element,
    dynamicWrites.get(element.element_index) ?? [],
  );
  if (own === "unsupported") return "unsupported";
  if (own === null) return null;
  const conditions = [...inheritedConditions, ...own];
  if (compoundIndex === 0) return conditions;

  const combinator = selector.combinators[compoundIndex - 1];
  if (combinator === "child") {
    const parent =
      element.parent_index === null
        ? undefined
        : allElements[element.parent_index];
    return parent === undefined
      ? null
      : matchAt(
          selector,
          compoundIndex - 1,
          parent,
          allElements,
          dynamicWrites,
          conditions,
        );
  }

  let parentIndex = element.parent_index;
  while (parentIndex !== null) {
    const parent = allElements[parentIndex];
    if (parent === undefined) return null;
    const result = matchAt(
      selector,
      compoundIndex - 1,
      parent,
      allElements,
      dynamicWrites,
      conditions,
    );
    if (result !== null) return result;
    parentIndex = parent.parent_index;
  }
  return null;
};

const matchCompound = (
  selector: CompoundSelector,
  element: JavaScriptHtmlElementObservation,
  writes: readonly JavaScriptDomStateWriteFact[],
): readonly string[] | null | "unsupported" => {
  if (
    selector.tag !== null &&
    selector.tag !== "*" &&
    selector.tag.toLowerCase() !== element.tag_name.toLowerCase()
  )
    return null;
  const attributes = element.attributes;
  const classes = (attributes.class ?? "").split(/\s+/u).filter(Boolean);
  const conditions: string[] = [];
  if (selector.id !== null && attributes.id !== selector.id) return null;
  for (const className of selector.classes) {
    if (classes.includes(className)) continue;
    if (!writes.some((write) => canWriteClass(write, className))) return null;
    conditions.push(
      `class .${className} depends on a matching JavaScript state write`,
    );
  }
  for (const requirement of selector.attributes) {
    const current = attributes[requirement.name];
    if (
      current !== undefined &&
      (requirement.value === null || current === requirement.value)
    )
      continue;
    if (
      current === undefined &&
      requirement.name === "open" &&
      (requirement.value === null || requirement.value === "") &&
      element.tag_name === "details"
    ) {
      conditions.push(
        "native details open state was not evaluated; this selector describes a possible open state",
      );
      continue;
    }
    if (
      !writes.some((write) =>
        canWriteAttribute(write, requirement, element.tag_name),
      )
    )
      return null;
    conditions.push(
      requirement.value === null
        ? `attribute [${requirement.name}] depends on a matching JavaScript state write`
        : `attribute [${requirement.name}=${requirement.value}] depends on a matching JavaScript state write`,
    );
  }
  for (const pseudo of selector.pseudos)
    conditions.push(`pseudo-state :${pseudo} was not evaluated`);
  if (selector.pseudoElement !== null)
    conditions.push(
      `pseudo-element ::${selector.pseudoElement} is a style target`,
    );
  return conditions;
};

const canWriteClass = (
  write: JavaScriptDomStateWriteFact,
  className: string,
): boolean => {
  if (write.kind === "class" && write.name === className) {
    if (write.operation === "add") return true;
    if (write.operation === "toggle")
      return write.value_status === "dynamic" || write.value !== "false";
    return (
      write.operation === "set" &&
      (write.value_status === "dynamic" ||
        (write.value ?? "").split(/\s+/u).includes(className))
    );
  }
  if (
    write.kind === "class" &&
    write.name === "className" &&
    write.operation === "set"
  )
    return (
      write.value_status === "dynamic" ||
      (write.value ?? "").split(/\s+/u).includes(className)
    );
  return (
    write.kind === "attribute" &&
    write.name === "class" &&
    write.operation === "set" &&
    (write.value_status === "dynamic" ||
      (write.value ?? "").split(/\s+/u).includes(className))
  );
};

const canWriteAttribute = (
  write: JavaScriptDomStateWriteFact,
  requirement: AttributeRequirement,
  tagName: string,
): boolean => {
  if (write.kind === "attribute" && write.name === requirement.name) {
    if (requirement.value === null) return true;
    return (
      write.value_status === "dynamic" || write.value === requirement.value
    );
  }
  if (
    write.kind === "property" &&
    write.name === "open" &&
    requirement.name === "open" &&
    (tagName === "details" || tagName === "dialog") &&
    (requirement.value === null || requirement.value === "") &&
    (write.value_status === "dynamic" || write.value === "true")
  )
    return true;
  return false;
};

const parseSelectorList = (source: string): ParsedSelector[] | null => {
  const alternatives = splitTopLevel(source, ",");
  if (alternatives === null || alternatives.length === 0) return null;
  const parsed: ParsedSelector[] = [];
  for (const alternative of alternatives) {
    const tokens = tokenizeChain(alternative);
    if (tokens === null || tokens.compounds.length === 0) return null;
    const compounds: CompoundSelector[] = [];
    for (const token of tokens.compounds) {
      const compound = parseCompound(token);
      if (compound === null) return null;
      compounds.push(compound);
    }
    parsed.push({ compounds, combinators: tokens.combinators });
  }
  return parsed;
};

const splitTopLevel = (source: string, delimiter: string): string[] | null => {
  const values: string[] = [];
  let start = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === "\\") return null;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === delimiter && brackets === 0 && parentheses === 0) {
      const value = source.slice(start, index).trim();
      if (value === "") return null;
      values.push(value);
      start = index + 1;
    }
    if (brackets < 0 || parentheses < 0) return null;
  }
  if (quote !== null || brackets !== 0 || parentheses !== 0) return null;
  const last = source.slice(start).trim();
  if (last === "") return null;
  values.push(last);
  return values;
};

const tokenizeChain = (
  source: string,
): {
  readonly compounds: readonly string[];
  readonly combinators: readonly ("descendant" | "child")[];
} | null => {
  const compounds: string[] = [];
  const combinators: ("descendant" | "child")[] = [];
  let current = "";
  let pending: "descendant" | "child" | null = null;
  let brackets = 0;
  let parentheses = 0;
  let quote: string | null = null;
  const flush = (): void => {
    const token = current.trim();
    if (token === "") return;
    if (compounds.length > 0) combinators.push(pending ?? "descendant");
    compounds.push(token);
    pending = null;
    current = "";
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote !== null) {
      current += character;
      if (character === "\\") return null;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
    } else if (character === "[") {
      brackets += 1;
      current += character;
    } else if (character === "]") {
      brackets -= 1;
      if (brackets < 0) return null;
      current += character;
    } else if (character === "(") {
      parentheses += 1;
      current += character;
    } else if (character === ")") {
      parentheses -= 1;
      if (parentheses < 0) return null;
      current += character;
    } else if (brackets === 0 && parentheses === 0 && character === ">") {
      flush();
      pending = "child";
    } else if (brackets === 0 && parentheses === 0 && /\s/u.test(character)) {
      flush();
      if (compounds.length > 0 && pending === null) pending = "descendant";
    } else current += character;
  }
  if (quote !== null || brackets !== 0 || parentheses !== 0) return null;
  flush();
  if (compounds.length === 0 || combinators.length !== compounds.length - 1)
    return null;
  return { compounds, combinators };
};

const parseCompound = (source: string): CompoundSelector | null => {
  let index = 0;
  let tag: string | null = null;
  let id: string | null = null;
  let pseudoElement: string | null = null;
  const classes: string[] = [];
  const attributes: AttributeRequirement[] = [];
  const pseudos: string[] = [];
  if (source[index] === "*" || /[a-z]/iu.test(source[index] ?? "")) {
    const start = index;
    if (source[index] === "*") index += 1;
    else while (/[\w-]/u.test(source[index] ?? "")) index += 1;
    tag = source.slice(start, index);
  }
  while (index < source.length) {
    const marker = source[index];
    if (marker === "." || marker === "#") {
      const start = ++index;
      while (/[\w-]/u.test(source[index] ?? "")) index += 1;
      if (start === index) return null;
      const value = source.slice(start, index);
      if (marker === ".") classes.push(value);
      else if (id === null) id = value;
      else return null;
    } else if (marker === "[") {
      const closing = findAttributeEnd(source, index + 1);
      if (closing === null) return null;
      const attribute = parseAttribute(source.slice(index + 1, closing));
      if (attribute === null) return null;
      attributes.push(attribute);
      index = closing + 1;
    } else if (marker === ":") {
      const double = source[index + 1] === ":";
      index += double ? 2 : 1;
      const start = index;
      while (/[\w-]/u.test(source[index] ?? "")) index += 1;
      if (start === index || source[index] === "(") return null;
      const pseudo = source.slice(start, index);
      if (double) {
        if (pseudoElement !== null) return null;
        pseudoElement = pseudo;
      } else if (
        ["after", "before", "first-letter", "first-line"].includes(
          pseudo.toLowerCase(),
        )
      ) {
        if (pseudoElement !== null) return null;
        pseudoElement = pseudo;
      } else pseudos.push(pseudo);
    } else return null;
  }
  if (
    tag === null &&
    id === null &&
    classes.length === 0 &&
    attributes.length === 0 &&
    pseudos.length === 0 &&
    pseudoElement === null
  )
    return null;
  return { tag, id, classes, attributes, pseudos, pseudoElement };
};

const findAttributeEnd = (source: string, start: number): number | null => {
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === "\\") return null;
      if (character === quote) quote = null;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === "]") return index;
  }
  return null;
};

const parseAttribute = (source: string): AttributeRequirement | null => {
  const match =
    /^\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?\s*$/u.exec(
      source,
    );
  if (match === null) return null;
  return {
    name: match[1]?.toLowerCase() ?? "",
    value: match[2] ?? match[3] ?? match[4] ?? null,
  };
};

const unique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort();
