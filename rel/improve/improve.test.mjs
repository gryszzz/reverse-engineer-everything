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
import { emitHandoff } from "../handoff/emit.mjs";
import { scaffoldRebuild } from "../rebuild/scaffold.mjs";
import {
  CLEAN_ROOM_STATEMENT,
  SCHEMA_VERSION,
  USER_AGENT,
} from "../outside-in/constants.mjs";
import { validateBehaviorSpec } from "../outside-in/validate.mjs";
import { runProductPipeline } from "../pipeline/run.mjs";
import { collectImprovements, specWithImprovements } from "./collect.mjs";

const home = mkdtempSync(join(tmpdir(), "ree-improve-"));
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
    limitations: [],
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
        type: "missing_feature",
        summary: "Export is missing from the product.",
        evidence_urls: ["https://widgets.example/reviews"],
      },
      {
        type: "ux",
        summary: "The editor hides the save button.",
        evidence_urls: ["https://widgets.example/reviews"],
      },
      {
        type: "overpriced",
        summary: "The seat price is hard to justify.",
        evidence_urls: ["https://widgets.example/pricing"],
      },
      {
        type: "support",
        summary: "Widget Cloud takes days to reply.",
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

function scale() {
  return {
    schema_version: "ree.scale.evidence.v1",
    target_name: "Widget Cloud",
    url: "https://widgets.example/",
    category: "search",
    willingness_to_pay: [
      {
        quote: "Would pay 4 dollars for a smaller plan.",
        amount: "4.00",
        currency: "usd",
        source_url: "https://owned.example/scale",
      },
      {
        quote: "Would pay 12 dollars for one plan.",
        amount: "12.00",
        currency: "usd",
        source_url: "https://owned.example/scale",
      },
    ],
    pricing: [
      {
        quote: "One plan would be simpler.",
        source_url: "https://owned.example/pricing",
      },
      {
        quote: "",
        source_url: "https://owned.example/pricing",
      },
    ],
  };
}

function writeEvidence(dir) {
  mkdirSync(join(dir, "picks"), { recursive: true });
  writeFileSync(join(dir, "scout.json"), JSON.stringify(scout()));
  writeFileSync(join(dir, "scale.json"), JSON.stringify(scale()));
  writeFileSync(
    join(dir, "picks", "build.json"),
    JSON.stringify({
      agent: "ada",
      id: "opp_0123456789abcdef",
      verdict: "build",
      reason: "Add a shared export.",
      angle: "Export",
      date: "2026-10-22",
      url: "https://widgets.example/ideas",
    }),
  );
  writeFileSync(
    join(dir, "picks", "unsourced.json"),
    JSON.stringify({
      agent: "ada",
      id: "opp_unsourced000001",
      verdict: "build",
      reason: "Add a dated export without a source.",
      angle: "Dated export",
      date: "2026-10-22",
      target_name: "Widget Cloud",
    }),
  );
  writeFileSync(
    join(dir, "picks", "shopify.json"),
    JSON.stringify({
      agent: "ada",
      id: "opp_shopify0000001",
      verdict: "build",
      reason: "Shopify billing needs a receipt.",
      angle: "Shopify billing",
      date: "2026-10-22",
    }),
  );
  writeFileSync(
    join(dir, "picks", "skip.json"),
    JSON.stringify({
      agent: "ada",
      id: "opp_fedcba9876543210",
      verdict: "skip",
      reason: "Leave billing alone.",
      angle: "Billing",
      date: "2026-10-22T00:00:00.000Z",
    }),
  );
}

test("an empty evidence directory leaves an empty improvement list", () => {
  const dir = join(home, "empty");
  mkdirSync(dir);
  const report = collectImprovements({
    evidencePath: dir,
    boxBoard: null,
    now: new Date("2026-10-23T00:00:00.000Z"),
  });
  assert.equal(report.status, "empty");
  assert.equal(report.items.length, 0);
  assert.match(report.note, /list is empty/);
  assert.match(report.note, /Nothing was invented/);
  const behavior = spec();
  assert.equal(specWithImprovements(behavior, report), behavior);
});

test("no-improve does not read the evidence file", () => {
  const file = join(home, "off.json");
  writeFileSync(file, "{");
  const report = collectImprovements({
    evidencePath: file,
    noImprove: true,
    boxBoard: null,
  });
  assert.equal(report.items.length, 0);
  assert.match(report.note, /turned off/);
  assert.match(report.skipped[0].reason, /not read/);
});

test("Scout, Scale, and build picks become ranked quotes and nothing else", () => {
  const dir = join(home, "evidence");
  writeEvidence(dir);
  const report = collectImprovements({ evidencePath: dir, boxBoard: null });
  assert.deepEqual(
    report.items.map((item) => item.quote),
    [
      "Would pay 12 dollars for one plan.",
      "Would pay 4 dollars for a smaller plan.",
      "One plan would be simpler.",
      "Export is missing from the product.",
      "The editor hides the save button.",
      "The seat price is hard to justify.",
      "Widget Cloud takes days to reply.",
      "Add a shared export.",
    ],
  );
  assert.deepEqual(
    report.items.map((item) => item.record),
    ["scale", "scale", "scale", "scout", "scout", "scout", "scout", "pick"],
  );
  assert.equal(report.items[0].rank, 1);
  assert.equal(report.items[0].recorded.amount, "12.00");
  assert.equal(report.items[0].citation.url, "https://owned.example/scale");
  assert.equal(report.items[3].citation.url, "https://widgets.example/reviews");
  const pick = report.items.at(-1);
  assert.equal(pick.name, "Export");
  assert.equal(pick.citation.fetched_at, "2026-10-22T00:00:00.000Z");
  assert.equal(pick.citation.url, "https://widgets.example/ideas");
  assert.ok(
    report.skipped.some(
      (item) => item.unsourced === true && /unsourced/.test(item.reason),
    ),
  );
  const behavior = spec();
  const merged = specWithImprovements(
    behavior,
    report,
    new Date("2026-10-23T00:00:00.000Z"),
  );
  assert.equal(validateBehaviorSpec(merged).ok, true);
  const added = merged.features.find((feature) => feature.name === "Export");
  assert.equal(added.origin, "improvement");
  assert.equal(added.id.startsWith("feature:"), true);
  assert.equal(added.citations[0].fetched_at, "2026-10-22T00:00:00.000Z");
  assert.equal(added.name.includes(pick.quote), false);
  assert.equal(
    report.items.every((item) => item.accepted === true),
    true,
  );
  assert.equal(
    report.items.every((item) => item.mark === "improvement"),
    true,
  );
  const body = JSON.stringify(report);
  assert.equal(body.includes("faster support"), false);
  assert.equal(body.includes("simpler price"), false);
  assert.ok(report.skipped.some((item) => /not accepted/.test(item.reason)));
  assert.ok(report.skipped.some((item) => /needs a quote/.test(item.reason)));
  assert.ok(
    report.skipped.some((item) => /Only weakness quotes/.test(item.reason)),
  );
  assert.throws(
    () => collectImprovements({ evidencePath: join(dir, "missing.json") }),
    /not found/,
  );
});

test("sourced evidence that does not match the target is excluded", () => {
  const dir = join(home, "relevance");
  writeEvidence(dir);
  writeFileSync(
    join(dir, "picks", "billing.json"),
    JSON.stringify({
      agent: "ada",
      id: "opp_billing0000001",
      verdict: "build",
      reason: "Cert expiry warnings for the storefront.",
      angle: "Cert expiry",
      date: "2026-10-22",
      url: "https://shop.example/billing",
    }),
  );
  const report = collectImprovements({
    evidencePath: dir,
    boxBoard: null,
    target: {
      name: "Widget Cloud",
      urls: ["https://widgets.example/"],
      category: "search",
    },
  });
  assert.equal(
    report.items.some((item) => item.quote.includes("Cert expiry")),
    false,
  );
  assert.equal(
    report.items.some((item) => item.quote.includes("Shopify")),
    false,
  );
  assert.equal(
    report.items.some((item) => item.name === "Export"),
    true,
  );
  assert.ok(
    report.skipped.some((item) =>
      /does not match the target/.test(item.reason),
    ),
  );
  assert.ok(report.skipped.some((item) => item.unsourced === true));
});

test("a fixture with Scout and Scale evidence builds the cited improvements", async () => {
  const fixture = join(home, "fixture");
  const evidence = join(home, "fixture-evidence");
  mkdirSync(fixture);
  const behavior = spec();
  assert.equal(validateBehaviorSpec(behavior).ok, true);
  writeFileSync(join(fixture, "behavior-spec.json"), JSON.stringify(behavior));
  writeEvidence(evidence);
  const out = join(home, "run");
  const outcome = await runProductPipeline({
    target: fixture,
    outDir: out,
    productName: "Harbor Kit",
    improvementsFile: evidence,
    improveBoard: null,
    now: new Date("2026-10-23T00:00:00.000Z"),
  });
  assert.equal(outcome.code, 0, outcome.message);
  assert.equal(outcome.improvements.items.length, 8);
  assert.match(outcome.improvements.note, /No score was invented/);
  const report = readFileSync(
    join(out, "product", "FEATURE_REPORT.md"),
    "utf8",
  );
  assert.match(report, /\(improvement\)/);
  assert.equal(report.includes("Would pay 12 dollars for one plan."), false);
  assert.equal(report.includes("Widget Cloud"), false);
  const saved = JSON.parse(
    readFileSync(join(out, "improvements.json"), "utf8"),
  );
  assert.equal(
    saved.items.some((item) => item.quote.includes("Widget Cloud")),
    true,
  );
  const readme = readFileSync(join(outcome.handoff_dir, "README.md"), "utf8");
  assert.match(readme, /What we do better/);
  assert.match(readme, /\(improvement\)/);
  assert.equal(readme.includes("Widget Cloud"), false);
  const handoff = JSON.parse(
    readFileSync(join(outcome.handoff_dir, "handoff.json"), "utf8"),
  );
  assert.equal(handoff.improvements.items.length, 8);
  assert.equal(
    handoff.improvements.items.some((item) => item.quote_omitted === true),
    true,
  );
  assert.equal(
    JSON.stringify(handoff.improvements).includes("Widget Cloud"),
    false,
  );
  const server = readFileSync(
    join(out, "product", "src", "server.mjs"),
    "utf8",
  );
  assert.equal(server.includes("Would pay 12 dollars for one plan."), false);
  assert.equal(outcome.implemented, 9);
  assert.match(
    readFileSync(join(out, "product", "FEATURE_REPORT.md"), "utf8"),
    /Export/,
  );
  assert.equal(
    readFileSync(join(out, "product", "src", "routes.mjs"), "utf8").includes(
      "/improve-",
    ),
    false,
  );
  assert.equal(outcome.failed, 0);

  const quiet = join(home, "quiet");
  const quietOut = await runProductPipeline({
    target: fixture,
    outDir: quiet,
    productName: "Harbor Kit",
    improvementsFile: evidence,
    noImprove: true,
    improveBoard: null,
    now: new Date("2026-10-23T00:00:00.000Z"),
  });
  assert.equal(quietOut.code, 0, quietOut.message);
  assert.equal(quietOut.improvements.items.length, 0);
  assert.match(quietOut.improvements.note, /turned off/);
  assert.equal(quietOut.implemented, 1);
  const quietReport = readFileSync(
    join(quiet, "product", "FEATURE_REPORT.md"),
    "utf8",
  );
  assert.equal(quietReport.includes("(improvement)"), false);
});

test("handoff without an improvement file says the list is empty", () => {
  const project = join(home, "plain");
  scaffoldRebuild({
    spec: spec(),
    productName: "Harbor Kit",
    outDir: project,
    now: new Date("2026-10-23T00:00:00.000Z"),
  });
  assert.equal(existsSync(join(project, "improvements.json")), false);
  const emitted = emitHandoff({
    projectDir: project,
    verify: {
      implemented: 0,
      unimplemented: 0,
      failed: 0,
      not_run: 0,
      total: 0,
      ratio: null,
      features: [],
    },
    blastDir: join(home, "plain-handoff"),
    now: new Date("2026-10-23T00:00:00.000Z"),
  });
  const readme = readFileSync(join(emitted.directory, "README.md"), "utf8");
  assert.match(readme, /What we do better/);
  assert.match(readme, /No improvement report was saved/);
  assert.equal(existsSync(join(project, "improvements.json")), false);
});

test("pipeline help advertises the improvement flags", () => {
  const help = spawnSync(process.execPath, [cli, "pipeline", "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--improvements FILE/);
  assert.match(help.stdout, /--no-improve/);
  assert.match(help.stdout, /Nothing is invented/);
});
