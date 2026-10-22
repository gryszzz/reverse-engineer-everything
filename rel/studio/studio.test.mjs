import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startStudio } from "./server.mjs";

const root = mkdtempSync(join(tmpdir(), "ree-studio-"));
const dataDir = join(root, "data");
const studio = await startStudio({ dataDir });
const origin = studio.url.slice(0, -1);

after(() => {
  studio.server.close();
  rmSync(root, { recursive: true, force: true });
});

function raw(path, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: studio.server.address().port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function api(path, options = {}) {
  const headers = { "x-ree-studio-token": studio.token };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(origin + path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || response.statusText);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function settle(projectId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const project = await api(`/api/projects/${projectId}`);
    const busy = [...project.runs, ...project.experiments].some(
      (item) => item.status === "running",
    );
    if (!busy) return project;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Studio work did not finish.");
}

test("an unapproved trace does not start capture-process", async () => {
  const project = await api("/api/projects", {
    method: "POST",
    body: { name: "Trace", question: "What ran?", mode: "simple" },
  });
  await assert.rejects(
    () =>
      api(`/api/projects/${project.id}/trace`, {
        method: "POST",
        body: { approved: false },
      }),
    (error) => error.status === 403,
  );
  const after = await api(`/api/projects/${project.id}`);
  assert.equal(after.trace, undefined);
});

test("diff lab leaves behavior unknown for two owned source files", async () => {
  const project = await api("/api/projects", {
    method: "POST",
    body: { name: "Diff lab", question: "What changed?", mode: "simple" },
  });
  const root = fileURLToPath(
    new URL("../../experiments/ree-investigation-boundary/", import.meta.url),
  );
  const left = await api(`/api/projects/${project.id}/artifacts`, {
    method: "POST",
    body: { path: `${root}authority.c` },
  });
  const right = await api(`/api/projects/${project.id}/artifacts`, {
    method: "POST",
    body: { path: `${root}candidate.c` },
  });
  const diff = await api(`/api/projects/${project.id}/diff-lab`, {
    method: "POST",
    body: {
      left_artifact_id: left.artifacts.at(-1).id,
      right_artifact_id: right.artifacts.at(-1).id,
    },
  });
  assert.equal(diff.behavior.status, "unknown");
  assert.equal(diff.functions.status, "unknown");
  assert.match(diff.text.lines.join("\n"), /floor/);
});

test("lessons stay on owned fixtures and an unknown id is 404", async () => {
  const catalog = await api("/api/lessons");
  assert.equal(catalog.lessons.length, 4);
  const lesson = await api("/api/lessons/compare-versions");
  assert.match(lesson.steps[0].observation.note, /Behavior is unknown/);
  await assert.rejects(
    () => api("/api/lessons/nope"),
    (error) => error.status === 404,
  );
});

test("the studio binds only to loopback and serves its own page", async () => {
  assert.equal(studio.server.address().address, "127.0.0.1");
  const page = await fetch(studio.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Investigation Studio/);
  assert.match(
    page.headers.get("content-security-policy"),
    /connect-src 'self'/,
  );
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  const hidden = await fetch(origin + "/README.md");
  assert.equal(hidden.status, 404);
  const explain = await fetch(origin + "/explain.js");
  assert.equal(explain.status, 200);
  assert.match(await explain.text(), /local-template/);
  const script = await fetch(origin + "/studio.js");
  const source = await script.text();
  assert.match(source, /What can I do with this\?/);
  assert.match(source, /Explain this/);
  assert.match(source, /Keyboard shortcuts/);
});

test("state-changing requests require the loopback token and JSON", async () => {
  const missing = await raw("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: `127.0.0.1:${studio.server.address().port}`,
    },
    body: "{}",
  });
  assert.equal(missing.status, 401);
  const foreign = await raw("/api/readiness", {
    headers: {
      host: "evil.example",
      "x-ree-studio-token": studio.token,
    },
  });
  assert.equal(foreign.status, 403);
  const cross = await raw("/api/projects", {
    method: "POST",
    headers: {
      host: `127.0.0.1:${studio.server.address().port}`,
      origin: "http://evil.example",
      "content-type": "application/json",
      "x-ree-studio-token": studio.token,
    },
    body: "{}",
  });
  assert.equal(cross.status, 403);
});

test("projects persist across a restarted studio process", async () => {
  const created = await api("/api/projects", {
    method: "POST",
    body: {
      name: "Resume me",
      question: "Which files import which?",
      mode: "simple",
    },
  });
  const again = await startStudio({ dataDir, port: 0 });
  try {
    const listed = await fetch(again.url + "api/projects", {
      headers: { "x-ree-studio-token": again.token },
    });
    const body = await listed.json();
    assert.equal(
      body.projects.some((project) => project.id === created.id),
      true,
    );
    const read = await fetch(again.url + `api/projects/${created.id}`, {
      headers: { "x-ree-studio-token": again.token },
    });
    assert.equal((await read.json()).question, "Which files import which?");
  } finally {
    again.server.close();
  }
});

test("owned-fixture intake does not analyze, and readiness stays honest", async () => {
  const project = await api("/api/projects", {
    method: "POST",
    body: { name: "Fixture", question: "Which files import which?" },
  });
  const withArtifact = await api(
    `/api/projects/${project.id}/artifacts/owned-fixture`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(withArtifact.artifacts[0].intake.kind, "javascript");
  assert.equal(withArtifact.runs.length, 0);
  const readiness = await api("/api/readiness");
  const ghidra = readiness.routes.find((route) => route.id === "ghidra");
  const javascript = readiness.routes.find(
    (route) => route.id === "javascript-static",
  );
  const remote = readiness.routes.find((route) => route.id === "remote-model");
  assert.equal(ghidra.studio, "implemented");
  if (!process.env.GHIDRA_INSTALL_DIR) {
    assert.equal(ghidra.status, "not-configured");
    assert.match(ghidra.notes, /does not install Ghidra/);
  }
  assert.equal(ghidra.verified_on_host, "not-recorded");
  assert.equal(javascript.studio, "implemented");
  assert.equal(javascript.verified_on_host, "not-recorded");
  assert.equal(remote.studio, "unsupported");
  assert.equal(
    readiness.routes.every((route) => route.verified_on_host !== "tested"),
    true,
  );
});

test("analysis without authorization is refused and a missing runtime is recorded as failure", async () => {
  const project = await api("/api/projects", {
    method: "POST",
    body: { name: "Analyze" },
  });
  const withArtifact = await api(
    `/api/projects/${project.id}/artifacts/owned-fixture`,
    {
      method: "POST",
      body: {},
    },
  );
  await assert.rejects(
    api(`/api/projects/${project.id}/runs`, {
      method: "POST",
      body: { artifact_id: withArtifact.artifacts[0].id, authorized: false },
    }),
    /authorized: true/,
  );
  const runtime = fileURLToPath(
    new URL("../../dist/cli-runtime/cli.js", import.meta.url),
  );
  if (existsSync(runtime)) return;
  await assert.rejects(
    api(`/api/projects/${project.id}/runs`, {
      method: "POST",
      body: { artifact_id: withArtifact.artifacts[0].id, authorized: true },
    }),
    /missing-tool/,
  );
  assert.equal((await api(`/api/projects/${project.id}`)).runs.length, 0);
});

test("research is off by default and local stages do not claim a model ran", async () => {
  const config = await api("/api/research");
  assert.equal(config.enabled, false);
  assert.equal(config.remote_calls, "refused");
  const project = await api("/api/projects", {
    method: "POST",
    body: { name: "Notes", question: "Which files import which?" },
  });
  await assert.rejects(
    api(`/api/projects/${project.id}/research`, { method: "POST", body: {} }),
    /Research is off/,
  );
  await api("/api/research", { method: "PUT", body: { enabled: true } });
  const updated = await api(
    `/api/projects/${project.id}/artifacts/owned-fixture`,
    {
      method: "POST",
      body: {},
    },
  );
  const researched = await api(`/api/projects/${updated.id}/research`, {
    method: "POST",
    body: {},
  });
  const session = researched.research_sessions.at(-1);
  assert.equal(session.remote_calls, "refused");
  assert.ok(session.tool_calls <= session.tool_call_budget);
  assert.equal(
    session.stages.some(
      (stage) => stage.id === "MAPPER" && stage.status === "not-run",
    ),
    true,
  );
  await api("/api/research", { method: "PUT", body: { enabled: false } });
});

test("the owned probe requires digest approval and keeps runtime output separate", async () => {
  const project = await api("/api/projects", {
    method: "POST",
    body: { name: "Probe" },
  });
  const preview = await api(`/api/projects/${project.id}/experiments/preview`);
  assert.equal(preview.query, "bridge");
  assert.match(preview.argv.join(" "), /owned-fixture-probe\.mjs/);
  assert.equal(
    (await api(`/api/projects/${project.id}`)).experiments.length,
    0,
  );
  await assert.rejects(
    api(`/api/projects/${project.id}/experiments`, {
      method: "POST",
      body: { approved: true, plan_digest: "0".repeat(64) },
    }),
    /preview changed/,
  );
  await assert.rejects(
    api(`/api/projects/${project.id}/experiments`, {
      method: "POST",
      body: { approved: false, plan_digest: preview.plan_digest },
    }),
    /approved: true/,
  );
  const started = await api(`/api/projects/${project.id}/experiments`, {
    method: "POST",
    body: { approved: true, plan_digest: preview.plan_digest },
  });
  const finished = await settle(started.id);
  const experiment = finished.experiments.at(-1);
  assert.equal(experiment.status, "completed");
  assert.deepEqual(experiment.observation.ids, ["N-102", "N-101", "N-104"]);
  assert.equal(experiment.engine_reassessment, "not-run");
  assert.equal(
    experiment.comparison.find(
      (item) => item.hypothesis_id === "title-weighted",
    ).matches,
    true,
  );
  assert.equal(
    experiment.comparison.find((item) => item.hypothesis_id === "tag-first")
      .matches,
    false,
  );
  assert.equal(finished.runs.length, 0);
  const report = await api(`/api/projects/${project.id}/report`);
  assert.match(report.markdown, /query bridge/);
  assert.match(report.markdown, /title\\-weighted: matched the capture/);
  assert.doesNotMatch(report.markdown, /ev_[a-f0-9]{64}/u);
});

test("a different fixture is refused by the probe", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./owned-fixture-probe.mjs", import.meta.url)),
      "--fixture",
      root,
      "--query",
      "bridge",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refuses every target/);
});

test("studio data inside the checkout is rejected", async () => {
  await assert.rejects(
    startStudio({
      dataDir: fileURLToPath(new URL("../../rel/studio-data", import.meta.url)),
    }),
    /outside the REE checkout/,
  );
});
