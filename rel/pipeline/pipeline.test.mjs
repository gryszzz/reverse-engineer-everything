import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
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

test("rebuild stays outside the repo, omits quotes, and implements a feature with no endpoint", () => {
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
  assert.equal(verified.features[0].match, "pass");
  assert.equal(verified.features[0].id, "feature:shared-boards");
  assert.equal(verified.features[0].route.method, "POST");
  assert.equal(verified.features[0].route.path, "/shared-boards");
  assert.equal(verified.implemented, 1);
  assert.equal(verified.unimplemented, 0);
  assert.equal(verified.failed, 0);
  assert.equal(verified.ratio, 1);
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
  assert.equal(listing.stdout.includes("NOTICE"), true);
  assert.equal(listing.stdout.includes("LANDING.md"), true);
  assert.equal(listing.stdout.includes("PRICING.md"), true);
  assert.equal(listing.stdout.includes("src/server.mjs"), true);
  assert.equal(listing.stdout.includes("product.tgz"), false);
  const notice = readFileSync(join(out, "NOTICE"), "utf8");
  assert.match(notice, /Copyright \(c\) 2026 morluto/);
  assert.match(notice, /not viewed/);
  assert.equal(notice.includes("Widget Cloud"), false);
  const landing = readFileSync(join(out, "LANDING.md"), "utf8");
  assert.equal(landing.includes("Widget Cloud"), false);
  assert.match(landing, /Board Kit/);
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
  assert.match(readme, /Those routes run/);
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
  assert.equal(vault.approval_requested, false);
  assert.equal(vault.stripe.product_id, null);
  const scale = JSON.parse(
    readFileSync(join(emitted.directory, "scale/manifest.json"), "utf8"),
  );
  assert.equal(scale.schema_version, "ree.scale.handoff.v1");
  assert.equal(scale.dry_run, true);
  assert.equal(scale.notified_scale, false);
  assert.equal(scale.approved, false);
  assert.equal(handoff.feature_match.implemented, 1);
  assert.ok(handoff.works_now.includes("POST /shared-boards returns 201."));
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
  assert.equal(byName["Shared boards"].match, "pass");
  assert.equal(byName["Shared boards"].route.path, "/shared-boards");
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
  const out = join(home, "js-out");
  mkdirSync(dir);
  writeFileSync(join(dir, "main.mjs"), "export const value = 1;\n");
  const run = spawnSync(
    process.execPath,
    [cli, "pipeline", dir, "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /pipeline stopped at scope/);
  assert.match(run.stderr, /request\.json/);
  assert.match(run.stderr, /did not invent a product spec/);
  const saved = JSON.parse(readFileSync(join(out, "run.json"), "utf8"));
  assert.equal(saved.stopped_at, "scope");
  assert.equal(saved.finished, true);
  assert.equal(
    saved.stages.find((stage) => stage.id === "investigate").status,
    "pending",
  );
  const scope = JSON.parse(
    readFileSync(join(out, "checkpoints/scope.json"), "utf8"),
  );
  assert.equal(scope.status, "failed");
  const again = spawnSync(
    process.execPath,
    [cli, "pipeline", dir, "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(again.status, 2, again.stderr);
  assert.match(again.stderr, /already has a pipeline run/);
});

test("pipeline stops before analyzing a non-JavaScript artifact", () => {
  const dir = join(home, "notes");
  const out = join(home, "notes-out");
  mkdirSync(dir);
  writeFileSync(join(dir, "notes.txt"), "hello\n");
  const run = spawnSync(
    process.execPath,
    [cli, "pipeline", dir, "--authorized", "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 1, run.stderr + run.stdout);
  assert.match(run.stderr, /pipeline stopped at investigate/);
  assert.match(run.stderr, /JavaScript/);
  assert.equal(existsSync(join(out, "findings.json")), false);
  const saved = JSON.parse(readFileSync(join(out, "run.json"), "utf8"));
  assert.equal(saved.stopped_at, "investigate");
  assert.equal(
    saved.stages.find((stage) => stage.id === "spec").status,
    "pending",
  );
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
  assert.equal(shared.match, "pass");
  assert.equal(shared.route.path, "/shared-boards");
  const local = outcome.verify.features.find((feature) =>
    feature.id.startsWith("feature:local-boards"),
  );
  assert.equal(local.match, "pass");
  assert.ok(outcome.verify.ratio >= 0.8);
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
  assert.match(source, /listBoards/);
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
  assert.equal(vault.approval_requested, false);
  assert.equal(vault.stripe.product_id, null);
  const scale = JSON.parse(
    readFileSync(join(outcome.handoff_dir, "scale/manifest.json"), "utf8"),
  );
  assert.equal(scale.notified_scale, false);
  assert.equal(scale.approved, false);
  assert.equal(scale.dry_run, true);
  assert.equal(
    handoff.picks.some((pick) => pick.name === "Shared boards"),
    true,
  );
  const pickFiles = readdirSync(join(outcome.board_dir, "picks")).filter(
    (name) => name.endsWith(".json"),
  );
  const picks = pickFiles.map((name) =>
    JSON.parse(readFileSync(join(outcome.board_dir, "picks", name), "utf8")),
  );
  const sharedPick = picks.find((pick) => pick.name === "Shared boards");
  assert.equal(sharedPick.schema_version, "ree.board.pick.v1");
  assert.equal(sharedPick.match, "pass");
  assert.equal(sharedPick.route.method, "POST");
  assert.equal(sharedPick.route.path, "/shared-boards");
  assert.ok(picks.some((pick) => pick.name === "Create a board"));
  const findings = readdirSync(join(outcome.board_dir, "findings"))
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      JSON.parse(
        readFileSync(join(outcome.board_dir, "findings", name), "utf8"),
      ),
    );
  assert.ok(
    findings.some(
      (finding) =>
        finding.kind === "feature" && finding.name === "Shared boards",
    ),
  );
  for (const finding of findings) {
    if (finding.match === "pass") continue;
    assert.equal(
      picks.some((pick) => pick.feature_id === finding.feature_id),
      false,
    );
  }
  for (const system of ["guard", "blast", "scale"]) {
    const request = JSON.parse(
      readFileSync(
        join(outcome.handoff_dir, "requests", system + ".json"),
        "utf8",
      ),
    );
    assert.equal(request.schema_version, "ree.handoff.request.v1");
    assert.equal(request.to, system);
    assert.equal(request.called, false);
    assert.equal(request.dry_run, true);
    assert.ok(request.picks.some((pick) => pick.id === sharedPick.id));
  }
  const exportedDir = join(home, "board-export");
  const exported = spawnSync(
    process.execPath,
    [cli, "board", "export", "--data", out, "--out", exportedDir, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(exported.status, 0, exported.stderr + exported.stdout);
  const manifest = JSON.parse(exported.stdout);
  assert.equal(manifest.schema_version, "ree.board.export.v1");
  assert.equal(manifest.dry_run, true);
  assert.equal(manifest.called.guard, false);
  assert.equal(manifest.called.blast, false);
  assert.equal(manifest.called.scale, false);
  assert.equal(existsSync(join(exportedDir, "requests/guard.json")), true);
  assert.equal(
    existsSync(join(exportedDir, "picks", sharedPick.id + ".json")),
    true,
  );
  const picksRun = spawnSync(
    process.execPath,
    [cli, "board", "picks", "--data", out, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(picksRun.status, 0, picksRun.stderr + picksRun.stdout);
  const listedPicks = JSON.parse(picksRun.stdout);
  assert.ok(listedPicks.some((pick) => pick.name === "Create a board"));
  const guard = JSON.parse(
    readFileSync(join(out, "guard/submission.json"), "utf8"),
  );
  assert.equal(guard.sign_off, "not-submitted");
  assert.equal(guard.approval_requested, false);
  assert.match(guard.note, /Guard was not called/);
  const notice = readFileSync(join(product, "NOTICE"), "utf8");
  const landing = readFileSync(join(product, "LANDING.md"), "utf8");
  assert.equal(notice.includes("Bench Boards"), false);
  assert.equal(landing.includes("Bench Boards"), false);
  assert.match(notice, /Copyright \(c\) 2026 morluto/);
  assert.match(landing, /Board Desk/);
  assert.equal(landing.includes("People can open one board together."), false);
  const accuracy = JSON.parse(readFileSync(join(out, "accuracy.json"), "utf8"));
  assert.equal(accuracy.not_the_corpus_bench, true);
  assert.equal(accuracy.precision, 1);
  assert.equal(accuracy.recall, 1);
  assert.deepEqual(accuracy.false_claims, []);
  assert.ok(accuracy.expected_implemented_ids.includes(create.id));
  for (const stage of outcome.stages)
    assert.equal(stage.status, "passed", stage.id);
  assert.equal(outcome.stopped_at, null);
  assert.equal(outcome.approvals.launch, false);
  assert.equal(outcome.launch_approved, false);
  const scopeBefore = JSON.parse(
    readFileSync(join(out, "checkpoints/scope.json"), "utf8"),
  ).finished_at;
  const resumed = spawnSync(
    process.execPath,
    [
      cli,
      "pipeline",
      web,
      "--name",
      "Board Desk",
      "--out",
      out,
      "--resume",
      "--approve-guard",
      "--approve-launch",
      "--approve-blast",
      "--approve-scale",
      "--approve-vault",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
  const approved = JSON.parse(resumed.stdout);
  assert.equal(approved.dry_run, true);
  assert.equal(approved.notified_blast, false);
  assert.equal(approved.notified_scale, false);
  assert.equal(approved.guard_sign_off, "not-submitted");
  assert.equal(approved.approved_for_vault_copy, false);
  assert.equal(approved.launch_approved, true);
  assert.equal(approved.approvals.guard, true);
  assert.equal(approved.box_copied, false);
  const scopeAfter = JSON.parse(
    readFileSync(join(out, "checkpoints/scope.json"), "utf8"),
  ).finished_at;
  assert.equal(scopeAfter, scopeBefore);
  const guardAfter = JSON.parse(
    readFileSync(join(out, "guard/submission.json"), "utf8"),
  );
  assert.equal(guardAfter.approval_requested, true);
  assert.equal(guardAfter.sign_off, "not-submitted");
  assert.match(guardAfter.note, /Guard was not called/);
  const scaleAfter = JSON.parse(
    readFileSync(join(approved.handoff_dir, "scale/manifest.json"), "utf8"),
  );
  assert.equal(scaleAfter.approved, true);
  assert.equal(scaleAfter.notified_scale, false);
  const vaultAfter = JSON.parse(
    readFileSync(join(approved.handoff_dir, "vault/manifest.json"), "utf8"),
  );
  assert.equal(vaultAfter.approved_for_vault_copy, false);
  assert.equal(vaultAfter.approval_requested, true);
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
    const listed = await fetch(`http://127.0.0.1:${port}/boards`);
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray((await listed.json()).items));
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await page.text(), /data-path="\/boards"/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("pipeline resumes after a product name collision", () => {
  const web = fileURLToPath(
    new URL("../../experiments/ree-bench/web/", import.meta.url),
  );
  const out = join(home, "same-target");
  const blocked = spawnSync(
    process.execPath,
    [cli, "pipeline", web, "--name", "Bench Boards", "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(blocked.status, 1, blocked.stderr + blocked.stdout);
  assert.match(blocked.stderr, /pipeline stopped at rebuild/);
  assert.match(blocked.stderr, /must differ/);
  const scopeBefore = JSON.parse(
    readFileSync(join(out, "checkpoints/scope.json"), "utf8"),
  ).finished_at;
  assert.equal(existsSync(join(out, "product/src/server.mjs")), false);
  const resumed = spawnSync(
    process.execPath,
    [
      cli,
      "pipeline",
      web,
      "--name",
      "Board Desk",
      "--out",
      out,
      "--resume",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
  const outcome = JSON.parse(resumed.stdout);
  assert.equal(outcome.product_name, "Board Desk");
  assert.equal(outcome.dry_run, true);
  const create = outcome.verify.features.find(
    (feature) => feature.name === "Create a board",
  );
  assert.equal(create.match, "pass");
  const scopeAfter = JSON.parse(
    readFileSync(join(out, "checkpoints/scope.json"), "utf8"),
  ).finished_at;
  assert.equal(scopeAfter, scopeBefore);
  assert.equal(
    readFileSync(join(outcome.product_dir, "README.md"), "utf8").includes(
      "Bench Boards",
    ),
    false,
  );
});
