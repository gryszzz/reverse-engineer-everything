import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planStudioOutsideIn } from "./outside-in-run.mjs";
import { startStudio } from "./server.mjs";

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Notes</title>
    <meta name="description" content="Notes" />
  </head>
  <body>
    <section id="features">
      <h2>Features</h2>
      <h3>Notes</h3>
      <p>Keep one note.</p>
    </section>
  </body>
</html>`;

test("a pasted fixture URL runs outside-in and reaches build", async () => {
  const previous = process.env.REE_STUDIO_FIXTURE_HOST;
  const root = mkdtempSync(join(tmpdir(), "ree-outside-link-"));
  const fixture = createServer((req, res) => {
    if (req.url.startsWith("/robots.txt")) {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (req.url.startsWith("/empty")) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>Empty</title><p>Hello.</p>");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = fixture.address().port;
  process.env.REE_STUDIO_FIXTURE_HOST = `127.0.0.1:${port}`;
  const studio = await startStudio({ dataDir: join(root, "data") });
  const origin = studio.url.slice(0, -1);
  const api = async (path, body) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-ree-studio-token": studio.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.statusText);
    return payload;
  };
  try {
    assert.throws(
      () => planStudioOutsideIn("https://127.0.0.1/secret"),
      /public address/,
    );
    assert.throws(
      () => planStudioOutsideIn(`http://127.0.0.1:${port + 1}/notes`),
      /public address/,
    );
    assert.throws(
      () => planStudioOutsideIn("http://example.com/notes"),
      /https/,
    );

    const project = await api("/api/projects", {
      name: "Notes",
      question: "What can be rebuilt?",
      mode: "simple",
    });
    const input = `http://127.0.0.1:${port}/notes`;
    const plan = await api(`/api/projects/${project.id}/outside-in/plan`, {
      input,
    });
    assert.equal(plan.kind, "outside-in");
    assert.equal(plan.executes, false);
    assert.match(plan.note, /robots\.txt/);
    assert.match(plan.note, /no login/i);

    const started = await api(`/api/projects/${project.id}/outside-in`, {
      input,
      approved: true,
      plan_digest: plan.plan_digest,
      authorized: true,
    });
    assert.match(started.note, /recovered|rebuild/i);
    const run = started.project.runs.at(-1);
    assert.equal(run.kind, "outside-in");
    assert.equal(run.status, "completed");
    assert.equal(run.evidence_id, null);
    assert.equal(run.spec, undefined);
    assert.match(run.narrative.statements[0].text, /Notes/);
    assert.doesNotMatch(run.narrative.statements[0].text, /schema_version|\{/);

    const draft = await api(
      `/api/projects/${project.id}/runs/${run.id}/spec-draft`,
      {},
    );
    assert.ok(draft.features.length > 0);
    const live = await api("/api/live-builds", {
      product_name: "Note Desk",
      project_id: project.id,
      run_id: run.id,
      feature_ids: draft.features.map((feature) => feature.id),
    });
    const finished = await settle(api, live.live_id);
    assert.equal(finished.error, null);
    assert.equal(finished.status, "verified");

    const emptyPlan = await api(`/api/projects/${project.id}/outside-in/plan`, {
      input: `http://127.0.0.1:${port}/empty`,
    });
    const empty = await api(`/api/projects/${project.id}/outside-in`, {
      input: emptyPlan.input,
      approved: true,
      plan_digest: emptyPlan.plan_digest,
      authorized: true,
    });
    assert.match(empty.note, /does not support a rebuild/);
    assert.doesNotMatch(empty.note, /schema_version|\{/);
    const emptyDraft = await api(
      `/api/projects/${project.id}/runs/${empty.run_id}/spec-draft`,
      {},
    );
    assert.equal(emptyDraft.features.length, 0);
    await assert.rejects(
      () =>
        api("/api/live-builds", {
          product_name: "Note Desk",
          project_id: project.id,
          run_id: empty.run_id,
          feature_ids: [],
        }),
      /does not support a rebuild/,
    );
  } finally {
    studio.server.close();
    fixture.close();
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.REE_STUDIO_FIXTURE_HOST;
    else process.env.REE_STUDIO_FIXTURE_HOST = previous;
  }
});

async function settle(api, liveId) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    const snapshot = await api(`/api/live-builds/${liveId}`);
    if (snapshot.finished) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The build did not finish.");
}
