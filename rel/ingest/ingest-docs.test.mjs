import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runProductPipeline } from "../pipeline/run.mjs";
import { ingestPublicDocs } from "./docs.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const docs = join(repo, "experiments/ree-bench/docs");
const cli = join(repo, "ree.mjs");
const home = mkdtempSync(join(tmpdir(), "ree-ingest-docs-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

function textResponse(body, status, type) {
  const bytes = Buffer.from(body);
  return {
    status,
    headers: {
      forEach(fn) {
        fn(type, "content-type");
      },
    },
    arrayBuffer: async () => bytes,
  };
}

test("a docs directory becomes a cited spec without the network", async () => {
  const calls = [];
  const out = join(home, "directory");
  const result = await ingestPublicDocs({
    input: docs,
    outDir: out,
    name: "Field Ledger Docs",
    fetchImpl: async () => {
      calls.push("network");
      throw new Error("network");
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.spec.status, "completed");
  assert.equal(result.spec.schema_version, "ree.outside-in.behavior-spec.v1");
  assert.equal(result.ingest.schema_version, "ree.ingest-docs.v1");
  assert.equal(result.ingest.network, false);
  assert.equal(result.ingest.source, "directory");
  assert.deepEqual(result.ingest.resources.map((item) => item.path).sort(), [
    "/notes",
    "/notes/{noteId}",
  ]);
  assert.ok(result.ingest.resources.every((item) => item.citations.length > 0));
  const names = result.spec.features.map((feature) => feature.name);
  for (const name of [
    "Short notes kept on this machine.",
    "Record a field note",
    "List field notes",
    "Export a note",
  ])
    assert.ok(names.includes(name), name);
  assert.equal(names.includes("Too deep to read"), false);
  assert.equal(names.includes("Decoy endpoint"), false);
  const tiers = result.ingest.pricing_tiers.map((tier) => [
    tier.name,
    tier.price,
  ]);
  assert.deepEqual(tiers, [
    ["Field", "Free"],
    ["Survey", "$12 per month"],
  ]);
  assert.ok(
    result.ingest.pricing_tiers.every((tier) => tier.citations.length > 0),
  );
  assert.ok(
    result.spec.api.rate_limits.some(
      (limit) => limit.limit === "30" && limit.window === "minute",
    ),
  );
  const specText = readFileSync(join(out, "behavior-spec.json"), "utf8");
  assert.equal(specText.includes("do-not-copy-this-sample"), false);
  assert.equal(specText.includes("source-file-not-a-document"), false);
  const skipped = result.ingest.skipped.map((item) => item.path);
  assert.ok(skipped.includes("skip-me.js"));
  assert.ok(skipped.includes("notes.txt"));
  assert.ok(skipped.includes("a/b/c/d/e"));
  assert.equal(
    readFileSync(join(out, "ingest.json"), "utf8").includes(
      "Field Ledger Docs",
    ),
    true,
  );
});

test("a public URL obeys robots, waits, and sends no credentials", async () => {
  const calls = [];
  const sleeps = [];
  let clock = Date.parse("2026-10-23T09:00:00.000Z");
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(init.credentials, "omit");
    assert.equal(init.headers.authorization, undefined);
    if (String(url).endsWith("/robots.txt"))
      return textResponse("User-agent: *\nAllow: /\n", 200, "text/plain");
    return textResponse(
      "<h2>Pin a map</h2><p>People pin one place.</p>",
      200,
      "text/html",
    );
  };
  const paced = await ingestPublicDocs({
    input: "https://notes.example/api.html",
    outDir: join(home, "paced"),
    fetchImpl,
    minIntervalMs: 1000,
    now: () => new Date(clock),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  assert.deepEqual(sleeps, [1000]);
  assert.equal(calls.length, 2);
  assert.equal(
    paced.spec.features.some((feature) => feature.name === "Pin a map"),
    true,
  );
  assert.equal(paced.ingest.network, true);
  assert.equal(paced.spec.target.name, "notes.example");

  const blocked = [];
  const refused = await ingestPublicDocs({
    input: "https://notes.example/api.html",
    outDir: join(home, "robots"),
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: async (url) => {
      blocked.push(String(url));
      return textResponse("User-agent: *\nDisallow: /\n", 200, "text/plain");
    },
  });
  assert.equal(refused.exitCode, 3);
  assert.equal(refused.spec.status, "refused");
  assert.equal(refused.spec.refusals[0].reason, "robots-disallow");
  assert.equal(blocked.length, 1);
  assert.ok(blocked[0].endsWith("/robots.txt"));

  const limited = [];
  const cooling = await ingestPublicDocs({
    input: "https://notes.example/api.html",
    outDir: join(home, "limited"),
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: async (url) => {
      limited.push(String(url));
      if (String(url).endsWith("/robots.txt"))
        return textResponse("User-agent: *\nAllow: /\n", 200, "text/plain");
      return textResponse("slow down", 429, "text/plain");
    },
  });
  assert.equal(limited.length, 2);
  assert.equal(cooling.spec.refusals[0].reason, "rate-limit");
  assert.equal(
    cooling.spec.refusals.some((item) => item.reason === "auth-required"),
    false,
  );
});

test("a URL with credentials or a private host is refused before fetch", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("fetched");
  };
  await assert.rejects(
    () =>
      ingestPublicDocs({
        input: "https://user:secret@notes.example/api.html",
        outDir: join(home, "creds"),
        fetchImpl,
      }),
    /usernames or passwords are refused/,
  );
  await assert.rejects(
    () =>
      ingestPublicDocs({
        input: "https://notes.example/api.html?token=secret",
        outDir: join(home, "token"),
        fetchImpl,
      }),
    /credential query parameters are refused/,
  );
  await assert.rejects(
    () =>
      ingestPublicDocs({
        input: "http://127.0.0.1/api.html",
        outDir: join(home, "loop"),
        fetchImpl,
      }),
    /private hosts are refused/,
  );
  assert.equal(called, false);
});

test("Swagger JSON and one HTML page are enough", async () => {
  const swaggerDir = join(home, "swagger-src");
  mkdirSync(join(swaggerDir, "node_modules"), { recursive: true });
  writeFileSync(
    join(swaggerDir, "node_modules", "decoy.yaml"),
    "openapi: 3.0.3\ninfo:\n  title: Decoy\n  version: '1'\npaths:\n  /decoy:\n    get:\n      operationId: decoyCall\n      summary: Decoy endpoint\n      responses:\n        '200':\n          description: no\n",
  );
  writeFileSync(
    join(swaggerDir, "swagger.json"),
    JSON.stringify({
      swagger: "2.0",
      info: { title: "Pins", version: "1" },
      paths: {
        "/pins": {
          get: {
            operationId: "listPins",
            summary: "List pins",
            responses: { 200: { description: "ok" } },
          },
        },
      },
    }),
  );
  const swagger = await ingestPublicDocs({
    input: swaggerDir,
    outDir: join(home, "swagger-out"),
    name: "Pin Docs",
  });
  assert.equal(swagger.spec.api.endpoints[0].operation_id, "listPins");
  assert.equal(swagger.ingest.resources[0].path, "/pins");
  assert.equal(
    swagger.spec.api.endpoints.some((endpoint) => endpoint.path === "/decoy"),
    false,
  );
  assert.ok(
    swagger.ingest.skipped.some((item) => item.path === "node_modules"),
  );

  const htmlDir = join(home, "html-src");
  mkdirSync(htmlDir);
  writeFileSync(
    join(htmlDir, "reference.html"),
    "<h2>Pin a map</h2><p>People pin one place.</p>\n",
  );
  const html = await ingestPublicDocs({
    input: htmlDir,
    outDir: join(home, "html-out"),
  });
  assert.equal(html.spec.features[0].name, "Pin a map");
  assert.equal(html.spec.api.endpoints.length, 0);
});

test("the document cap and directory depth are reported", async () => {
  const dir = join(home, "capped");
  mkdirSync(dir);
  for (let index = 0; index < 30; index += 1) {
    writeFileSync(
      join(dir, `page-${String(index).padStart(2, "0")}.html`),
      `<h2>Page ${index}</h2><p>Page body ${index}.</p>\n`,
    );
  }
  const capped = await ingestPublicDocs({
    input: dir,
    outDir: join(home, "capped-out"),
    name: "Capped Docs",
  });
  assert.equal(capped.ingest.documents.length, 24);
  assert.ok(
    capped.ingest.skipped.some((item) =>
      item.reason.includes("past the 24 document limit"),
    ),
  );
});

test("the pipeline accepts the ingested spec and rejects a partial one", async () => {
  const specDir = join(home, "pipeline-spec");
  const ingested = await ingestPublicDocs({
    input: docs,
    outDir: specDir,
    name: "Field Ledger Docs",
  });
  assert.equal(ingested.spec.status, "completed");
  const out = join(home, "pipeline-run");
  const outcome = await runProductPipeline({
    target: specDir,
    outDir: out,
    productName: "Ledger Kit",
    sharedDir: join(home, "missing-shared"),
  });
  assert.equal(outcome.code, 0, outcome.message);
  const scope = JSON.parse(
    readFileSync(join(out, "checkpoints", "scope.json"), "utf8"),
  );
  assert.equal(scope.provenance.mode, "ingested-spec");
  assert.equal(scope.provenance.network, false);
  assert.equal(
    readFileSync(join(out, "product", "README.md"), "utf8").includes(
      "Field Ledger Docs",
    ),
    false,
  );
  assert.equal(existsSync(join(home, "missing-shared")), false);

  const partialDir = join(home, "partial-spec");
  mkdirSync(partialDir);
  const partial = structuredClone(ingested.spec);
  partial.status = "partial";
  writeFileSync(
    join(partialDir, "behavior-spec.json"),
    JSON.stringify(partial) + "\n",
  );
  const stopped = await runProductPipeline({
    target: partialDir,
    outDir: join(home, "partial-run"),
    productName: "Ledger Kit",
    sharedDir: join(home, "missing-shared"),
  });
  assert.equal(stopped.code, 1);
  assert.match(stopped.message, /status is partial/);

  const badDir = join(home, "bad-spec");
  mkdirSync(badDir);
  writeFileSync(join(badDir, "behavior-spec.json"), "{");
  const unreadable = await runProductPipeline({
    target: badDir,
    outDir: join(home, "bad-run"),
    productName: "Ledger Kit",
    sharedDir: join(home, "missing-shared"),
  });
  assert.match(unreadable.message, /behavior-spec.json could not be read/);
});

test("the CLI requires an output directory", () => {
  const missing = spawnSync(process.execPath, [cli, "ingest-docs", docs], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /--out DIR/);
  const help = spawnSync(process.execPath, [cli, "ingest-docs", "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /robots\.txt/);
});
