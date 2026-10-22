import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startStudio } from "./server.mjs";
import { parseProgressLine, readTimeline } from "./theater.mjs";
import {
  moduleComparisons,
  planOwnedNativeProbe,
  rebuildPlan,
  rebuildTimeline,
  writeRebuild,
} from "./rebuild.mjs";

const evidenceId = `ev_${"a".repeat(64)}`;

function sampleRecord() {
  return {
    evidence_id: evidenceId,
    normalized_result: {
      statistics: { parsed_javascript_files: 2, modules: 0, findings: 1 },
      graph: {
        nodes: [
          {
            kind: "javascript-module",
            node_id: "a",
            identity: { namespace: "source-module", key: "hash:cli.mjs" },
          },
          {
            kind: "javascript-module",
            node_id: "b",
            identity: { namespace: "source-module", key: "hash:search.mjs" },
          },
        ],
        edges: [
          {
            relation: "imports",
            source_node_id: "a",
            target_node_id: "b",
            properties: {
              specifier: "./search.mjs",
              resolved_path: "search.mjs",
            },
            evidence: {
              state: "inferred",
              authority: "static-relationship-inference",
            },
          },
        ],
      },
    },
  };
}

test("progress lines keep the engine phase and parsed file", () => {
  const event = parseProgressLine(
    '{"rea_progress":{"phase":"parse_javascript_source","completed":0,"total":1,"message":"Parsing and projecting cli.mjs (1/7)","sequence":4}}',
  );
  assert.equal(event.phase, "parse_javascript_source");
  assert.equal(event.file, "cli.mjs");
  assert.equal(event.file_index, 1);
  assert.equal(event.file_total, 7);
  assert.equal(event.source, "engine-progress");
  assert.equal(parseProgressLine("not json"), null);
});

test("a rebuild writes stubs from Evidence and does not copy source", () => {
  const output = mkdtempSync(join(tmpdir(), "ree-rebuild-parent-"));
  const destination = join(output, "map");
  try {
    const plan = rebuildPlan(sampleRecord(), destination);
    assert.equal(plan.modules[0].verification, "unverified");
    assert.equal(plan.modules[0].implementation, "reconstructed");
    const written = writeRebuild(sampleRecord(), destination, plan.digest);
    assert.equal(written.map_test, "green");
    assert.equal(written.behavior, "unverified");
    const stub = readFileSync(join(destination, "src", "search.mjs"), "utf8");
    assert.equal(stub.includes("function rank("), false);
    assert.match(stub, /No source text was copied/);
    assert.equal(existsSync(join(destination, "graph.svg")), true);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("a comparison shows the text mismatch and does not score a match", () => {
  const root = mkdtempSync(join(tmpdir(), "ree-compare-"));
  const artifact = join(root, "app");
  mkdirSync(artifact);
  writeFileSync(
    join(artifact, "search.mjs"),
    "export function rank(note, term) {\n  return 1;\n}\n",
  );
  writeFileSync(
    join(artifact, "cli.mjs"),
    "import { rank } from './search.mjs';\n",
  );
  try {
    const rows = moduleComparisons(sampleRecord(), artifact);
    const search = rows.find((row) => row.file === "search.mjs");
    assert.equal(search.verification, "unverified");
    assert.equal(search.engine_match, "not-scored");
    assert.equal(search.text_relation, "different");
    assert.match(search.diff, /function rank/);
    assert.equal(search.rebuilt_text.includes("function rank("), false);
    const events = rebuildTimeline({
      map_test: "green",
      modules: [{ file: "search.mjs" }],
    });
    assert.equal(events[0].source, "rebuild");
    assert.match(events.at(-1).message, /unverified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the native probe is limited to the owned C fixture", () => {
  assert.throws(
    () => planOwnedNativeProbe("/tmp", join(tmpdir(), "nope")),
    /ree-investigation-boundary/,
  );
  const output = join(mkdtempSync(join(tmpdir(), "ree-native-")), "out");
  const plan = planOwnedNativeProbe(
    fileURLToPath(
      new URL("../../experiments/ree-investigation-boundary/", import.meta.url),
    ),
    output,
  );
  assert.equal(plan.executes, "owned-fixture-only");
  assert.equal(plan.argv.at(-1), output);
  rmSync(join(output, ".."), { recursive: true, force: true });
});

test("the studio native probe refuses another artifact before it starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "ree-native-http-"));
  const studio = await startStudio({ dataDir: join(root, "data") });
  const origin = studio.url.slice(0, -1);
  const api = (path, options = {}) => {
    const headers = { "x-ree-studio-token": studio.token };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    return fetch(origin + path, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    }).then(async (response) => {
      const data = await response.json();
      return { status: response.status, data };
    });
  };
  try {
    const project = await api("/api/projects", {
      method: "POST",
      body: { name: "Native" },
    });
    const added = await api(`/api/projects/${project.data.id}/artifacts`, {
      method: "POST",
      body: { path: root },
    });
    const artifactId = added.data.artifacts.at(-1).id;
    const refused = await api(`/api/projects/${project.data.id}/native-probe`, {
      method: "POST",
      body: {
        artifact_id: artifactId,
        output: join(root, "out"),
        approved: false,
      },
    });
    assert.equal(refused.status, 403);
    const wrong = await api(`/api/projects/${project.data.id}/native-probe`, {
      method: "POST",
      body: {
        artifact_id: artifactId,
        output: join(root, "out"),
        approved: true,
      },
    });
    assert.equal(wrong.status, 409);
    assert.match(wrong.data.error, /ree-investigation-boundary/);
  } finally {
    studio.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const runtime = existsSync(
  fileURLToPath(new URL("../../dist/cli-runtime/cli.js", import.meta.url)),
);

test(
  "the studio timeline follows a real analysis of the owned fixture",
  { skip: runtime ? false : "Built REA runtime missing" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "ree-theater-"));
    const studio = await startStudio({ dataDir: join(root, "data") });
    const origin = studio.url.slice(0, -1);
    const api = (path, options = {}) => {
      const headers = { "x-ree-studio-token": studio.token };
      if (options.body !== undefined)
        headers["content-type"] = "application/json";
      return fetch(origin + path, {
        method: options.method ?? "GET",
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      }).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        return data;
      });
    };
    try {
      const project = await api("/api/projects", {
        method: "POST",
        body: { name: "Theater" },
      });
      const fixture = fileURLToPath(
        new URL("../../experiments/rel-first-lab/", import.meta.url),
      );
      const updated = await api(`/api/projects/${project.id}/artifacts`, {
        method: "POST",
        body: { path: fixture },
      });
      await api(`/api/projects/${project.id}/runs`, {
        method: "POST",
        body: {
          artifact_id: updated.artifacts.at(-1).id,
          authorized: true,
        },
      });
      let finished;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        finished = await api(`/api/projects/${project.id}`);
        if (finished.runs.every((run) => run.status !== "running")) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const run = finished.runs.at(-1);
      assert.equal(run.status, "completed", run.error);
      const timeline = await api(
        `/api/projects/${project.id}/runs/${run.id}/timeline`,
      );
      assert.ok(
        timeline.events.some(
          (event) =>
            event.phase === "parse_javascript_source" &&
            event.file === "cli.mjs",
        ),
      );
      assert.ok(timeline.events.some((event) => event.phase === "evidence"));
      const output = join(root, "rebuild");
      const preview = await api(
        `/api/projects/${project.id}/runs/${run.id}/rebuild/preview`,
        { method: "POST", body: { output } },
      );
      const refused = await fetch(
        `${origin}/api/projects/${project.id}/runs/${run.id}/rebuild`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-ree-studio-token": studio.token,
          },
          body: JSON.stringify({
            output,
            approved: false,
            digest: preview.digest,
          }),
        },
      );
      assert.equal(refused.status, 403);
      const written = await api(
        `/api/projects/${project.id}/runs/${run.id}/rebuild`,
        {
          method: "POST",
          body: { output, approved: true, digest: preview.digest },
        },
      );
      assert.equal(written.map_test, "green");
      assert.equal(written.behavior, "unverified");
      assert.equal(preview.comparisons[0].engine_match, "not-scored");
      assert.ok(
        preview.comparisons.some(
          (row) =>
            row.file === "search.mjs" && row.text_relation === "different",
        ),
      );
      const saved = readTimeline(run.output_dir);
      assert.ok(saved.some((event) => event.source === "engine-progress"));
      assert.ok(saved.some((event) => event.source === "rebuild"));
    } finally {
      studio.server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
