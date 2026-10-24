import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decideCapabilities } from "./capabilities.mjs";
import { planProduct, scaffoldRebuild } from "./scaffold.mjs";

const WHEN = "2026-10-23T00:00:00.000Z";
const citation = {
  url: "https://owned.docs/guide",
  fetched_at: WHEN,
  role: "docs",
};

function shell(overrides) {
  return {
    schema_version: "ree.outside-in.behavior-spec.v1",
    clean_room: true,
    clean_room_statement:
      "Public behavior only. Original source was not viewed and was not copied.",
    mode: "outside-in",
    status: "completed",
    generated_at: WHEN,
    target: { name: "Northwind Sample", urls: ["https://owned.docs/"] },
    collector: {
      name: "ree-outside-in",
      version: "1",
      user_agent: "REE-OutsideIn/1.0",
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
        url: "https://owned.docs/guide",
        role: "docs",
        status: 200,
        content_type: "text/html",
        fetched_at: WHEN,
        sha256: "ab".repeat(32),
        bytes: 20,
        robots: { allowed: true, rule: null },
        cache: { hit: false },
      },
    ],
    refusals: [],
    features: [],
    workflows: [],
    api: {
      style: "unknown",
      servers: [],
      auth: [],
      rate_limits: [],
      endpoints: [],
      unknowns: [],
    },
    pricing: { plans: [], unknowns: [] },
    integrations: [],
    limitations: [],
    changes: [],
    omitted: [],
    similarity: { threshold: 80, quote_max: 160, flagged: false, findings: [] },
    coverage: {
      examined_urls: ["https://owned.docs/guide"],
      unknowns: [],
    },
    ...overrides,
  };
}

function feature(id, name, detail) {
  return { id, name, detail, origin: "docs", citations: [citation] };
}

function endpoint(method, path, operationId, parameters, body) {
  const value = {
    method,
    path,
    operation_id: operationId,
    parameters,
    response_codes: [method === "POST" ? "201" : "200"],
    citations: [citation],
  };
  if (body) value.body = body;
  return value;
}

function richSpec() {
  return shell({
    features: [
      feature("feature:boards", "createBoard", "List search."),
      feature("feature:notes", "createNote", "A note on a board."),
      feature("feature:roles", "Roles", "A member label."),
    ],
    api: {
      style: "openapi",
      servers: [],
      auth: [
        {
          name: "session",
          style: "bearer",
          placement: "header",
          citations: [citation],
        },
      ],
      rate_limits: [],
      endpoints: [
        endpoint("POST", "/boards", "createBoard", ["name"], "json"),
        endpoint("GET", "/boards", "listBoards", ["q"]),
        endpoint("POST", "/notes", "createNote", ["board_id", "text"], "json"),
        endpoint("GET", "/notes", "listNotes", []),
      ],
      unknowns: [],
    },
    pricing: {
      plans: [
        {
          name: "Team",
          price: {
            amount: "12.00",
            currency: "usd",
            interval: "month",
            display: "$12",
          },
          limits: [],
          includes: [],
          citations: [citation],
        },
      ],
      unknowns: [],
    },
    integrations: [{ name: "Webhooks", citations: [citation] }],
    limitations: [
      {
        statement: {
          text: "Manual export stays out.",
          attributed_quote: true,
        },
        origin: "docs",
        citations: [citation],
      },
    ],
  });
}

function magicSpec() {
  return shell({
    features: [feature("feature:notes", "Notes", "A short label.")],
    api: {
      style: "unknown",
      servers: [],
      auth: [
        {
          name: "link",
          style: "magic link",
          placement: "header",
          citations: [citation],
        },
      ],
      rate_limits: [],
      endpoints: [],
      unknowns: [],
    },
  });
}

function emptySpec() {
  return shell({
    features: [feature("feature:query", "query", "Not an HTTP method.")],
    api: {
      style: "graphql",
      servers: [],
      auth: [],
      rate_limits: [],
      endpoints: [endpoint("QUERY", "/graphql", "query", [])],
      unknowns: ["GraphQL is not built."],
    },
  });
}

function counts(report) {
  const implemented = report.capabilities.filter(
    (item) => item.status === "implemented",
  ).length;
  return {
    implemented,
    left_out: report.capabilities.length - implemented,
    total: report.capabilities.length,
  };
}

function testEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST") || key === "NODE_CHANNEL_FD")
      delete env[key];
  }
  return env;
}

function runProductTests(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "test/product.test.mjs"], {
      cwd: dir,
      env: testEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("capabilities stay off until the spec supports them", async () => {
  const spec = emptySpec();
  const decision = decideCapabilities(spec, planProduct(spec));
  assert.equal(decision.storage, null);
  assert.equal(decision.auth, null);
  assert.equal(decision.roles, false);
  assert.equal(decision.search, false);
  assert.equal(decision.webhooks, false);
  assert.equal(decision.pricing, null);
  assert.deepEqual(decision.relations, []);
  const out = mkdtempSync(join(tmpdir(), "ree-cap-empty-"));
  try {
    scaffoldRebuild({
      spec,
      productName: "Harbor Kit",
      outDir: out,
      pack: false,
    });
    const report = JSON.parse(
      readFileSync(join(out, "capabilities.json"), "utf8"),
    );
    assert.deepEqual(counts(report), {
      implemented: 0,
      left_out: 10,
      total: 10,
    });
    assert.equal(
      report.capabilities.every((item) => item.status === "left-out"),
      true,
    );
    const ran = await runProductTests(out);
    assert.equal(ran.status, 0, ran.stderr || ran.stdout);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a supported spec builds each capability and the product tests pass", async () => {
  const spec = richSpec();
  const decision = decideCapabilities(spec, planProduct(spec));
  assert.equal(decision.storage, "sqlite");
  assert.equal(decision.auth.mode, "password");
  assert.equal(decision.roles, true);
  assert.equal(decision.search, true);
  assert.equal(decision.webhooks, true);
  assert.equal(decision.pricing.plans[0].name, "Team");
  assert.equal(decision.relations.length, 1);
  assert.equal(decision.relations[0].field, "board_id");
  const out = mkdtempSync(join(tmpdir(), "ree-cap-rich-"));
  try {
    scaffoldRebuild({
      spec,
      productName: "Harbor Kit",
      outDir: out,
      pack: false,
    });
    const report = JSON.parse(
      readFileSync(join(out, "capabilities.json"), "utf8"),
    );
    assert.equal(
      report.capabilities.filter((item) => item.status === "implemented")
        .length,
      9,
    );
    assert.equal(
      report.capabilities.find((item) => item.id === "pricing").status,
      "needs-setup",
    );
    const server = readFileSync(join(out, "src/server.mjs"), "utf8");
    assert.match(server, /node:sqlite/);
    assert.match(server, /sk_test_/);
    assert.match(server, /sk_live_/);
    assert.match(server, /api\.stripe\.com/);
    const docker = readFileSync(join(out, "Dockerfile"), "utf8");
    assert.match(docker, /0\.0\.0\.0/);
    assert.equal(docker.includes("sk_live_"), false);
    assert.equal(docker.includes("sk_test_"), false);
    const render = readFileSync(join(out, "render.yaml"), "utf8");
    assert.equal(render.includes("sk_live_"), false);
    assert.equal(render.includes("sk_test_"), false);
    assert.match(render, /STRIPE_SECRET_KEY/);
    assert.match(render, /sync: false/);
    const example = readFileSync(join(out, ".env.example"), "utf8");
    assert.match(example, /^STRIPE_SECRET_KEY=$/m);
    assert.match(example, /^STRIPE_WEBHOOK_SECRET=$/m);
    assert.match(example, /^REE_BILLING_LIVE_APPROVED=$/m);
    assert.equal(example.includes("sk_"), false);
    assert.equal(example.includes("rk_"), false);
    assert.equal(example.includes("whsec_"), false);
    const ignore = readFileSync(join(out, ".gitignore"), "utf8");
    assert.match(ignore, /^\.env$/m);
    const openapi = JSON.parse(readFileSync(join(out, "openapi.json"), "utf8"));
    assert.equal(openapi.openapi, "3.0.3");
    assert.equal(openapi.components.securitySchemes.bearer.scheme, "bearer");
    assert.ok(openapi.paths["/pricing"]);
    assert.ok(openapi.paths["/checkout"]);
    assert.ok(openapi.paths["/webhooks"]);
    assert.equal(
      readFileSync(join(out, "README.md"), "utf8").includes("Northwind Sample"),
      false,
    );
    const hosted = spawn(process.execPath, ["src/server.mjs"], {
      cwd: out,
      env: { ...testEnv(), HOST: "example.com", PORT: "0" },
    });
    let hostErr = "";
    hosted.stderr.on("data", (chunk) => {
      hostErr += chunk;
    });
    const hostStatus = await new Promise((resolve, reject) => {
      hosted.on("error", reject);
      hosted.on("close", resolve);
    });
    assert.equal(hostStatus, 2, hostErr);
    assert.match(hostErr, /HOST must be 127\.0\.0\.1 or 0\.0\.0\.0/);
    const ran = await runProductTests(out);
    assert.equal(ran.status, 0, ran.stderr || ran.stdout);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("magic link sessions stay local and do not send mail", async () => {
  const spec = magicSpec();
  const decision = decideCapabilities(spec, planProduct(spec));
  assert.equal(decision.auth.mode, "magic");
  assert.equal(decision.roles, false);
  assert.equal(decision.pricing.placeholder, true);
  assert.equal(decision.pricing.plans[0].name, "Placeholder");
  assert.equal(decision.pricing.creates_products, false);
  assert.equal(decision.pricing.mode, "test");
  const out = mkdtempSync(join(tmpdir(), "ree-cap-magic-"));
  try {
    scaffoldRebuild({
      spec,
      productName: "Harbor Kit",
      outDir: out,
      pack: false,
    });
    const report = JSON.parse(
      readFileSync(join(out, "capabilities.json"), "utf8"),
    );
    const status = Object.fromEntries(
      report.capabilities.map((item) => [item.id, item.status]),
    );
    assert.equal(status.auth, "implemented");
    assert.equal(status.roles, "left-out");
    assert.equal(status.pricing, "needs-setup");
    assert.equal(status.webhooks, "left-out");
    assert.equal(status.search, "left-out");
    assert.equal(status.relations, "left-out");
    assert.equal(status.storage, "implemented");
    const ran = await runProductTests(out);
    assert.equal(ran.status, 0, ran.stderr || ran.stdout);
    assert.match(ran.stdout, /No mailer is configured|pass/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("Scale pricing evidence is cited and is not a placeholder", () => {
  const spec = shell({
    features: [feature("feature:notes", "Notes", "A short label.")],
    api: {
      style: "unknown",
      servers: [],
      auth: [],
      rate_limits: [],
      endpoints: [endpoint("POST", "/notes", "createNote", ["text"], "json")],
      unknowns: [],
    },
  });
  const improvements = {
    schema_version: "ree.improvements.v1",
    items: [
      {
        id: "improve:team",
        record: "scale",
        kind: "pricing",
        recorded: { name: "Team", amount: "12.00", currency: "usd" },
        citation: {
          url: "https://owned.docs/pricing",
          fetched_at: WHEN,
        },
      },
    ],
  };
  const decision = decideCapabilities(spec, planProduct(spec), improvements);
  assert.equal(decision.pricing.placeholder, false);
  assert.equal(decision.pricing.plans[0].name, "Team");
  assert.equal(decision.pricing.plans[0].amount, "12.00");
  assert.equal(
    decision.pricing.plans[0].source_url,
    "https://owned.docs/pricing",
  );
  assert.equal(decision.pricing.creates_products, false);
  const out = mkdtempSync(join(tmpdir(), "ree-cap-scale-"));
  try {
    scaffoldRebuild({
      spec,
      productName: "Harbor Kit",
      outDir: out,
      pack: false,
      improvements,
    });
    const pricing = readFileSync(join(out, "PRICING.md"), "utf8");
    assert.match(pricing, /Team/);
    assert.match(pricing, /https:\/\/owned\.docs\/pricing/);
    assert.equal(pricing.includes("The plan below is a placeholder"), false);
    assert.equal(pricing.includes("Northwind Sample"), false);
    const report = JSON.parse(
      readFileSync(join(out, "capabilities.json"), "utf8"),
    );
    const billing = report.capabilities.find((item) => item.id === "pricing");
    assert.equal(billing.status, "needs-setup");
    assert.match(billing.reason, /STRIPE_SECRET_KEY/);
    assert.match(billing.reason, /sk_test_/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
