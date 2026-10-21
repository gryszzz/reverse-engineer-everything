import { describe, expect, it } from "vitest";

import type { JavaScriptDomStateWriteFact } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type { JavaScriptHtmlElementObservation } from "./JavaScriptArtifactAnalysisTypes.js";
import { matchWebSelector } from "./JavaScriptWebSelector.js";

const elements: JavaScriptHtmlElementObservation[] = [
  element(0, null, "header", { class: "site-header" }),
  element(1, 0, "button", { class: "menu-btn", "aria-expanded": "false" }),
  element(2, 0, "nav", { class: "nav-links" }),
  element(3, null, "aside", { class: "unrelated" }),
  element(4, 3, "nav", { class: "nav-links" }),
];

describe("bounded web selector reconciliation", () => {
  it("matches source-supported ancestor and child relationships", () => {
    expect(
      matchWebSelector(".site-header .nav-links", elements, elements[2]!),
    ).toEqual({
      status: "matched",
      conditions: [],
    });
    expect(
      matchWebSelector(".site-header > .menu-btn", elements, elements[1]!),
    ).toMatchObject({
      status: "matched",
    });
    expect(
      matchWebSelector(".site-header .nav-links", elements, elements[4]!),
    ).toMatchObject({
      status: "not-matched",
    });
  });

  it("marks class and attribute selector joins as conditional when JavaScript can write them", () => {
    const stateWrites = new Map<number, readonly JavaScriptDomStateWriteFact[]>(
      [
        [
          2,
          [
            write({
              kind: "class",
              operation: "toggle",
              name: "open",
              value_status: "dynamic",
            }),
          ],
        ],
        [
          1,
          [
            write({
              kind: "attribute",
              operation: "set",
              name: "aria-expanded",
              value_status: "dynamic",
            }),
          ],
        ],
      ],
    );

    expect(
      matchWebSelector(
        ".site-header .nav-links.open",
        elements,
        elements[2]!,
        stateWrites,
      ),
    ).toMatchObject({
      status: "matched",
      conditions: ["class .open depends on a matching JavaScript state write"],
    });
    expect(
      matchWebSelector(
        "button[aria-expanded=true]",
        elements,
        elements[1]!,
        stateWrites,
      ),
    ).toMatchObject({
      status: "matched",
      conditions: [
        "attribute [aria-expanded=true] depends on a matching JavaScript state write",
      ],
    });
  });
});

describe("HTML property reflection in CSS selectors", () => {
  it("does not turn expando properties into reflected HTML attributes", () => {
    const target = element(0, null, "div", {});
    for (const name of ["open", "customFlag"]) {
      expect(
        matchWebSelector(
          `div[${name}]`,
          [target],
          target,
          new Map([
            [
              0,
              [
                write({
                  kind: "property",
                  name,
                  value: "true",
                  value_status: "literal",
                }),
              ],
            ],
          ]),
        ).status,
      ).toBe("not-matched");
    }
  });

  it("distinguishes native boolean open reflection from literal attribute values", () => {
    for (const tag of ["details", "dialog"]) {
      const target = element(0, null, tag, {});
      const writes = new Map([
        [
          0,
          [
            write({
              kind: "property",
              name: "open",
              value: "true",
              value_status: "literal",
            }),
          ],
        ],
      ]);
      expect(
        matchWebSelector(`${tag}[open]`, [target], target, writes).status,
      ).toBe("matched");
      expect(
        matchWebSelector(`${tag}[open=""]`, [target], target, writes).status,
      ).toBe("matched");
      expect(
        matchWebSelector(`${tag}[open=true]`, [target], target, writes).status,
      ).toBe("not-matched");
      expect(
        matchWebSelector(`${tag}[open=false]`, [target], target, writes).status,
      ).toBe("not-matched");
      expect(
        matchWebSelector(
          `${tag}[open=true]`,
          [target],
          target,
          new Map([
            [
              0,
              [
                write({
                  kind: "attribute",
                  operation: "set",
                  name: "open",
                  value: "true",
                  value_status: "literal",
                }),
              ],
            ],
          ]),
        ).status,
      ).toBe("matched");
    }
  });
});

describe("web selector state write semantics", () => {
  it("does not treat removals, false toggles, or unrelated attributes as class additions", () => {
    for (const operation of ["remove", "toggle"] as const) {
      expect(
        matchWebSelector(
          ".nav-links.open",
          elements,
          elements[2]!,
          new Map([
            [
              2,
              [
                write({
                  kind: "class",
                  operation,
                  name: "open",
                  value: "false",
                  value_status: "literal",
                }),
              ],
            ],
          ]),
        ).status,
      ).toBe("not-matched");
    }
    expect(
      matchWebSelector(
        ".nav-links.open",
        elements,
        elements[2]!,
        new Map([
          [
            2,
            [
              write({
                kind: "attribute",
                operation: "set",
                name: "data-state",
                value: "open",
                value_status: "literal",
              }),
            ],
          ],
        ]),
      ).status,
    ).toBe("not-matched");
  });

  it("recognizes dynamic className assignments as conditional class writes", () => {
    expect(
      matchWebSelector(
        ".nav-links.open",
        elements,
        elements[2]!,
        new Map([
          [
            2,
            [
              write({
                kind: "class",
                operation: "set",
                name: "className",
                value_status: "dynamic",
              }),
            ],
          ],
        ]),
      ),
    ).toMatchObject({
      status: "matched",
      conditions: ["class .open depends on a matching JavaScript state write"],
    });
  });

  it("keeps unsupported functional selectors and native details state explicit", () => {
    expect(
      matchWebSelector(".nav-links:not(.closed)", elements, elements[2]!)
        .status,
    ).toBe("unsupported");
    const details = element(5, null, "details", {});
    expect(matchWebSelector("details[open]", [details], details)).toMatchObject(
      {
        status: "matched",
        conditions: [
          "native details open state was not evaluated; this selector describes a possible open state",
        ],
      },
    );
    const link = element(6, 2, "a", {});
    expect(
      matchWebSelector(".nav-links a:after", [...elements, link], link),
    ).toMatchObject({
      status: "matched",
      conditions: ["pseudo-element ::after is a style target"],
    });
  });
});

function element(
  element_index: number,
  parent_index: number | null,
  tag_name: string,
  attributes: Readonly<Record<string, string>>,
): JavaScriptHtmlElementObservation {
  return {
    html_path: "index.html",
    element_index,
    parent_index,
    tag_name,
    attributes,
    location: {
      start: { line: element_index + 1, column: 0 },
      end: { line: element_index + 1, column: 12 },
    },
  };
}

const write = (
  overrides: Partial<JavaScriptDomStateWriteFact>,
): JavaScriptDomStateWriteFact => ({
  target_selector: ".nav-links",
  target_binding: "menu",
  target_selection: "one",
  kind: "class",
  operation: "toggle",
  name: "open",
  value: null,
  value_status: "dynamic",
  call_chain: [],
  location: {
    start: { line: 1, column: 0 },
    end: { line: 1, column: 1 },
  },
  ...overrides,
});
