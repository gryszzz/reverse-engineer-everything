import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  assert.equal(built.body.verify.features[0].match, "pass");
  assert.equal(built.body.verify.features[0].route.path, "/shared-boards");
  assert.equal(built.body.verify.implemented, 1);
  assert.equal(built.body.box_path_used, false);
  assert.equal(built.body.gaps.title, "What we can't read or build yet");
  assert.equal(built.body.improvements.title, "What we do better");
  assert.equal(built.body.improvements.items.length, 0);
  assert.match(built.body.gaps.note, /not a percentage/);
  assert.equal(
    built.body.gaps.items.some((item) => item.text.includes("Widget Cloud")),
    false,
  );
  const wrongFixture = await api("/api/pipeline", {
    method: "POST",
    body: { fixture: "other", product_name: "Board Desk" },
  });
  assert.equal(wrongFixture.status, 400);
  const started = await api("/api/pipeline", {
    method: "POST",
    body: { fixture: "web", product_name: "Board Desk" },
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.status, "running");
  assert.match(started.body.run_id, /^run_[a-f0-9]{16}$/u);
  let snapshot = null;
  let sawRunning = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const polled = await api("/api/pipeline/" + started.body.run_id);
    assert.equal(polled.status, 200, JSON.stringify(polled.body));
    snapshot = polled.body;
    if (snapshot.finished !== true) sawRunning = true;
    if (snapshot.finished === true) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  assert.equal(snapshot.finished, true, JSON.stringify(snapshot));
  assert.equal(snapshot.code, 0, snapshot.message);
  assert.equal(sawRunning, true);
  assert.equal(snapshot.dry_run, true);
  assert.equal(snapshot.notified_blast, false);
  assert.equal(snapshot.guard_sign_off, "not-submitted");
  assert.equal(snapshot.approved_for_vault_copy, false);
  assert.equal(snapshot.gaps.title, "What we can't read or build yet");
  assert.equal(snapshot.improvements.title, "What we do better");
  assert.match(snapshot.improvements.note, /list is empty/);
  for (const stage of snapshot.stages)
    assert.equal(stage.status, "passed", stage.id);
  const create = snapshot.verify.features.find(
    (feature) => feature.name === "Create a board",
  );
  assert.equal(create.match, "pass");
  const shared = snapshot.verify.features.find(
    (feature) => feature.name === "Shared boards",
  );
  assert.equal(shared.match, "pass");
  assert.equal(shared.route.path, "/shared-boards");
  const board = await api("/api/board");
  assert.equal(board.status, 200, JSON.stringify(board.body));
  const sharedPick = board.body.picks.find(
    (pick) => pick.name === "Shared boards",
  );
  assert.equal(sharedPick.match, "pass");
  assert.equal(sharedPick.route.path, "/shared-boards");
  assert.ok(board.body.picks.some((pick) => pick.name === "Create a board"));
});

test("a live build shows files and tests, then packages on request", async () => {
  const value = spec();
  value.features.push({
    id: "feature:create-a-board",
    name: "Create a board",
    detail: "People create a board from the client.",
    origin: "docs",
    citations: value.features[0].citations,
  });
  const empty = await api("/api/live-builds", {
    method: "POST",
    body: {
      product_name: "Board Kit",
      spec: value,
      feature_ids: [],
    },
  });
  assert.equal(empty.status, 400);
  const started = await api("/api/live-builds", {
    method: "POST",
    body: {
      product_name: "Board Kit",
      spec: value,
      feature_ids: ["feature:shared-boards"],
    },
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.match(started.body.live_id, /^live_[a-f0-9]{16}$/u);
  let snapshot = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const polled = await api("/api/live-builds/" + started.body.live_id);
    assert.equal(polled.status, 200);
    snapshot = polled.body;
    if (snapshot.finished === true) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  assert.equal(snapshot.finished, true, JSON.stringify(snapshot));
  assert.equal(snapshot.status, "verified", snapshot.error);
  assert.equal(snapshot.gaps.title, "What we can't read or build yet");
  assert.equal(snapshot.improvements.title, "What we do better");
  assert.match(snapshot.improvements.note, /list is empty/);
  assert.equal(snapshot.verify.implemented, 1);
  assert.equal(snapshot.verify.features[0].match, "pass");
  assert.equal(snapshot.verify.features[0].route.path, "/shared-boards");
  assert.equal(snapshot.package_path, null);
  assert.equal(existsSync(snapshot.out_dir + "/product.tgz"), false);
  assert.ok(snapshot.events.some((event) => event.phase === "spec-item"));
  assert.ok(
    snapshot.events.some(
      (event) => event.phase === "file" && event.file === "src/server.mjs",
    ),
  );
  assert.ok(snapshot.events.some((event) => event.phase === "test"));
  const written = JSON.parse(
    readFileSync(snapshot.out_dir + "/behavior-spec.json", "utf8"),
  );
  assert.deepEqual(
    written.features.map((feature) => feature.id),
    ["feature:shared-boards"],
  );
  assert.equal(
    written.features.some((feature) => feature.id === "feature:create-a-board"),
    false,
  );
  const packaged = await api(
    "/api/live-builds/" + started.body.live_id + "/package",
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(packaged.status, 201, JSON.stringify(packaged.body));
  assert.equal(existsSync(packaged.body.package_path), true);
  const readme = readFileSync(snapshot.out_dir + "/README.md", "utf8");
  assert.equal(readme.includes("Widget Cloud"), false);
  assert.equal(packaged.body.dry_run, true);
});

test("shared agent verdicts sit beside the matching board entry", async () => {
  const shared = join(root, "shared-picks");
  mkdirSync(join(shared, "picks"), { recursive: true });
  const previous = process.env.REE_SHARED_BOARD;
  process.env.REE_SHARED_BOARD = shared;
  const local = await startStudio({ dataDir: join(root, "agent-studio") });
  const localApi = (path, options = {}) => {
    const headers = { "x-ree-studio-token": local.token };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: local.server.address().port,
          path,
          method: options.method ?? "GET",
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode,
              body: text ? JSON.parse(text) : null,
            });
          });
        },
      );
      req.on("error", reject);
      req.end(
        options.body === undefined ? undefined : JSON.stringify(options.body),
      );
    });
  };
  try {
    const ingested = await localApi("/api/board", {
      method: "POST",
      body: {
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
          notes: "Recorded by Scout.",
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
      },
    });
    assert.equal(ingested.status, 201, JSON.stringify(ingested.body));
    const id = ingested.body.scout[0].id;
    writeFileSync(
      join(shared, "picks", "ada.json"),
      JSON.stringify({
        agent: "ada",
        id,
        verdict: "maybe",
        reason: "Small enough to build.",
        angle: "Start with the note route.",
        date: "2026-10-23T04:00:00.000Z",
      }) + "\n",
    );
    writeFileSync(
      join(shared, "picks", "bad.json"),
      JSON.stringify({
        agent: "nope",
        id,
        verdict: "ship",
        reason: "no",
        angle: "no",
        date: "2026-10-23T04:00:00.000Z",
      }) + "\n",
    );
    writeFileSync(
      join(shared, "picks", "other.json"),
      JSON.stringify({
        agent: "bea",
        id: "opp_" + "ef".repeat(8),
        verdict: "skip",
        reason: "No matching entry.",
        angle: "Wait.",
        date: "2026-10-23T04:00:00.000Z",
      }) + "\n",
    );
    const board = await localApi("/api/board");
    assert.equal(board.status, 200, JSON.stringify(board.body));
    assert.equal(board.body.scout[0].agent_picks.length, 1);
    assert.equal(board.body.scout[0].agent_picks[0].verdict, "maybe");
    assert.equal(board.body.scout[0].agent_picks[0].agent, "ada");
    assert.equal(board.body.agent_pick_errors.length, 1);
    assert.match(
      board.body.agent_pick_errors[0].reason,
      /build, skip, or maybe/,
    );
    assert.equal(board.body.unmatched_agent_picks[0].verdict, "skip");
    const page = readFileSync(
      new URL("./public/studio.js", import.meta.url),
      "utf8",
    );
    assert.match(page, /No agent verdict for this entry/);
  } finally {
    local.server.close();
    if (previous === undefined) delete process.env.REE_SHARED_BOARD;
    else process.env.REE_SHARED_BOARD = previous;
  }
});

test("a live build fills What we do better only for evidence about the target", async () => {
  const board = mkdtempSync(join(tmpdir(), "ree-better-board-"));
  mkdirSync(join(board, "picks"));
  const pick = (id, reason, angle, url) => ({
    agent: "fixture",
    id,
    verdict: "build",
    reason,
    angle,
    date: "2026-10-22",
    ...(url ? { url } : {}),
  });
  writeFileSync(
    join(board, "picks", "photo.json"),
    JSON.stringify(
      pick(
        "photo-list",
        "Add a photo list to each record.",
        "Photo list",
        "https://widgets.example/ideas/photo-list",
      ),
    ) + "\n",
  );
  for (const [id, reason, angle] of [
    ["billing", "Shopify billing needs a retry.", "Billing"],
    ["certs", "The certificate expires next week.", "Cert expiry"],
    ["backup", "SaaS backup is missing.", "Backup"],
    ["status", "Status pages should be public.", "Status pages"],
  ]) {
    writeFileSync(
      join(board, "picks", id + ".json"),
      JSON.stringify(pick(id, reason, angle, null)) + "\n",
    );
  }
  const built = await api("/api/builds", {
    method: "POST",
    body: { product_name: "Harbor Kit", spec: spec(), improve_board: board },
  });
  assert.equal(built.status, 201, JSON.stringify(built.body));
  assert.equal(built.body.improvements.items.length, 1);
  assert.equal(
    built.body.improvements.items[0].quote,
    "Add a photo list to each record.",
  );
  assert.equal(
    built.body.improvements.items.some((item) =>
      String(item.quote).includes("Shopify"),
    ),
    false,
  );
  const written = JSON.parse(
    readFileSync(join(built.body.out_dir, "behavior-spec.json"), "utf8"),
  );
  const photo = written.features.find(
    (feature) => feature.name === "Photo list",
  );
  assert.ok(photo);
  assert.equal(photo.citations[0].fetched_at, "2026-10-22T00:00:00.000Z");
  assert.equal(photo.id.startsWith("improve:"), false);
  const routes = readFileSync(
    join(built.body.out_dir, "src/routes.mjs"),
    "utf8",
  );
  assert.match(routes, /\/photo-list/);
  assert.equal(routes.includes("/improve-"), false);
  const started = await api("/api/live-builds", {
    method: "POST",
    body: {
      product_name: "Harbor Kit",
      spec: spec(),
      improve_board: board,
    },
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  let snapshot = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const polled = await api("/api/live-builds/" + started.body.live_id);
    snapshot = polled.body;
    if (snapshot.finished === true) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  assert.equal(snapshot.finished, true, JSON.stringify(snapshot));
  assert.equal(snapshot.status, "verified", snapshot.error);
  assert.equal(snapshot.improvements.title, "What we do better");
  assert.equal(snapshot.improvements.items.length, 1);
  assert.equal(
    snapshot.improvements.items[0].quote,
    "Add a photo list to each record.",
  );
});
