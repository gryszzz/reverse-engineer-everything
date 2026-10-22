import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { emitHandoff, blastDirectory } from "../handoff/emit.mjs";
import {
  ingestScout,
  ingestSpec,
  listOpportunities,
} from "../opportunities/board.mjs";
import {
  CLEAN_ROOM_STATEMENT,
  SCHEMA_VERSION,
  USER_AGENT,
} from "../outside-in/constants.mjs";
import { scaffoldRebuild } from "../rebuild/scaffold.mjs";
import { verifyRebuild } from "../rebuild/verify.mjs";
import { validateBehaviorSpec } from "../outside-in/validate.mjs";

const home = mkdtempSync(join(tmpdir(), "ree-pipeline-"));
const cli = fileURLToPath(new URL("../../ree.mjs", import.meta.url));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const citation = {
  url: "https://widgets.example/docs",
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
        url: "https://widgets.example/docs",
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
        id: "feature:shared-boards",
        name: "Shared boards",
        detail: "People can open the same board.",
        origin: "docs",
        quote: {
          text: "DISTINCTIVE_BOARD_QUOTE_should_not_land_in_src",
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
      endpoints: [],
      unknowns: [],
    },
    pricing: { plans: [], unknowns: ["No pricing URL was supplied."] },
    integrations: [],
    limitations: [
      {
        statement: {
          text: "Support replies take days.",
          attributed_quote: true,
        },
        origin: "reviews",
        citations: [citation],
      },
    ],
    changes: [],
    omitted: [],
    similarity: { threshold: 80, quote_max: 160, flagged: false, findings: [] },
    coverage: {
      examined_urls: ["https://widgets.example/docs"],
      unknowns: ["No pricing URL was supplied."],
    },
  };
}

function scout() {
  return {
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
        summary: "Support replies take days.",
        evidence_urls: ["https://widgets.example/reviews"],
      },
    ],
    market_signal: {
      review_count: 10,
      rating: 3.5,
      complaint_volume: 4,
      search_demand: 2,
      notes: "Supplied by the Scout file.",
    },
    scores: {
      pain: 4,
      willingness_to_pay: 3,
      build_ease: 2,
      competitor_weakness: 4,
      reach: 3,
      total: 16,
    },
    confidence: 70,
    found_at: "2026-10-22T00:00:00.000Z",
    tracker_ref: "/home/box/shared/scout/opportunities.md",
  };
}

test("a behavior spec fixture validates", () => {
  assert.equal(validateBehaviorSpec(spec()).ok, true);
});

test("scout totals must match and specs do not receive invented market scores", () => {
  const board = join(home, "board");
  ingestScout(board, scout());
  const bad = scout();
  bad.scores = { ...bad.scores, total: 99 };
  assert.throws(() => ingestScout(board, bad), /scores.total/);
  ingestSpec(board, spec());
  const listed = listOpportunities(board);
  assert.equal(listed.scout.length, 1);
  assert.equal(listed.scout[0].listing.scores.total, 16);
  assert.equal(listed.scout[0].listing.score_source, "scout");
  assert.equal(listed.specs[0].listing.scores, null);
  assert.equal(listed.specs[0].listing.coverage.features, 1);
});

test("rebuild stays outside the repo, omits quotes, and leaves unmatched features unimplemented", () => {
  const inside = fileURLToPath(new URL("./inside-rebuild", import.meta.url));
  assert.throws(
    () =>
      scaffoldRebuild({
        spec: spec(),
        productName: "Board Kit",
        outDir: inside,
      }),
    /outside the REE repository/,
  );
  assert.throws(
    () =>
      scaffoldRebuild({
        spec: spec(),
        productName: "Widget Cloud",
        outDir: join(home, "same-name"),
      }),
    /must differ/,
  );
  const out = join(home, "rebuild");
  const built = scaffoldRebuild({
    spec: spec(),
    productName: "Board Kit",
    outDir: out,
  });
  const source = readFileSync(join(out, "src/behaviors.mjs"), "utf8");
  assert.equal(source.includes("DISTINCTIVE_BOARD_QUOTE"), false);
  assert.equal(
    readFileSync(join(out, "README.md"), "utf8").includes("Widget Cloud"),
    false,
  );
  assert.equal(built.provenance.original_code_copied, false);
  const verified = verifyRebuild(out);
  assert.equal(verified.exit_code, 0, verified.stderr || verified.stdout);
  assert.equal(verified.features[0].match, "unimplemented");
  assert.equal(verified.features[0].id, "feature:shared-boards");
  assert.equal(verified.implemented, 0);
  assert.equal(verified.unimplemented, 1);
  assert.equal(verified.failed, 0);
  assert.equal(verified.ratio, 0);
  assert.equal(verified.quote_test_passed, true);
  assert.equal(source.includes("Shared boards"), false);
  const readme = readFileSync(join(out, "README.md"), "utf8");
  assert.equal(readme.includes("Widget Cloud"), false);
  assert.match(readme, /npm start/);
  assert.match(
    readFileSync(join(out, "LICENSE"), "utf8"),
    /Copyright \(c\) 2026 morluto/,
  );
  assert.match(
    readFileSync(join(out, "LICENSE"), "utf8"),
    /not the target's license/,
  );
  assert.match(
    readFileSync(join(out, "PRICING.md"), "utf8"),
    /No pricing was in the spec and none was invented/,
  );
  const listing = spawnSync("tar", ["-tzf", join(out, "product.tgz")], {
    encoding: "utf8",
  });
  assert.equal(listing.status, 0, listing.stderr);
  assert.equal(listing.stdout.includes("README.md"), true);
  assert.equal(listing.stdout.includes("LICENSE"), true);
  assert.equal(listing.stdout.includes("PRICING.md"), true);
  assert.equal(listing.stdout.includes("src/server.mjs"), true);
  assert.equal(listing.stdout.includes("product.tgz"), false);
});

test("handoff writes the box layout only when that directory exists", () => {
  assert.throws(
    () =>
      blastDirectory({
        buildId: "bld_" + "ab".repeat(8),
        boxRoot: join(home, "missing-box"),
      }),
    /Pass --blast-dir/,
  );
  const box = join(home, "box");
  mkdirSync(box);
  const directed = blastDirectory({
    buildId: "bld_" + "cd".repeat(8),
    boxRoot: box,
  });
  assert.equal(directed, join(box, "ree-to-blast", "bld_" + "cd".repeat(8)));
});

test("handoff files keep competitor names out of the README and do not claim Guard or Vault", () => {
  const project = join(home, "handoff-project");
  scaffoldRebuild({ spec: spec(), productName: "Board Kit", outDir: project });
  const verify = verifyRebuild(project);
  const emitted = emitHandoff({
    projectDir: project,
    verify,
    scout: scout(),
    blastDir: join(home, "blast"),
  });
  const readme = readFileSync(join(emitted.directory, "README.md"), "utf8");
  assert.equal(readme.includes("Widget Cloud"), false);
  assert.match(readme, /Dry run/);
  assert.match(readme, /No route test passed/);
  assert.equal(
    readme.includes("A declaration is not a running feature."),
    false,
  );
  const handoff = JSON.parse(
    readFileSync(join(emitted.directory, "handoff.json"), "utf8"),
  );
  assert.equal(handoff.dry_run, true);
  assert.equal(handoff.notified_blast, false);
  assert.equal(handoff.guard.sign_off, "not-submitted");
  assert.equal(
    handoff.competitor_weaknesses[0].source_url,
    "https://widgets.example/reviews",
  );
  assert.equal(
    handoff.competitor_weaknesses[0].fetched_at,
    "2026-10-22T00:00:00.000Z",
  );
  assert.equal(
    handoff.customer.review_quotes[0].text,
    "Support replies take days.",
  );
  const guard = JSON.parse(
    readFileSync(join(emitted.directory, "guard/submission.json"), "utf8"),
  );
  assert.equal(guard.secrets_included, false);
  assert.deepEqual(guard.build.env_var_names, []);
  const vault = JSON.parse(
    readFileSync(join(emitted.directory, "vault/manifest.json"), "utf8"),
  );
  assert.equal(vault.approved_for_vault_copy, false);
  assert.equal(vault.stripe.product_id, null);
  assert.equal(handoff.feature_match.implemented, 0);
  assert.deepEqual(handoff.works_now, []);
  assert.equal(handoff.notified_blast, false);
});

test("CLI list prints scout totals and the absence of a spec market score", () => {
  const board = join(home, "cli-board");
  const scoutFile = join(home, "scout.json");
  const specFile = join(home, "spec.json");
  writeFileSync(scoutFile, JSON.stringify(scout()));
  writeFileSync(specFile, JSON.stringify(spec()));
  const first = spawnSync(
    process.execPath,
    [cli, "opportunities", "ingest", scoutFile, "--out", board],
    { encoding: "utf8" },
  );
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync(
    process.execPath,
    [cli, "opportunities", "ingest", specFile, "--out", board],
    { encoding: "utf8" },
  );
  assert.equal(second.status, 0, second.stderr);
  const listed = spawnSync(
    process.execPath,
    [cli, "opportunities", "list", "--data", board],
    { encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /total 16\/25/);
  assert.match(listed.stdout, /no market score/);
});

test("rebuild serves an endpoint whose summary or operation id matches a feature", () => {
  const value = spec();
  const citation = value.features[0].citations[0];
  value.features.push(
    {
      id: "feature:create-a-board",
      name: "Create a board",
      detail: "A route.",
      origin: "docs",
      quote: {
        text: "People create a board from the client.",
        attributed_quote: true,
      },
      citations: [citation],
    },
    {
      id: "feature:listboards",
      name: "listBoards",
      detail: "A route.",
      origin: "docs",
      citations: [citation],
    },
    {
      id: "feature:open-a-board",
      name: "Open a board",
      detail: "A template.",
      origin: "docs",
      citations: [citation],
    },
  );
  value.api.style = "openapi";
  value.api.endpoints = [
    {
      method: "POST",
      path: "/boards",
      operation_id: "createBoard",
      summary: { text: "Create a board", attributed_quote: true },
      parameters: ["boardName"],
      response_codes: ["201"],
      citations: [citation],
    },
    {
      method: "GET",
      path: "/boards",
      operation_id: "listBoards",
      summary: { text: "List boards", attributed_quote: true },
      parameters: [],
      response_codes: ["200"],
      citations: [citation],
    },
    {
      method: "GET",
      path: "/boards/{id}",
      operation_id: "openBoard",
      summary: { text: "Open a board", attributed_quote: true },
      parameters: [],
      response_codes: ["200"],
      citations: [citation],
    },
  ];
  value.pricing.plans = [
    {
      name: "Desk",
      price: {
        amount: "12",
        currency: "USD",
        interval: "month",
        display: "$12/month",
      },
      limits: [],
      includes: [],
      citations: [citation],
    },
  ];
  value.pricing.unknowns = [];
  const out = join(home, "http-rebuild");
  scaffoldRebuild({ spec: value, productName: "Board Kit", outDir: out });
  const verified = verifyRebuild(out);
  assert.equal(verified.exit_code, 0, verified.stderr || verified.stdout);
  const byName = Object.fromEntries(
    verified.features.map((feature) => [feature.name, feature]),
  );
  assert.equal(byName["Create a board"].match, "pass");
  assert.equal(byName["Create a board"].route.method, "POST");
  assert.equal(byName["Create a board"].route.success_status, 201);
  assert.equal(byName.listBoards.match, "pass");
  assert.equal(byName.listBoards.route.method, "GET");
  assert.equal(byName["Shared boards"].match, "unimplemented");
  assert.equal(byName["Open a board"].match, "unimplemented");
  const source = ["behaviors.mjs", "routes.mjs", "server.mjs"]
    .map((name) => readFileSync(join(out, "src", name), "utf8"))
    .join("\n");
  assert.equal(source.includes("Create a board"), false);
  assert.equal(
    source.includes("People create a board from the client."),
    false,
  );
  assert.equal(source.includes("DISTINCTIVE_BOARD_QUOTE"), false);
  assert.equal(source.includes("/boards/{id}"), false);
  assert.equal(source.includes("openBoard"), false);
  assert.match(source, /createBoard/);
  assert.match(source, /listBoards/);
  const pricing = readFileSync(join(out, "PRICING.md"), "utf8");
  assert.match(pricing, /\$12\/month/);
  assert.match(pricing, /https:\/\/widgets\.example\/docs/);
  assert.match(pricing, /no price was invented/);
  const emitted = emitHandoff({
    projectDir: out,
    verify: verified,
    blastDir: join(home, "http-blast"),
  });
  const handoff = JSON.parse(
    readFileSync(join(emitted.directory, "handoff.json"), "utf8"),
  );
  assert.equal(handoff.dry_run, true);
  assert.equal(handoff.notified_blast, false);
  assert.ok(handoff.works_now.includes("POST /boards returns 201."));
  assert.ok(handoff.works_now.includes("GET /boards returns 200."));
  assert.equal(
    readFileSync(join(emitted.directory, "README.md"), "utf8").includes(
      "Widget Cloud",
    ),
    false,
  );
});

test("pipeline refuses a directory that has no request.json", () => {
  const dir = join(home, "js-only");
  mkdirSync(dir);
  writeFileSync(join(dir, "main.mjs"), "export const value = 1;\n");
  const run = spawnSync(
    process.execPath,
    [cli, "pipeline", dir, "--out", join(home, "js-out")],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /request\.json/);
  assert.match(run.stderr, /not a product spec/);
});

test("pipeline rebuilds the owned web bench into a packaged product", async () => {
  const web = fileURLToPath(
    new URL("../../experiments/ree-bench/web/", import.meta.url),
  );
  const out = join(home, "web-pipeline");
  const run = spawnSync(
    process.execPath,
    [cli, "pipeline", web, "--name", "Board Desk", "--out", out, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const outcome = JSON.parse(run.stdout);
  assert.equal(outcome.dry_run, true);
  assert.equal(outcome.notified_blast, false);
  assert.equal(outcome.guard_sign_off, "not-submitted");
  assert.equal(outcome.approved_for_vault_copy, false);
  assert.equal(outcome.product_name, "Board Desk");
  const create = outcome.verify.features.find(
    (feature) => feature.name === "Create a board",
  );
  assert.equal(create.match, "pass");
  assert.equal(create.route.method, "POST");
  assert.equal(create.route.path, "/boards");
  assert.equal(create.route.success_status, 201);
  const shared = outcome.verify.features.find(
    (feature) => feature.name === "Shared boards",
  );
  assert.equal(shared.match, "unimplemented");
  for (const feature of outcome.verify.features) {
    if (feature.name !== "Create a board")
      assert.notEqual(feature.match, "pass", feature.name);
  }
  const product = outcome.product_dir;
  const readme = readFileSync(join(product, "README.md"), "utf8");
  assert.equal(readme.includes("Bench Boards"), false);
  const source = ["behaviors.mjs", "routes.mjs", "server.mjs"]
    .map((name) => readFileSync(join(product, "src", name), "utf8"))
    .join("\n");
  assert.equal(source.includes("Bench Boards"), false);
  assert.equal(source.includes("People can open one board together."), false);
  assert.equal(
    source.includes("People create a board from the client."),
    false,
  );
  assert.equal(source.includes("Local boards for the accuracy bench."), false);
  assert.equal(source.includes("Create a board"), false);
  assert.equal(source.includes("listBoards"), false);
  assert.match(source, /createBoard/);
  assert.match(
    readFileSync(join(product, "PRICING.md"), "utf8"),
    /none was invented/,
  );
  const listed = listOpportunities(outcome.board_dir);
  assert.equal(listed.specs.length, 1);
  assert.equal(listed.specs[0].listing.scores, null);
  const handoff = JSON.parse(
    readFileSync(join(outcome.handoff_dir, "handoff.json"), "utf8"),
  );
  assert.equal(handoff.dry_run, true);
  assert.equal(handoff.notified_blast, false);
  assert.equal(handoff.guard.sign_off, "not-submitted");
  assert.ok(handoff.works_now.includes("POST /boards returns 201."));
  assert.equal(
    readFileSync(join(outcome.handoff_dir, "README.md"), "utf8").includes(
      "Bench Boards",
    ),
    false,
  );
  const vault = JSON.parse(
    readFileSync(join(outcome.handoff_dir, "vault/manifest.json"), "utf8"),
  );
  assert.equal(vault.approved_for_vault_copy, false);
  assert.equal(vault.stripe.product_id, null);
  const { listen } = await import(
    pathToFileURL(join(product, "src/server.mjs")).href
  );
  const server = await listen(0);
  try {
    const port = server.address().port;
    const created = await fetch(
      `http://127.0.0.1:${port}/boards?boardName=alpha`,
      { method: "POST" },
    );
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.boardName, "alpha");
    const missing = await fetch(`http://127.0.0.1:${port}/boards`);
    assert.equal(missing.status, 405);
    assert.equal((await missing.json()).error, "method");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("pipeline rejects a product name that copies the spec target", () => {
  const web = fileURLToPath(
    new URL("../../experiments/ree-bench/web/", import.meta.url),
  );
  const run = spawnSync(
    process.execPath,
    [
      cli,
      "pipeline",
      web,
      "--name",
      "Bench Boards",
      "--out",
      join(home, "same-target"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 2, run.stdout);
  assert.match(run.stderr, /must differ/);
});
