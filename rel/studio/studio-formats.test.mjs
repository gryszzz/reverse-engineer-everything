import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startStudio } from "./server.mjs";

const fixtures = fileURLToPath(
  new URL("../../experiments/ree-fixtures/", import.meta.url),
);
const root = mkdtempSync(join(tmpdir(), "ree-formats-"));
const studio = await startStudio({ dataDir: join(root, "data") });
const origin = studio.url.slice(0, -1);

function api(path, options = {}) {
  const headers = { "x-ree-studio-token": studio.token };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(origin + path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }).then(async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  });
}

async function settle(projectId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const project = await api(`/api/projects/${projectId}`);
    if (project.runs.every((run) => run.status !== "running")) return project;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("analysis did not finish");
}

async function runRoute(projectId, artifactId, routeId) {
  await api(`/api/projects/${projectId}/runs`, {
    method: "POST",
    body: { artifact_id: artifactId, authorized: true, route_id: routeId },
  });
  const finished = await settle(projectId);
  return finished.runs.at(-1);
}

test.after(() => {
  studio.server.close();
  rmSync(root, { recursive: true, force: true });
});

test("a dropped wasm file is classified and a missing WABT config does not invent Evidence", async () => {
  const project = await api("/api/projects", {
    method: "POST",
    body: { name: "Wasm" },
  });
  const bytes = readFileSync(join(fixtures, "empty.wasm"));
  const response = await fetch(
    `${origin}/api/projects/${project.id}/artifacts/bytes`,
    {
      method: "POST",
      headers: {
        "x-ree-studio-token": studio.token,
        "content-type": "application/octet-stream",
        "x-ree-artifact-name": "empty.wasm",
        "x-ree-classify": "true",
      },
      body: bytes,
    },
  );
  const dropped = await response.json();
  assert.equal(response.status, 201, dropped.error);
  assert.equal(dropped.project.artifacts[0].intake.kind, "wasm");
  const route = dropped.project.artifacts[0].intake.routes.find(
    (item) => item.id === "wasm",
  );
  if (!process.env.REA_WABT_BIN_DIRECTORY) {
    assert.equal(route.status, "not-configured");
    await assert.rejects(
      api(`/api/projects/${project.id}/runs`, {
        method: "POST",
        body: {
          artifact_id: dropped.project.artifacts[0].id,
          authorized: true,
          route_id: "wasm",
        },
      }),
      /not-configured/,
    );
    assert.equal((await api(`/api/projects/${project.id}`)).runs.length, 0);
  }
  const escaped = await fetch(
    `${origin}/api/projects/${project.id}/artifacts/bytes`,
    {
      method: "POST",
      headers: {
        "x-ree-studio-token": studio.token,
        "content-type": "application/octet-stream",
        "x-ree-artifact-name": "x",
        "x-ree-artifact-relative": "../secret",
      },
      body: Buffer.from("nope"),
    },
  );
  assert.equal(escaped.status, 400);
});

test("PE resources, EVM bytecode, and objdump headers run through the studio", async () => {
  const project = await api("/api/projects", {
    method: "POST",
    body: { name: "Formats", mode: "advanced" },
  });
  const add = async (name) => {
    const updated = await api(`/api/projects/${project.id}/artifacts`, {
      method: "POST",
      body: { path: join(fixtures, name) },
    });
    return updated.artifacts.at(-1);
  };
  const pe = await add("resource32.exe");
  assert.equal(
    pe.intake.routes.find((route) => route.id === "pe-resources").status,
    "ready",
  );
  const peRun = await runRoute(project.id, pe.id, "pe-resources");
  assert.equal(peRun.status, "completed", peRun.error);
  assert.match(peRun.evidence_id, /^ev_[a-f0-9]{64}$/u);
  assert.equal(peRun.provider.id, "rea-pe-resources");
  assert.ok(
    peRun.narrative.statements.every(
      (item) => item.evidence_id === peRun.evidence_id,
    ),
  );
  assert.ok(peRun.narrative.unknowns.some((item) => /Entry points/.test(item)));
  const graph = await api(
    `/api/projects/${project.id}/runs/${peRun.id}/graph?limit=40`,
  );
  assert.equal(graph.provider.id, "rea-pe-resources");
  assert.ok(
    graph.edges.some((edge) => edge.relation === "candidate_resource_indices"),
  );
  const source = await api(
    `/api/projects/${project.id}/runs/${peRun.id}/source?edge_id=${graph.edges[0].edge_id}`,
  );
  assert.equal(source.available, false);

  const evm = await add("carrier.hex");
  const evmRun = await runRoute(project.id, evm.id, "evm");
  assert.equal(evmRun.status, "completed", evmRun.error);
  assert.equal(evmRun.provider.id, "evmole-interface");
  assert.match(
    evmRun.narrative.statements.map((item) => item.text).join("\n"),
    /No function selectors were reported/,
  );
  assert.ok(
    evmRun.narrative.unknowns.some((item) => /not executed/.test(item)),
  );

  const elf = await add("tiny-linux-x64.elf");
  const headers = elf.intake.routes.find(
    (route) => route.id === "objdump-headers",
  );
  if (headers?.status === "ready") {
    const dump = await runRoute(project.id, elf.id, "objdump-headers");
    assert.equal(dump.status, "completed", dump.error);
    assert.equal(dump.provider.id, "gnu.objdump");
    assert.match(
      dump.narrative.statements.map((item) => item.text).join("\n"),
      /file_headers/,
    );
    const empty = await api(
      `/api/projects/${project.id}/runs/${dump.id}/graph?limit=20`,
    );
    assert.equal(empty.edges.length, 0);
    assert.match(empty.execution_note, /gnu.objdump/);
  }
  const layout = elf.intake.routes.find((route) => route.id === "elf-layout");
  if (!process.env.REA_PWNTOOLS_PYTHON && process.platform === "linux")
    assert.equal(layout.status, "not-configured");
  const ghidra = elf.intake.routes.find((route) => route.id === "ghidra");
  if (!process.env.GHIDRA_INSTALL_DIR)
    assert.equal(ghidra.status, "not-configured");
  const readiness = await api("/api/readiness");
  if (process.platform !== "darwin")
    assert.equal(
      readiness.routes.find((route) => route.id === "macho").status,
      "unsupported",
    );
  assert.equal(
    readiness.routes.find((route) => route.id === "radare2").status,
    "unsupported",
  );
  assert.equal(
    readiness.routes.find((route) => route.id === "rizin").status,
    "unsupported",
  );
});

test("the setup offer shows the brew command and does not run it without approval", async () => {
  const readiness = await api("/api/readiness");
  const offer = readiness.setup.offers.find((item) => item.id === "apktool");
  assert.deepEqual(offer.argv, ["brew", "install", "apktool"]);
  assert.match(
    readiness.setup.guidance.map((item) => item.text).join("\n"),
    /REA_JADX_MCP_JAR/,
  );
  await assert.rejects(
    api(`/api/setup`, {
      method: "POST",
      body: {
        offer_id: "apktool",
        approved: false,
        command_digest: offer.command_digest,
      },
    }),
    /approved: true/,
  );
  await assert.rejects(
    api("/api/setup", {
      method: "POST",
      body: {
        offer_id: "apktool",
        approved: true,
        command_digest: "0".repeat(64),
      },
    }),
    /exact argv/,
  );
  if (!offer.available) {
    await assert.rejects(
      api("/api/setup", {
        method: "POST",
        body: {
          offer_id: "apktool",
          approved: true,
          command_digest: offer.command_digest,
        },
      }),
      /not run on this host|Homebrew is not/,
    );
  }
});
