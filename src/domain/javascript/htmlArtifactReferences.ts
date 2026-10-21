import {
  defaultTreeAdapter,
  parse,
  type DefaultTreeAdapterTypes,
} from "parse5";

interface HtmlScriptReference {
  readonly scriptPath: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface HtmlWebElementReference {
  readonly elementIndex: number;
  readonly parentIndex: number | null;
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly startOffset: number | null;
  readonly endOffset: number | null;
}

export interface HtmlStylesheetReference {
  readonly stylesheetPath: string;
  readonly media: string | null;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface HtmlArtifactWebReferences {
  readonly baseHref: string | null;
  readonly scripts: readonly HtmlScriptReference[];
  readonly stylesheets: readonly HtmlStylesheetReference[];
  readonly elements: readonly HtmlWebElementReference[];
  readonly omittedElements: number;
}

/** Extract inert HTML script references and the first document base href. */
export const htmlArtifactReferences = (
  text: string,
): {
  readonly baseHref: string | null;
  readonly scripts: readonly HtmlScriptReference[];
} => {
  const result = htmlArtifactWebReferences(text, 0);
  return { baseHref: result.baseHref, scripts: result.scripts };
};

/** Extract bounded HTML elements plus script and stylesheet references in one inert parse. */
export const htmlArtifactWebReferences = (
  text: string,
  maximumElements = 20_000,
): HtmlArtifactWebReferences => {
  const pending: {
    readonly node: DefaultTreeAdapterTypes.Node;
    readonly parentIndex: number | null;
  }[] = [
    { node: parse(text, { sourceCodeLocationInfo: true }), parentIndex: null },
  ];
  const scripts: HtmlScriptReference[] = [];
  const stylesheets: HtmlStylesheetReference[] = [];
  const elements: HtmlWebElementReference[] = [];
  let baseHref: string | null = null;
  let nextElementIndex = 0;
  let omittedElements = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) continue;
    const { node } = item;
    let childParentIndex = item.parentIndex;
    if (
      defaultTreeAdapter.isElementNode(node) &&
      node.namespaceURI === "http://www.w3.org/1999/xhtml"
    ) {
      const elementIndex = nextElementIndex++;
      childParentIndex = elementIndex;
      const location = node.sourceCodeLocation?.startTag;
      if (elements.length < maximumElements) {
        elements.push({
          elementIndex,
          parentIndex: item.parentIndex,
          tagName: node.tagName,
          attributes: Object.fromEntries(
            node.attrs
              .filter(
                ({ name }) =>
                  name === "id" ||
                  name === "class" ||
                  name === "role" ||
                  name === "open" ||
                  name === "hidden" ||
                  name === "type" ||
                  name.startsWith("aria-") ||
                  name.startsWith("data-"),
              )
              .map(({ name, value }) => [name, value]),
          ),
          startOffset: location?.startOffset ?? null,
          endOffset: location?.endOffset ?? null,
        });
      } else omittedElements += 1;
      if (node.tagName === "base" && baseHref === null) {
        const href = node.attrs.find(({ name }) => name === "href");
        if (href !== undefined) baseHref = href.value;
      }
      if (node.tagName === "script") {
        const src = node.attrs.find(({ name }) => name === "src");
        const location = node.sourceCodeLocation?.startTag;
        if (src !== undefined && src.value !== "" && location !== undefined) {
          scripts.push({
            scriptPath: src.value,
            startOffset: location.startOffset,
            endOffset: location.endOffset,
          });
        }
      }
      if (node.tagName === "link") {
        const rel = node.attrs.find(({ name }) => name === "rel")?.value;
        const href = node.attrs.find(({ name }) => name === "href")?.value;
        if (
          rel?.toLowerCase().split(/\s+/u).includes("stylesheet") === true &&
          href !== undefined &&
          href !== "" &&
          location !== undefined
        ) {
          stylesheets.push({
            stylesheetPath: href,
            media:
              node.attrs.find(({ name }) => name === "media")?.value ?? null,
            startOffset: location.startOffset,
            endOffset: location.endOffset,
          });
        }
      }
    }
    // Template content belongs to a separate inert document fragment. Only
    // traverse the actual document children, without recursion on deep input.
    if ("childNodes" in node) {
      for (const child of node.childNodes.toReversed())
        pending.push({ node: child, parentIndex: childParentIndex });
    }
  }
  return { baseHref, scripts, stylesheets, elements, omittedElements };
};
