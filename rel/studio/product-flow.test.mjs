import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { navigation, primaryFlow } from "./public/flow.js";
import { startStudio } from "./server.mjs";
import {
  CLEAN_ROOM_STATEMENT,
  SCHEMA_VERSION,
  USER_AGENT,
} from "../outside-in/constants.mjs";

const root = mkdtempSync(join(tmpdir(), "ree-flow-"));
const studio = await startStudio({ dataDir: join(root, "data") });

after(() => {
  studio.server.close();
  rmSync(root, { recursive: true, force: true });
});

function api(path, options = {}) {
  const headers = { "x-ree-studio-token": studio.token };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: studio.server.address().port,
        path,
        method: options.method ?? "GET",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const body = text ? JSON.parse(text) : null;
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on("error", reject);
    req.end(
      options.body === undefined ? undefined : JSON.stringify(options.body),
    );
  });
}

function spec() {
  const citation = {
    url: "https://widgets.example/docs",
    fetched_at: "2026-10-22T00:00:00.000Z",
    role: "docs",
  };
  return {
    schema_version: SCHEMA_VERSION,
    clean_room: true,
    clean_room_statement: CLEAN_ROOM_STATEMENT,
    mode: "outside-in",
    status: "completed",
    generated_at: "2026-10-22T00:00:00.000Z",
    target: { name: "Widget Cloud", urls: ["https://widgets.example/"] },
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
        url: citation.url,
        role: "docs",
        status: 200,
        content_type: "text/html",
        fetched_at: citation.fetched_at,
        sha256: "ab".repeat(32),
        bytes: 4,
        robots: { allowed: true, rule: null },
        cache: { hit: false },
      },
    ],
    refusals: [],
    features: [
      {
        id: "feature:shared-boards",
        name: "Shared boards",
        detail: "People can open the same board.",
        origin: "docs",
        citations: [citation],
      },
    ],
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
    coverage: { examined_urls: [citation.url], unknowns: [] },
  };
}

test("simple navigation keeps labs behind advanced", () => {
  assert.deepEqual(
    navigation("simple").map(([, label]) => label),
    ["Front door", "Analyze", "Findings", "Build"],
  );
  assert.equal(
    navigation("advanced").some(([id]) => id === "graph"),
    true,
  );
  assert.equal(
    navigation("advanced").some(([id]) => id === "board"),
    true,
  );
  assert.equal(
    primaryFlow.some(([id]) => id === "graph" || id === "lessons"),
    false,
  );
});

test("onboarding, board ingest, and a dry-run build are live studio routes", async () => {
  const first = await api("/api/session");
  assert.equal(first.body.onboarding_seen, false);
  const seen = await api("/api/onboarding", { method: "POST", body: {} });
  assert.equal(seen.body.seen, true);
  const rejected = await api("/api/board", {
    method: "POST",
    body: { target_name: "Nope" },
  });
  assert.equal(rejected.status, 400);
  const scout = {
    target_name: "Widget Cloud",
    url: "https://widgets.example/",
    category: "search",
    pricing: {
      plans: ["Starter"],
      model: "seat",
      source_url: "https://widgets.example/pricing",
    },
    weaknesses: [
      {
        type: "support",
        summary: "Slow replies.",
        evidence_urls: ["https://widgets.example/reviews"],
      },
    ],
    market_signal: {
      review_count: 1,
      rating: 3,
      complaint_volume: 1,
      search_demand: 1,
      notes: "",
    },
    scores: {
      pain: 2,
      willingness_to_pay: 2,
      build_ease: 2,
      competitor_weakness: 2,
      reach: 2,
      total: 10,
    },
    confidence: 40,
    found_at: "2026-10-22T00:00:00.000Z",
    tracker_ref: "tracker",
  };
  const ingested = await api("/api/board", { method: "POST", body: scout });
  assert.equal(ingested.status, 201);
  assert.equal(ingested.body.scout[0].listing.scores.total, 10);
  const built = await api("/api/builds", {
    method: "POST",
    body: { product_name: "Board Kit", spec: spec() },
  });
  assert.equal(built.status, 201, JSON.stringify(built.body));
  assert.equal(built.body.dry_run, true);
  assert.equal(built.body.verify.exit_code, 0);
  assert.equal(built.body.verify.features[0].match, "unimplemented");
  assert.equal(built.body.verify.implemented, 0);
  assert.equal(built.body.box_path_used, false);
});
