import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startStudio } from "./server.mjs";

const runtimeReady = existsSync(
  new URL("../../dist/cli-runtime/cli.js", import.meta.url),
);

test(
  "the built REA runtime is present for studio engine integration",
  {
    skip: runtimeReady,
  },
  () => {
    assert.fail(
      "Built REA runtime missing. Run npm ci && npm run build:cached first.",
    );
  },
);

test(
  "the studio analyzes the owned fixture through the REA engine",
  {
    skip: !runtimeReady,
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "ree-studio-engine-"));
    const studio = await startStudio({ dataDir: join(root, "data") });
    const origin = studio.url.slice(0, -1);
    try {
      const api = async (path, options = {}) => {
        const headers = { "x-ree-studio-token": studio.token };
        if (options.body !== undefined)
          headers["content-type"] = "application/json";
        const response = await fetch(origin + path, {
          method: options.method ?? "GET",
          headers,
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        return data;
      };
      const project = await api("/api/projects", {
        method: "POST",
        body: {
          name: "Engine",
          question: "Which files import which?",
          mode: "advanced",
        },
      });
      const withArtifact = await api(
        `/api/projects/${project.id}/artifacts/owned-fixture`,
        {
          method: "POST",
          body: {},
        },
      );
      await api(`/api/projects/${project.id}/runs`, {
        method: "POST",
        body: {
          artifact_id: withArtifact.artifacts[0].id,
          authorized: true,
          question: "Which files import which?",
        },
      });
      let finished = null;
      for (let attempt = 0; attempt < 90; attempt += 1) {
        finished = await api(`/api/projects/${project.id}`);
        if (finished.runs.every((run) => run.status !== "running")) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const run = finished.runs[0];
      assert.equal(
        run.status,
        "completed",
        run.error || "analysis did not complete",
      );
      assert.match(run.evidence_id, /^ev_[a-f0-9]{64}$/u);
      assert.ok(run.summary.counts.nodes > 0);
      assert.ok(run.summary.counts.edges > 0);
      const found = await api(
        `/api/projects/${project.id}/runs/${run.id}/evidence?find=search.mjs&limit=5`,
      );
      assert.equal(found.evidence_id, run.evidence_id);
      assert.ok(found.edges.some((edge) => edge.relation === "imports"));
      const graph = await api(
        `/api/projects/${project.id}/runs/${run.id}/graph?find=cli.mjs&limit=20`,
      );
      const imported = graph.edges.find((edge) => edge.relation === "imports");
      assert.ok(
        imported,
        "the application graph did not include an import edge",
      );
      assert.equal(imported.basis, "inferred");
      assert.match(imported.interpretation, /not a captured execution/);
      const source = await api(
        `/api/projects/${project.id}/runs/${run.id}/source?edge_id=${encodeURIComponent(imported.edge_id)}`,
      );
      assert.equal(source.available, true, source.reason);
      assert.ok(source.lines.some((line) => line.highlighted));
      const resumed = await startStudio({ dataDir: studio.dataDir });
      try {
        const saved = await fetch(`${resumed.url}api/projects/${project.id}`, {
          headers: { "x-ree-studio-token": resumed.token },
        });
        const body = await saved.json();
        assert.equal(body.runs[0].evidence_id, run.evidence_id);
      } finally {
        resumed.server.close();
      }
    } finally {
      studio.server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
