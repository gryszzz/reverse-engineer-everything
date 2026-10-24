import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emitHandoff } from "./emit.mjs";
import {
  CLEAN_ROOM_STATEMENT,
  SCHEMA_VERSION,
  USER_AGENT,
} from "../outside-in/constants.mjs";
import { readGeneratedArray } from "../rebuild/verify.mjs";
import { scaffoldRebuild } from "../rebuild/scaffold.mjs";

const cli = fileURLToPath(new URL("../../ree.mjs", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "ree-finish-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const citation = {
  url: "https://records.example/docs",
  fetched_at: "2026-10-22T00:00:00.000Z",
  role: "docs",
};

function spec() {
  return {
    schema_version: SCHEMA_VERSION,
    clean_room: true,
    clean_room_statement: CLEAN_ROOM_STATEMENT,
    mode: "outside-in",
    status: "completed",
    generated_at: "2026-10-22T00:00:00.000Z",
    target: { name: "Example Target", urls: ["https://records.example/"] },
    collector: {
      name: "ree-outside-in",
      version: "1",
      user_agent: USER_AGENT,
      platform: "test",
      headless_browser: false,
      authentication: "none",
      source_acquisition: "public-http-get",
    },
    llm: {
      used: false,
      provider: null,
      ree_remote_calls: "not-performed",
      transport: "none",
      summary: null,
      error: null,
    },
    sources: [
      {
        url: "https://records.example/docs",
        role: "docs",
        status: 200,
        content_type: "text/html",
        fetched_at: "2026-10-22T00:00:00.000Z",
        sha256: "ab".repeat(32),
        bytes: 12,
        robots: { allowed: true, rule: null },
        cache: { hit: false },
      },
    ],
    refusals: [],
    features: [
      {
        id: "feature:items",
        name: "Items",
        detail: "People can save an item.",
        origin: "docs",
        quote: {
          text: "DISTINCTIVE_ITEM_QUOTE_should_not_land_in_src",
          attributed_quote: true,
        },
        citations: [citation],
      },
    ],
    workflows: [],
    api: {
      style: "unknown",
      servers: [],
      auth: [],
      rate_limits: [],
      endpoints: [
        {
          method: "POST",
          path: "/items",
          operation_id: "createItem",
          summary: {
            text: "DISTINCTIVE_ITEM_ENDPOINT_QUOTE_should_not_land",
            attributed_quote: true,
          },
          parameters: ["name"],
          body: "json",
          response_codes: ["201"],
          citations: [citation],
        },
        {
          method: "POST",
          path: "/items/{id}/upload",
          operation_id: "uploadItem",
          summary: {
            text: "DISTINCTIVE_UPLOAD_QUOTE_should_not_land",
            attributed_quote: true,
          },
          parameters: ["id"],
          response_codes: ["201"],
          citations: [citation],
        },
      ],
      unknowns: [],
    },
    pricing: { plans: [], unknowns: ["No pricing URL was supplied."] },
    integrations: [],
    limitations: [],
    changes: [],
    omitted: [],
    similarity: { threshold: 80, quote_max: 160, flagged: false, findings: [] },
    coverage: {
      examined_urls: ["https://records.example/docs"],
      unknowns: ["No pricing URL was supplied."],
    },
  };
}

function runFinish(dir) {
  const child = spawnSync(process.execPath, [cli, "finish", dir, "--json"], {
    encoding: "utf8",
  });
  return child;
}

test("finish tickets record not-built operations and coverage waits for a real test", () => {
  const root = mkdtempSync(join(home, "run-"));
  const product = join(root, "product");
  scaffoldRebuild({
    spec: spec(),
    productName: "Harbor Kit",
    outDir: product,
    pack: false,
  });
  const emitted = emitHandoff({
    projectDir: product,
    verify: {
      schema_version: "ree.rebuild.verify.v1",
      exit_code: 0,
      implemented: 1,
      unimplemented: 0,
      failed: 0,
      not_run: 0,
      total: 1,
      ratio: 1,
      features: [],
    },
    blastDir: join(root, "handoff"),
  });
  const readme = readFileSync(join(emitted.directory, "README.md"), "utf8");
  assert.match(readme, /Open finish tickets: 1/);
  assert.equal(readme.includes("Example Target"), false);
  const index = JSON.parse(
    readFileSync(join(emitted.directory, "finish.json"), "utf8"),
  );
  assert.equal(index.schema_version, "ree.finish.v1");
  assert.equal(index.role, "index");
  assert.equal(index.open, 1);
  assert.equal(index.closed, 0);
  const ticket = JSON.parse(
    readFileSync(join(emitted.directory, index.tickets[0].file), "utf8"),
  );
  assert.equal(ticket.schema_version, "ree.finish.v1");
  assert.equal(ticket.status, "open");
  assert.equal(ticket.operation.method, "POST");
  assert.equal(ticket.operation.path, "/items/{id}/upload");
  assert.equal(ticket.operation.operation_id, "uploadItem");
  assert.match(ticket.reason, /path template is not expanded/);
  assert.equal(ticket.spec_excerpt.path, "/items/{id}/upload");
  assert.equal(ticket.spec_excerpt.operation_id, "uploadItem");
  assert.deepEqual(ticket.spec_excerpt.parameters, ["id"]);
  assert.match(
    ticket.acceptance_tests.join("\n"),
    /endpoint POST \/items\/\{id\}\/upload/,
  );
  assert.match(ticket.acceptance_tests.join("\n"), /status 201/);
  assert.match(ticket.acceptance_tests.join("\n"), /fetch/);
  assert.ok(ticket.files.includes("src/server.mjs"));
  assert.ok(ticket.files.includes("src/routes.mjs"));
  assert.ok(ticket.files.includes("test/product.test.mjs"));
  assert.equal(JSON.stringify(ticket).includes("Example Target"), false);
  assert.equal(
    JSON.stringify(ticket).includes("DISTINCTIVE_ITEM_QUOTE"),
    false,
  );

  const missing = spawnSync(process.execPath, [cli, "finish"], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Use finish DIR/);

  const open = runFinish(product);
  assert.equal(open.status, 0, open.stderr || open.stdout);
  const opened = JSON.parse(open.stdout);
  assert.equal(opened.open.length, 1);
  assert.equal(opened.closed.length, 0);
  assert.equal(opened.coverage.not_built, 1);
  const plannedBuilt = opened.planned.built;
  assert.equal(opened.coverage.built, plannedBuilt);

  const routesPath = join(product, "src/routes.mjs");
  const routes = readGeneratedArray(readFileSync(routesPath, "utf8"), "routes");
  routes.push({
    method: "POST",
    path: "/items/{id}/upload",
    declared: false,
    action: "create",
    parameters: ["id"],
    success_status: 201,
  });
  writeFileSync(
    routesPath,
    "export const routes = " + JSON.stringify(routes, null, 2) + ";\n",
  );
  const testPath = join(product, "test/product.test.mjs");
  writeFileSync(
    testPath,
    readFileSync(testPath, "utf8") +
      `
test("endpoint POST /items/{id}/upload", async () => {
  assert.equal(1, 1);
});
`,
  );
  const fake = runFinish(root);
  assert.equal(fake.status, 0, fake.stderr || fake.stdout);
  const faked = JSON.parse(fake.stdout);
  assert.equal(faked.closed.length, 0);
  assert.equal(faked.coverage.not_built, 1);

  writeFileSync(
    testPath,
    readFileSync(testPath, "utf8").replace(
      `test("endpoint POST /items/{id}/upload", async () => {
  assert.equal(1, 1);
});`,
      `test("endpoint POST /items/{id}/upload", async () => {
  const server = (await import("node:http")).createServer((request, response) => {
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "1" }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const port = server.address().port;
    const response = await fetch("http://127.0.0.1:" + port + "/items/1/upload", {
      method: "POST",
    });
    assert.equal(response.status, 201);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});`,
    ),
  );
  const closed = runFinish(join(emitted.directory));
  assert.equal(closed.status, 0, closed.stderr || closed.stdout);
  const done = JSON.parse(closed.stdout);
  assert.equal(done.open.length, 0);
  assert.equal(done.closed.length, 1);
  assert.equal(done.closed[0].status, "closed");
  assert.equal(done.coverage.not_built, 0);
  assert.equal(done.coverage.built, plannedBuilt + 1);
  const coverage = JSON.parse(
    readFileSync(join(product, "coverage.json"), "utf8"),
  );
  assert.equal(coverage.endpoints.not_built, 0);
  assert.equal(coverage.endpoints.built, plannedBuilt + 1);
  assert.equal(coverage.endpoints.source, "ree.finish.v1");
  const saved = JSON.parse(
    readFileSync(join(emitted.directory, index.tickets[0].file), "utf8"),
  );
  assert.equal(saved.status, "closed");
  assert.equal(saved.closed_by, "endpoint test passed");
});
