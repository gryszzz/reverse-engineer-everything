import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { extractOpenApi } from "../outside-in/extract-openapi.mjs";
import { coverageDecision } from "./coverage.mjs";
import { measureDeskCoverage } from "./coverage-gate.mjs";
import { planProduct } from "./scaffold.mjs";

function row(id, name, match) {
  return { id, name, match, route: null };
}

test("feature coverage fails under 80 percent", () => {
  const decision = coverageDecision({
    features: [
      row("feature:a", "A", "pass"),
      row("feature:b", "B", "pass"),
      row("feature:c", "C", "pass"),
      row("feature:d", "D", "unimplemented"),
      row("feature:e", "E", "unimplemented"),
    ],
  });
  assert.equal(decision.passed, false);
  assert.equal(decision.ratio, 0.6);
  assert.equal(decision.left_out, 2);
  const exact = coverageDecision({
    features: [
      row("feature:a", "A", "pass"),
      row("feature:b", "B", "pass"),
      row("feature:c", "C", "pass"),
      row("feature:d", "D", "pass"),
      row("feature:e", "E", "unimplemented"),
    ],
  });
  assert.equal(exact.passed, true);
  assert.equal(exact.ratio, 0.8);
});

test("the owned desk fixture stays at or above 80 percent", async () => {
  const measured = await measureDeskCoverage();
  try {
    assert.equal(measured.verify.exit_code, 0, measured.verify.stderr);
    assert.ok(measured.spec.features.length >= 5);
    assert.equal(
      measured.decision.passed,
      true,
      JSON.stringify(measured.decision),
    );
    assert.ok(measured.decision.ratio >= 0.8);
    const byName = Object.fromEntries(
      measured.decision.features.map((feature) => [feature.name, feature]),
    );
    assert.equal(byName["Shared boards"].status, "implemented");
    assert.equal(byName["Create a board"].status, "implemented");
    assert.equal(byName["Pin a note"].status, "implemented");
    assert.equal(byName["Invite a member"].status, "implemented");
    assert.equal(byName["Archive a board"].status, "implemented");
    assert.equal(byName["Open a board"].status, "implemented");
    assert.equal(byName["Open a board"].reason, null);
    assert.equal(byName["Open a board"].route.path, "/boards/{id}");
    const source = ["behaviors.mjs", "routes.mjs", "server.mjs"]
      .map((name) => readFileSync(join(measured.product, "src", name), "utf8"))
      .join("\n");
    assert.equal(source.includes("Desk Ledger"), false);
    assert.equal(source.includes("Open a board"), false);
    assert.equal(source.includes("People can open one board together."), false);
    assert.match(source, /listBoards/);
    assert.equal(source.includes("/boards/{id}"), true);
    assert.match(source, /"body": "json"/);
    const { listen: start } = await import(
      pathToFileURL(join(measured.product, "src/server.mjs")).href
    );
    const server = await start(0);
    try {
      const port = server.address().port;
      const listed = await fetch(`http://127.0.0.1:${port}/boards`);
      assert.equal(listed.status, 200);
      assert.ok(Array.isArray((await listed.json()).items));
      const created = await fetch(
        `http://127.0.0.1:${port}/boards?boardName=alpha`,
        { method: "POST" },
      );
      assert.equal(created.status, 201);
      const createdBody = await created.json();
      assert.equal(createdBody.boardName, "alpha");
      const opened = await fetch(
        `http://127.0.0.1:${port}/boards/${createdBody.id}`,
      );
      assert.equal(opened.status, 200);
      assert.equal((await opened.json()).id, createdBody.id);
      const missing = await fetch(`http://127.0.0.1:${port}/boards/missing-id`);
      assert.equal(missing.status, 404);
      const jsonCreated = await fetch(`http://127.0.0.1:${port}/boards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ boardName: "beta" }),
      });
      assert.equal(jsonCreated.status, 201);
      assert.equal((await jsonCreated.json()).boardName, "beta");
      const badJson = await fetch(`http://127.0.0.1:${port}/boards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      assert.equal(badJson.status, 400);
      assert.equal((await badJson.json()).error, "payload");
      const shared = await fetch(
        `http://127.0.0.1:${port}/shared-boards?label=alpha`,
        { method: "POST" },
      );
      assert.equal(shared.status, 201);
      const duplicate = await fetch(
        `http://127.0.0.1:${port}/shared-boards?label=alpha`,
        { method: "POST" },
      );
      assert.equal(duplicate.status, 400);
      assert.equal((await duplicate.json()).rule, "unique");
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
      const html = await page.text();
      assert.match(html, /data-path="\/boards"/);
      assert.match(html, /data-item="\/boards\/\{id\}"/);
      assert.match(html, /application\/json/);
      assert.match(html, /data-path="\/shared-boards"/);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  } finally {
    rmSync(measured.work, { recursive: true, force: true });
  }
});

test("one id segment is built and a longer template is left out", () => {
  const plan = planProduct({
    target: { name: "Example" },
    features: [
      { id: "feature:open", name: "Open" },
      { id: "feature:nested", name: "Nested" },
    ],
    limitations: [],
    api: {
      endpoints: [
        {
          method: "POST",
          path: "/boards",
          operation_id: "create",
          summary: { text: "Create" },
          parameters: ["boardName"],
          body: "json",
          response_codes: ["201"],
        },
        {
          method: "GET",
          path: "/boards/{id}",
          operation_id: "open",
          summary: { text: "Open" },
          parameters: [],
          response_codes: ["200"],
        },
        {
          method: "GET",
          path: "/boards/{id}/notes/{note}",
          operation_id: "nested",
          summary: { text: "Nested" },
          parameters: [],
          response_codes: ["200"],
        },
      ],
    },
  });
  const open = plan.behaviors.find((item) => item.id === "feature:open");
  const nested = plan.behaviors.find((item) => item.id === "feature:nested");
  assert.equal(open.status, "implemented");
  const read = plan.routes.find((route) => route.action === "read");
  assert.equal(read.path, "/boards/{id}");
  assert.equal(read.path_param, "id");
  assert.equal(
    read.resource,
    plan.routes.find((route) => route.path === "/boards").resource,
  );
  assert.equal(nested.status, "unimplemented");
  assert.equal(
    plan.leftOut.find((item) => item.id === "feature:nested").reason,
    "path template is not expanded",
  );
  const create = plan.routes.find(
    (route) => route.method === "POST" && route.path === "/boards",
  );
  assert.equal(create.body, "json");
  assert.deepEqual(create.parameters, ["boardName"]);
});

test("JSON body properties are read and a schema ref stays unknown", () => {
  const parsed = extractOpenApi(`
openapi: 3.0.3
info: { title: Notes, version: "1" }
paths:
  /notes:
    post:
      operationId: createNote
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                title: { type: string }
                note: { type: string }
  /refs:
    post:
      operationId: createRef
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Note"
`);
  const notes = parsed.endpoints.find((item) => item.path === "/notes");
  const refs = parsed.endpoints.find((item) => item.path === "/refs");
  assert.equal(notes.body, "json");
  assert.deepEqual(notes.parameters, ["title", "note"]);
  assert.equal(notes.unresolvedBody, 0);
  assert.equal(refs.body, null);
  assert.equal(refs.unresolvedBody, 1);
  assert.deepEqual(refs.parameters, []);
});
