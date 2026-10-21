import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("JavaScript DOM static facts", () => {
  it("connects a literal listener query to bounded writes in a local helper", () => {
    const result = analyzeJavaScriptStaticSource(`
      const button = document.querySelector(".site-header .menu-btn");
      const menu = document.querySelector(".site-header .nav-links");
      function setOpen(open) {
        menu.classList.toggle("open", open);
        button.setAttribute("aria-expanded", String(open));
      }
      button.addEventListener("click", () => setOpen(!menu.classList.contains("open")));
      document.addEventListener("keydown", onKeydown);
    `);

    expect(result.web_dom.status).toBe("complete");
    expect(result.web_dom.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: "button",
          selector: ".site-header .menu-btn",
          selection: "one",
        }),
        expect.objectContaining({
          binding: "menu",
          selector: ".site-header .nav-links",
          selection: "one",
        }),
      ]),
    );
    expect(result.web_dom.listeners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_name: "click",
          target_selector: ".site-header .menu-btn",
          target_kind: "selector",
          writes: expect.arrayContaining([
            expect.objectContaining({
              target_selector: ".site-header .nav-links",
              kind: "class",
              operation: "toggle",
              name: "open",
              value_status: "dynamic",
              call_chain: ["setOpen"],
            }),
            expect.objectContaining({
              target_selector: ".site-header .menu-btn",
              kind: "attribute",
              operation: "set",
              name: "aria-expanded",
              value_status: "dynamic",
              call_chain: ["setOpen"],
            }),
          ]),
        }),
        expect.objectContaining({
          event_name: "keydown",
          target_kind: "document",
          target_selector: null,
        }),
      ]),
    );
  });

  it("preserves a many-target listener and does not guess dynamic selectors", () => {
    const result = analyzeJavaScriptStaticSource(`
      const cards = document.querySelectorAll(".card");
      cards.forEach((card) => {
        card.addEventListener("click", () => card.classList.add("active"));
      });
      document.querySelector(selector).classList.add("unknown");
    `);

    expect(result.web_dom.status).toBe("partial");
    expect(result.web_dom.listeners).toEqual([
      expect.objectContaining({
        event_name: "click",
        target_selector: ".card",
        target_kind: "selector",
        target_selection: "many",
        writes: [
          expect.objectContaining({
            target_selector: ".card",
            target_selection: "many",
            name: "active",
            operation: "add",
          }),
        ],
      }),
    ]);
    expect(result.web_dom.limitations.join(" ")).toMatch(
      /dynamic|unsupported/u,
    );
  });

  it("does not associate a shadowed selector binding with an unrelated listener", () => {
    const result = analyzeJavaScriptStaticSource(`
      const button = document.querySelector(".menu-btn");
      function register(button) {
        button.addEventListener("click", run);
      }
    `);

    expect(result.web_dom.listeners).toEqual([
      expect.objectContaining({
        event_name: "click",
        target_kind: "unknown",
        target_selector: null,
      }),
    ]);
    expect(result.web_dom.status).toBe("partial");
  });
});
