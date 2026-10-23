import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { coverageDecision } from "./coverage.mjs";
import { measureDeskCoverage } from "./coverage-gate.mjs";

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
    assert.equal(byName["Open a board"].status, "left-out");
    assert.match(byName["Open a board"].reason, /path template/);
    const source = ["behaviors.mjs", "routes.mjs", "server.mjs"]
      .map((name) => readFileSync(join(measured.product, "src", name), "utf8"))
      .join("\n");
    assert.equal(source.includes("Desk Ledger"), false);
    assert.equal(source.includes("Open a board"), false);
    assert.equal(source.includes("People can open one board together."), false);
    assert.match(source, /listBoards/);
    assert.equal(source.includes("/boards/{id}"), false);
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
      assert.equal((await created.json()).boardName, "alpha");
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
      assert.match(html, /data-path="\/shared-boards"/);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  } finally {
    rmSync(measured.work, { recursive: true, force: true });
  }
});
