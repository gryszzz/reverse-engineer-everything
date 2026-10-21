import postcss, {
  type AtRule,
  type ChildNode,
  type Declaration,
  type Rule,
} from "postcss";

import {
  completeApplicationCoverage,
  partialApplicationCoverage,
  type ApplicationCoverage,
} from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import type { ApplicationNode } from "../../domain/javascript/javascriptApplicationGraphSchemas.js";
import type {
  JavaScriptDomStateWriteFact,
  JavaScriptSourceRange,
} from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type {
  JavaScriptHtmlElementObservation,
  JavaScriptHtmlStylesheetObservation,
} from "./JavaScriptArtifactAnalysisTypes.js";
import {
  artifactLocalIdentity,
  type JavaScriptArtifactGraphContext,
} from "./JavaScriptArtifactGraphContext.js";
import {
  astObservationEvidence,
  crossLayerInferenceEvidence,
  staticInferenceEvidence,
  structuredSourceObservationEvidence,
} from "./JavaScriptArtifactGraphEvidence.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";
import {
  matchWebSelector,
  type WebSelectorMatch,
} from "./JavaScriptWebSelector.js";

const MAX_WEB_CSS_BYTES = 5 * 1024 * 1024;
const MAX_CSS_RULES_PER_FILE = 10_000;
const MAX_CSS_RULES_TOTAL = 50_000;
const MAX_STYLE_MATCHES = 20_000;
const MAX_DECLARATIONS_PER_RULE = 16;
const MAX_CSS_VALUE_CHARS = 240;
const TRACED_STYLE_PROPERTIES = new Set([
  "display",
  "visibility",
  "opacity",
  "position",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "max-width",
  "height",
  "max-height",
  "overflow",
  "overflow-x",
  "overflow-y",
  "pointer-events",
  "z-index",
  "transform",
  "content",
  "background",
  "color",
  "border",
  "box-shadow",
  "animation",
  "transition",
]);

interface PageElements {
  readonly html: string;
  readonly values: readonly JavaScriptHtmlElementObservation[];
}

interface TracedElement {
  readonly page: PageElements;
  readonly value: JavaScriptHtmlElementObservation;
  readonly node: ApplicationNode;
}

interface CssDeclarationFact {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}

interface CssRuleFact {
  readonly selector: string;
  readonly location: JavaScriptSourceRange;
  readonly index: number;
  readonly conditions: readonly string[];
  readonly declarations: readonly CssDeclarationFact[];
  readonly nestedUnsupported: boolean;
}

/** Connect source-supported HTML, JavaScript and CSS facts in the existing Evidence graph. */
export const addJavaScriptWebLayerGraph = (
  context: JavaScriptArtifactGraphContext,
): string[] => {
  const limitations = new Set<string>();
  const pages = pageElements(context);
  const analysisByPath = new Map(
    context.analysis.files.map((analyzed) => [analyzed.file.path, analyzed]),
  );
  const loadedScripts = loadedScriptPages(context);
  const elementNodes = new Map<string, TracedElement>();
  const dynamicWritesByElement = new Map<
    string,
    JavaScriptDomStateWriteFact[]
  >();
  const listenerNodes = new Map<string, ApplicationNode>();
  const writeNodes = new Map<string, ApplicationNode>();
  const referencedElements = new Map<string, TracedElement>();

  const ensureElement = (
    page: PageElements,
    value: JavaScriptHtmlElementObservation,
  ): TracedElement | null => {
    const key = elementKey(page.html, value.element_index);
    const existing = elementNodes.get(key);
    if (existing !== undefined) return existing;
    const file = context.filesByPath.get(page.html);
    const fileNode = context.fileNodes.get(page.html);
    if (
      file === undefined ||
      fileNode === undefined ||
      value.location === null
    ) {
      limitations.add(
        `${page.html} has a matched HTML element without an exact source range or retained artifact node; that element was not projected into the graph.`,
      );
      return null;
    }
    const label = htmlElementLabel(value);
    const node = context.accumulator.addNode({
      kind: "web-element",
      identity: artifactLocalIdentity(
        file.sha256,
        "web-html-element",
        `${page.html}:${String(value.element_index)}`,
      ),
      observations: [
        {
          label,
          properties: {
            html_path: page.html,
            element_index: value.element_index,
            parent_index: value.parent_index,
            tag_name: value.tag_name,
            attributes: { ...value.attributes },
          },
          evidence: structuredSourceObservationEvidence({
            sha256: file.sha256,
            path: page.html,
            range: value.location,
            operation: "parse-html-web-element",
            coverage: htmlCoverage(context),
            limitations:
              context.analysis.html_element_omissions === 0
                ? []
                : ["The document's bounded element inventory is partial."],
          }),
        },
      ],
    });
    context.accumulator.addEdge({
      source_node_id: fileNode.node_id,
      target_node_id: node.node_id,
      relation: "contains",
      properties: {
        scope: "parsed-html-element",
        element_index: value.element_index,
      },
      evidence: structuredSourceObservationEvidence({
        sha256: file.sha256,
        path: page.html,
        range: value.location,
        operation: "locate-html-web-element",
        coverage: htmlCoverage(context),
      }),
    });
    const traced = { page, value, node } satisfies TracedElement;
    elementNodes.set(key, traced);
    referencedElements.set(key, traced);
    return traced;
  };

  for (const [javascriptPath, htmlPaths] of loadedScripts) {
    const analyzed = analysisByPath.get(javascriptPath);
    const javascript = analyzed?.javascript;
    if (
      analyzed === undefined ||
      javascript === null ||
      javascript === undefined
    ) {
      limitations.add(
        `HTML loads ${javascriptPath}, but its JavaScript DOM relationships are unavailable; cross-layer links remain unknown.`,
      );
      continue;
    }
    const dom = javascript.web_dom;
    if (dom.status === "partial") {
      limitations.add(
        `${javascriptPath} DOM facts are partial: ${dom.limitations.join(" ")}`,
      );
    }
    for (const message of dom.limitations)
      limitations.add(`${javascriptPath}: ${message}`);
    if (dom.listeners.length === 0) continue;
    const scriptNode = context.fileNodes.get(javascriptPath);
    const scriptFile = context.filesByPath.get(javascriptPath);
    if (scriptNode === undefined || scriptFile === undefined) continue;

    for (const [listenerIndex, listener] of dom.listeners.entries()) {
      const listenerKey = `${javascriptPath}:${listener.location.start.line}:${listener.location.start.column}:${String(listenerIndex)}`;
      let listenerNode = listenerNodes.get(listenerKey);
      if (listenerNode === undefined) {
        listenerNode = context.accumulator.addNode({
          kind: "web-event-listener",
          identity: artifactLocalIdentity(
            scriptFile.sha256,
            "web-dom-event-listener",
            listenerKey,
          ),
          observations: [
            {
              label: `${listener.event_name ?? "dynamic"} event listener`,
              properties: {
                source_path: javascriptPath,
                event_name: listener.event_name,
                target_selector: listener.target_selector,
                target_kind: listener.target_kind,
                target_selection: listener.target_selection,
                callback_name: listener.callback_name,
                writes: listener.writes.length,
                limitations: [...listener.limitations],
              },
              evidence: astObservationEvidence({
                sha256: scriptFile.sha256,
                path: javascriptPath,
                range: listener.location,
                operation: "parse-dom-event-registration",
                coverage: javascriptCoverage(javascript),
                limitations: listener.limitations,
              }),
            },
          ],
        });
        listenerNodes.set(listenerKey, listenerNode);
      }

      for (const htmlPath of htmlPaths) {
        const page = pages.get(htmlPath);
        if (page === undefined) {
          limitations.add(`${htmlPath} HTML element evidence is unavailable.`);
          continue;
        }
        if (listener.target_kind === "document") {
          limitations.add(
            `${javascriptPath} has a document-level ${listener.event_name ?? "dynamic"} handler; it is retained as a listener fact, but no single HTML element is claimed as its target.`,
          );
        } else if (
          listener.target_selector === null ||
          listener.target_kind === "unknown"
        ) {
          limitations.add(
            `${javascriptPath} has a ${listener.event_name ?? "dynamic"} handler whose target selector is unresolved.`,
          );
        } else {
          const selected = resolveElements(
            listener.target_selector,
            listener.target_selection,
            page,
            limitations,
            `${javascriptPath} listener`,
          );
          for (const selection of selected.values) {
            const element = ensureElement(page, selection);
            if (element === null) continue;
            context.accumulator.addEdge({
              source_node_id: listenerNode.node_id,
              target_node_id: element.node.node_id,
              relation: "listens_on",
              properties: {
                event_name: listener.event_name,
                selector: listener.target_selector,
                selection: listener.target_selection,
                match: selected.match,
                html_path: htmlPath,
              },
              evidence: crossLayerInferenceEvidence({
                sha256: scriptFile.sha256,
                path: javascriptPath,
                range: listener.location,
                operation: "reconcile-dom-listener-with-html-selector",
                coverage: combineCoverage(
                  javascriptCoverage(javascript),
                  htmlCoverage(context),
                ),
                confidence: selected.match === "unique" ? "high" : "medium",
                limitations: selected.limitations,
              }),
            });
          }
        }

        for (const [writeIndex, write] of listener.writes.entries()) {
          const writeKey = `${listenerKey}:${write.location.start.line}:${write.location.start.column}:${String(writeIndex)}`;
          let writeNode = writeNodes.get(writeKey);
          if (writeNode === undefined) {
            writeNode = context.accumulator.addNode({
              kind: "web-state-write",
              identity: artifactLocalIdentity(
                scriptFile.sha256,
                "web-dom-state-write",
                writeKey,
              ),
              observations: [
                {
                  label: `${write.operation} ${write.kind} ${write.name}`,
                  properties: {
                    source_path: javascriptPath,
                    target_selector: write.target_selector,
                    target_binding: write.target_binding,
                    target_selection: write.target_selection,
                    kind: write.kind,
                    operation: write.operation,
                    name: write.name,
                    value: write.value,
                    value_status: write.value_status,
                    call_chain: [...write.call_chain],
                  },
                  evidence: astObservationEvidence({
                    sha256: scriptFile.sha256,
                    path: javascriptPath,
                    range: write.location,
                    operation: "parse-dom-state-write",
                    coverage: javascriptCoverage(javascript),
                    limitations: [
                      "The assigned expression and surrounding conditions are not evaluated.",
                    ],
                  }),
                },
              ],
            });
            writeNodes.set(writeKey, writeNode);
          }
          context.accumulator.addEdge({
            source_node_id: listenerNode.node_id,
            target_node_id: writeNode.node_id,
            relation: "updates_state",
            properties: {
              call_chain: [...write.call_chain],
              callback_name: listener.callback_name,
              event_name: listener.event_name,
            },
            evidence: staticInferenceEvidence({
              sha256: scriptFile.sha256,
              path: javascriptPath,
              range: write.location,
              operation: "link-event-handler-to-dom-write",
              coverage: javascriptCoverage(javascript),
              limitations: [
                "Only unique, direct local function calls are followed; control flow is not evaluated.",
              ],
            }),
          });
          if (write.target_selector === null) {
            limitations.add(
              `${javascriptPath} has a ${write.kind} write to ${write.name} whose DOM target is unresolved.`,
            );
            continue;
          }
          const targets = resolveElements(
            write.target_selector,
            write.target_selection,
            page,
            limitations,
            `${javascriptPath} state write`,
          );
          for (const target of targets.values) {
            const element = ensureElement(page, target);
            if (element === null) continue;
            if (
              write.kind === "property" &&
              (write.name !== "open" ||
                (target.tag_name !== "details" && target.tag_name !== "dialog"))
            )
              limitations.add(
                `${javascriptPath}: property ${write.name} on ${target.tag_name} has no supported HTML attribute reflection; its CSS attribute relationship remains unknown.`,
              );
            const existingWrites =
              dynamicWritesByElement.get(
                elementKey(htmlPath, target.element_index),
              ) ?? [];
            existingWrites.push(write);
            dynamicWritesByElement.set(
              elementKey(htmlPath, target.element_index),
              existingWrites,
            );
            context.accumulator.addEdge({
              source_node_id: writeNode.node_id,
              target_node_id: element.node.node_id,
              relation: "writes_state",
              properties: {
                selector: write.target_selector,
                kind: write.kind,
                operation: write.operation,
                name: write.name,
                value: write.value,
                value_status: write.value_status,
                target_match: targets.match,
                call_chain: [...write.call_chain],
                html_path: htmlPath,
              },
              evidence: crossLayerInferenceEvidence({
                sha256: scriptFile.sha256,
                path: javascriptPath,
                range: write.location,
                operation: "reconcile-dom-write-with-html-selector",
                coverage: combineCoverage(
                  javascriptCoverage(javascript),
                  htmlCoverage(context),
                ),
                confidence: targets.match === "unique" ? "high" : "medium",
                limitations: targets.limitations,
              }),
            });
          }
        }
      }
    }
  }

  const stylesheetObservations = groupStylesheets(
    context.analysis.html_stylesheets,
  );
  const rulesByCss = new Map<string, readonly CssRuleFact[]>();
  let cssRuleTotal = 0;
  let cssRuleOmissions = 0;
  let cssRuleBudgetReached = false;
  let styleMatches = 0;
  for (const [htmlPath, observations] of stylesheetObservations) {
    const page = pages.get(htmlPath);
    if (page === undefined) continue;
    const htmlFile = context.filesByPath.get(htmlPath);
    const htmlNode = context.fileNodes.get(htmlPath);
    if (htmlFile === undefined || htmlNode === undefined) continue;
    const styleSheetPaths = new Map<
      string,
      JavaScriptHtmlStylesheetObservation[]
    >();
    for (const observation of observations) {
      const resolution = resolveArtifactPathByContext({
        declaredPath: observation.stylesheet_path,
        sourcePath: htmlPath,
        context: "url-reference",
        files: context.filesByPath,
        htmlBaseHref: observation.base_href,
      });
      if (resolution.resolved_path === null) {
        limitations.add(
          `${htmlPath} references stylesheet ${observation.stylesheet_path}, which is ${resolution.resolution_status}; its styles remain unknown.`,
        );
        continue;
      }
      const cssPath = resolution.resolved_path;
      const existing = styleSheetPaths.get(cssPath) ?? [];
      existing.push(observation);
      styleSheetPaths.set(cssPath, existing);
      const cssNode = context.fileNodes.get(cssPath);
      const cssFile = context.filesByPath.get(cssPath);
      if (cssNode === undefined || cssFile === undefined) {
        limitations.add(
          `${htmlPath} stylesheet ${cssPath} is not retained in the analysis scope.`,
        );
        continue;
      }
      context.accumulator.addEdge({
        source_node_id: htmlNode.node_id,
        target_node_id: cssNode.node_id,
        relation: "loads",
        properties: {
          declared_path: observation.stylesheet_path,
          resolved_path: cssPath,
          media: observation.media,
          resolution_status: resolution.resolution_status,
        },
        evidence: staticInferenceEvidence({
          sha256: htmlFile.sha256,
          path: htmlPath,
          range: observation.location,
          operation: "resolve-html-stylesheet-reference",
          coverage: htmlCoverage(context),
          limitations: resolution.limitations,
        }),
      });
    }
    if (referencedElements.size === 0) continue;
    const pageTargets = [...referencedElements.values()].filter(
      ({ page: targetPage }) => targetPage.html === htmlPath,
    );
    if (pageTargets.length === 0) continue;

    for (const [cssPath, declarations] of styleSheetPaths) {
      if (styleMatches >= MAX_STYLE_MATCHES) {
        limitations.add(
          `Cross-layer CSS matching reached its ${String(MAX_STYLE_MATCHES)} relationship limit; further style relationships are unknown.`,
        );
        continue;
      }
      const cssFile = context.filesByPath.get(cssPath);
      if (cssFile === undefined || !cssFile.text.included) {
        limitations.add(`${cssPath} stylesheet contents are unavailable.`);
        continue;
      }
      if (cssFile.bytes > MAX_WEB_CSS_BYTES) {
        limitations.add(
          `${cssPath} exceeds the ${String(MAX_WEB_CSS_BYTES)} byte CSS analysis limit; style relationships are unknown.`,
        );
        continue;
      }
      let rules = rulesByCss.get(cssPath);
      if (rules === undefined) {
        const remainingRuleBudget = Math.max(
          0,
          MAX_CSS_RULES_TOTAL - cssRuleTotal,
        );
        if (remainingRuleBudget === 0) {
          cssRuleBudgetReached = true;
          limitations.add(
            `Cross-layer CSS analysis reached its ${String(MAX_CSS_RULES_TOTAL)} total rule limit; later stylesheet rules remain unknown.`,
          );
          continue;
        }
        const parsed = parseCssRules(
          cssPath,
          cssFile.text.value,
          Math.min(MAX_CSS_RULES_PER_FILE, remainingRuleBudget),
        );
        if (parsed.error !== null) {
          limitations.add(`${cssPath} CSS parsing failed: ${parsed.error}`);
          continue;
        }
        rules = parsed.rules;
        rulesByCss.set(cssPath, rules);
        cssRuleTotal += rules.length;
        cssRuleOmissions += parsed.omittedRules;
        if (parsed.omittedRules > 0)
          limitations.add(
            `${cssPath} CSS rule limit omitted ${String(parsed.omittedRules)} rules; additional selector relationships remain unknown.`,
          );
        limitations.add(
          `${cssPath} cross-layer tracing retains only selected CSS properties, with at most ${String(MAX_DECLARATIONS_PER_RULE)} selected declarations per rule; other declarations are not projected and may have additional effects.`,
        );
        if (parsed.omittedDeclarations > 0)
          limitations.add(
            `${cssPath} omitted ${String(parsed.omittedDeclarations)} selected CSS declarations beyond the per-rule retention limit; those declaration values remain unknown.`,
          );
        if (parsed.imports > 0)
          limitations.add(
            `${cssPath} contains ${String(parsed.imports)} CSS @import reference(s); imported stylesheets are not followed by this static trace.`,
          );
        if (parsed.nestedRules > 0)
          limitations.add(
            `${cssPath} contains nested CSS rules whose parent selectors are not expanded; those style relationships remain unknown.`,
          );
      }
      const stylesheetConditions = unique(
        declarations
          .map(({ media }) => (media === null ? null : `link media: ${media}`))
          .filter((value): value is string => value !== null),
      );
      const pageDynamicWrites = new Map<
        number,
        readonly JavaScriptDomStateWriteFact[]
      >(
        page.values.map((value) => [
          value.element_index,
          dynamicWritesByElement.get(
            elementKey(htmlPath, value.element_index),
          ) ?? [],
        ]),
      );
      styleElementLoop: for (const element of pageTargets) {
        const writes =
          dynamicWritesByElement.get(
            elementKey(htmlPath, element.value.element_index),
          ) ?? [];
        for (const rule of rules) {
          const match = matchWebSelector(
            rule.selector,
            page.values,
            element.value,
            pageDynamicWrites,
          );
          if (match.status === "unsupported") {
            if (selectorCouldBeRelevant(rule.selector, element.value))
              limitations.add(
                `${cssPath} selector ${rule.selector} uses syntax outside REE's supported static subset; its relationship to ${htmlPath} element ${String(element.value.element_index)} is unknown.`,
              );
            continue;
          }
          if (match.status !== "matched") continue;
          if (styleMatches >= MAX_STYLE_MATCHES) {
            limitations.add(
              `Cross-layer CSS matching reached its ${String(MAX_STYLE_MATCHES)} relationship limit; further style relationships are unknown.`,
            );
            break styleElementLoop;
          }
          if (rule.declarations.length === 0) continue;
          const cssNode = context.fileNodes.get(cssPath);
          if (cssNode === undefined) continue;
          const conditions = unique([
            ...stylesheetConditions,
            ...rule.conditions,
            ...match.conditions,
          ]);
          const styleNode = context.accumulator.addNode({
            kind: "web-style-rule",
            identity: artifactLocalIdentity(
              cssFile.sha256,
              "web-css-style-rule",
              `${cssPath}:${rule.location.start.line}:${rule.location.start.column}:${rule.selector}:${String(rule.index)}`,
            ),
            observations: [
              {
                label: rule.selector,
                properties: {
                  css_path: cssPath,
                  selector: rule.selector,
                  conditions,
                  declarations: rule.declarations.map((declaration) => ({
                    ...declaration,
                  })),
                  nested_selector_context: rule.nestedUnsupported,
                },
                evidence: structuredSourceObservationEvidence({
                  sha256: cssFile.sha256,
                  path: cssPath,
                  range: rule.location,
                  operation: "parse-css-style-rule",
                  coverage: completeApplicationCoverage(),
                  limitations: [
                    "Selectors are matched by REE's bounded static subset; CSS cascade and computed values are not evaluated.",
                  ],
                }),
              },
            ],
          });
          context.accumulator.addEdge({
            source_node_id: element.node.node_id,
            target_node_id: styleNode.node_id,
            relation: "may_style",
            properties: {
              html_path: htmlPath,
              css_path: cssPath,
              selector: rule.selector,
              match:
                conditions.length === 0
                  ? "static-selector-match"
                  : "conditional-selector-match",
              conditions,
              declarations: rule.declarations.map((declaration) => ({
                ...declaration,
              })),
              supporting_state_write_count: writes.length,
            },
            evidence: crossLayerInferenceEvidence({
              sha256: cssFile.sha256,
              path: cssPath,
              range: rule.location,
              operation: "reconcile-css-selector-with-html-and-dom-state",
              coverage:
                context.analysis.html_element_omissions > 0 ||
                cssRuleOmissions > 0 ||
                cssRuleBudgetReached
                  ? partialApplicationCoverage([], null)
                  : completeApplicationCoverage(),
              confidence: conditions.length === 0 ? "high" : "medium",
              limitations: [
                "A selector match is a potential style relationship only; source order, specificity, media conditions, browser state, and computed rendering were not executed.",
                ...(conditions.length === 0 ? [] : conditions),
              ],
            }),
          });
          styleMatches += 1;
        }
      }
    }
  }
  return [...limitations].sort();
};

const resolveElements = (
  selector: string,
  selection: "one" | "many" | null,
  page: PageElements,
  limitations: Set<string>,
  sourceLabel: string,
): {
  readonly values: readonly JavaScriptHtmlElementObservation[];
  readonly match: "unique" | "many" | "first-static-match";
  readonly limitations: readonly string[];
} => {
  const candidates: JavaScriptHtmlElementObservation[] = [];
  let unsupported = false;
  for (const value of page.values) {
    const result = matchWebSelector(selector, page.values, value);
    if (result.status === "unsupported") unsupported = true;
    else if (result.status === "matched") candidates.push(value);
  }
  if (unsupported) {
    const message = `${sourceLabel} selector ${selector} uses unsupported or dynamic syntax; no HTML relationship is inferred.`;
    limitations.add(message);
    return { values: [], match: "many", limitations: [message] };
  }
  if (candidates.length === 0) {
    const message = `${sourceLabel} selector ${selector} matched no retained element in ${page.html}; this may be an absent element, an incomplete inventory, or dynamic markup.`;
    limitations.add(message);
    return { values: [], match: "many", limitations: [message] };
  }
  if (selection === "one" && candidates.length > 1) {
    const first = candidates[0];
    const message = `${sourceLabel} selector ${selector} matched ${String(candidates.length)} static elements; the first source-order match is shown, but runtime DOM mutation could change it.`;
    limitations.add(message);
    return {
      values: first === undefined ? [] : [first],
      match: "first-static-match",
      limitations: [message],
    };
  }
  if (candidates.length > 1) {
    const message = `${sourceLabel} selector ${selector} matched ${String(candidates.length)} static elements.`;
    limitations.add(message);
    return { values: candidates, match: "many", limitations: [message] };
  }
  return { values: candidates, match: "unique", limitations: [] };
};

const pageElements = (
  context: JavaScriptArtifactGraphContext,
): Map<string, PageElements> => {
  const grouped = new Map<string, JavaScriptHtmlElementObservation[]>();
  for (const element of context.analysis.html_elements) {
    const values = grouped.get(element.html_path) ?? [];
    values.push(element);
    grouped.set(element.html_path, values);
  }
  return new Map(
    [...grouped.entries()].map(([html, values]) => [
      html,
      {
        html,
        values,
      },
    ]),
  );
};

const loadedScriptPages = (
  context: JavaScriptArtifactGraphContext,
): Map<string, readonly string[]> => {
  const pages = new Map<string, Set<string>>();
  for (const script of context.analysis.html_scripts) {
    const resolution = resolveArtifactPathByContext({
      declaredPath: script.script_path,
      sourcePath: script.html_path,
      context: "html-reference",
      files: context.filesByPath,
      htmlBaseHref: script.base_href,
    });
    if (resolution.resolved_path === null) continue;
    const existing = pages.get(resolution.resolved_path) ?? new Set<string>();
    existing.add(script.html_path);
    pages.set(resolution.resolved_path, existing);
  }
  return new Map(
    [...pages.entries()].map(([path, htmlPaths]) => [
      path,
      [...htmlPaths].sort(),
    ]),
  );
};

const groupStylesheets = (
  stylesheets: readonly JavaScriptHtmlStylesheetObservation[],
): Map<string, JavaScriptHtmlStylesheetObservation[]> => {
  const result = new Map<string, JavaScriptHtmlStylesheetObservation[]>();
  for (const stylesheet of stylesheets) {
    const existing = result.get(stylesheet.html_path) ?? [];
    existing.push(stylesheet);
    result.set(stylesheet.html_path, existing);
  }
  return result;
};

const parseCssRules = (
  path: string,
  source: string,
  maximumRules: number,
): {
  readonly rules: readonly CssRuleFact[];
  readonly error: string | null;
  readonly omittedRules: number;
  readonly omittedDeclarations: number;
  readonly imports: number;
  readonly nestedRules: number;
} => {
  let root: ReturnType<typeof postcss.parse>;
  try {
    root = postcss.parse(source, { from: path });
  } catch (cause: unknown) {
    return {
      rules: [],
      error: cause instanceof Error ? cause.message : String(cause),
      omittedRules: 0,
      omittedDeclarations: 0,
      imports: 0,
      nestedRules: 0,
    };
  }
  const rules: CssRuleFact[] = [];
  let totalRules = 0;
  let omittedDeclarations = 0;
  let imports = 0;
  let nestedRules = 0;
  const visit = (
    children: readonly ChildNode[],
    conditions: readonly string[],
    insideRule: boolean,
  ): void => {
    for (const child of children) {
      if (child.type === "atrule") {
        const atRule = child as AtRule;
        if (atRule.name.toLowerCase() === "import") imports += 1;
        if (atRule.nodes !== undefined)
          visit(
            atRule.nodes,
            [...conditions, `@${atRule.name} ${atRule.params}`.trim()],
            insideRule,
          );
      } else if (child.type === "rule") {
        const rule = child as Rule;
        totalRules += 1;
        if (insideRule) {
          nestedRules += 1;
          continue;
        }
        const location = postcssRange(rule);
        if (location !== null && rules.length < maximumRules) {
          const selectedDeclarations =
            rule.nodes
              ?.filter((node): node is Declaration => node.type === "decl")
              .filter((node) =>
                TRACED_STYLE_PROPERTIES.has(node.prop.toLowerCase()),
              ) ?? [];
          omittedDeclarations += Math.max(
            0,
            selectedDeclarations.length - MAX_DECLARATIONS_PER_RULE,
          );
          const declarations = selectedDeclarations
            .slice(0, MAX_DECLARATIONS_PER_RULE)
            .map((node) => ({
              property: node.prop.toLowerCase(),
              value: node.value.slice(0, MAX_CSS_VALUE_CHARS),
              important: node.important === true,
            }));
          rules.push({
            selector: rule.selector,
            location,
            index: rules.length,
            conditions,
            declarations,
            nestedUnsupported:
              rule.nodes?.some((node) => node.type === "rule") ?? false,
          });
        }
        if (rule.nodes !== undefined) visit(rule.nodes, conditions, true);
      }
    }
  };
  visit(root.nodes ?? [], [], false);
  return {
    rules,
    error: null,
    omittedRules: Math.max(0, totalRules - rules.length),
    omittedDeclarations,
    imports,
    nestedRules,
  };
};

const selectorCouldBeRelevant = (
  selector: string,
  element: JavaScriptHtmlElementObservation,
): boolean => {
  const id = element.attributes.id;
  const classes = (element.attributes.class ?? "").split(/\s+/u);
  return (
    (id !== undefined && selector.includes(`#${id}`)) ||
    classes.some((className) => selector.includes(`.${className}`)) ||
    selector.toLowerCase().includes(element.tag_name.toLowerCase())
  );
};

const htmlElementLabel = (
  element: JavaScriptHtmlElementObservation,
): string => {
  const id = element.attributes.id;
  const classes = (element.attributes.class ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 4)
    .map((value) => `.${value.slice(0, 64)}`)
    .join("");
  return `${element.tag_name}${id === undefined ? "" : `#${id.slice(0, 64)}`}${classes}`;
};

const elementKey = (html: string, elementIndex: number): string =>
  `${html}\u0000${String(elementIndex)}`;

const javascriptCoverage = (
  analysis: NonNullable<
    JavaScriptArtifactGraphContext["analysis"]["files"][number]["javascript"]
  >,
) =>
  analysis.parse_status === "complete" && analysis.web_dom.status === "complete"
    ? completeApplicationCoverage()
    : partialApplicationCoverage([], null);

const htmlCoverage = (context: JavaScriptArtifactGraphContext) =>
  context.analysis.html_element_omissions === 0
    ? completeApplicationCoverage()
    : partialApplicationCoverage([], null);

const combineCoverage = (
  left: ApplicationCoverage,
  right: ApplicationCoverage,
) =>
  left.status === "complete" && right.status === "complete"
    ? completeApplicationCoverage()
    : partialApplicationCoverage([], null);

const postcssRange = (node: {
  readonly source?: Rule["source"];
}): JavaScriptSourceRange | null => {
  const start = node.source?.start;
  const end = node.source?.end;
  if (start === undefined || end === undefined) return null;
  return {
    start: { line: start.line, column: Math.max(0, start.column - 1) },
    end: { line: end.line, column: Math.max(0, end.column - 1) },
  };
};

const unique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort();
