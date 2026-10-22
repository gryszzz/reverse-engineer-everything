import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { analyzeOutsideIn } from "./analyze.mjs";
import { USER_AGENT } from "./constants.mjs";
import { evaluateRobots, parseRobots } from "./robots.mjs";
import { applySimilarityGuard } from "./similarity.mjs";
import { validateBehaviorSpec } from "./validate.mjs";

const product = fileURLToPath(new URL("./fixtures/product/", import.meta.url));
const disallow = fileURLToPath(
  new URL("./fixtures/robots-disallow/", import.meta.url),
);
const limited = fileURLToPath(
  new URL("./fixtures/rate-limit/", import.meta.url),
);
const request = JSON.parse(readFileSync(join(product, "request.json"), "utf8"));
const cli = fileURLToPath(new URL("../../ree.mjs", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "ree-outside-in-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const DISTINCTIVE = [
  "DISTINCTIVE_MARKETING_SENTENCE_should_not_be_copied_42",
  "DISTINCTIVE_OPENAPI_PROSE_should_stay_out_of_the_spec_77",
  "SUPER_SECRET_SAMPLE_TOKEN_do_not_copy_9f3a",
  "DISTINCTIVE_CHANGELOG_BODY_should_not_appear_88",
  "obviously too long to quote",
  "NOT_FOLLOWED_LINK_9f3a",
  "SHOULD_NOT_FETCH_HOME",
  "SHOULD_NOT_BE_READ",
];

function clock(start = "2026-01-15T00:00:00.000Z") {
  let time = Date.parse(start);
  return {
    now: () => new Date(time),
    sleep: async (ms) => {
      time += ms;
    },
    advance(ms) {
      time += ms;
    },
  };
}

function writeFixture(dir, responses) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ responses }));
}

test("robots.txt longest match and product-token group", () => {
  const groups = parseRobots(`
User-agent: *
Disallow: /docs
Allow: /docs/public

User-agent: REE-OutsideIn
Disallow: /private
Crawl-delay: 2
`);
  const homeDecision = evaluateRobots(groups, USER_AGENT, "/");
  assert.equal(homeDecision.allowed, true);
  assert.equal(homeDecision.crawlDelaySeconds, 2);
  assert.equal(
    evaluateRobots(groups, USER_AGENT, "/private/page").allowed,
    false,
  );
  assert.equal(
    evaluateRobots(groups, USER_AGENT, "/docs/secret").allowed,
    true,
  );
  assert.equal(
    evaluateRobots(groups, "OtherBot/1.0", "/docs/public").allowed,
    true,
  );
  assert.equal(
    evaluateRobots(groups, "OtherBot/1.0", "/docs/secret").allowed,
    false,
  );
  assert.equal(evaluateRobots(parseRobots(""), USER_AGENT, "/").allowed, true);
});

test("product fixture produces a cited clean-room spec", async () => {
  const time = clock();
  const result = await analyzeOutsideIn({
    ...request,
    fixtureDir: product,
    now: time.now,
    sleep: time.sleep,
  });
  const spec = result.spec;
  assert.equal(result.exitCode, 0);
  assert.equal(spec.status, "completed");
  assert.equal(spec.clean_room, true);
  assert.equal(spec.llm.used, false);
  assert.equal(spec.llm.ree_remote_calls, "not-performed");
  assert.equal(spec.collector.headless_browser, false);
  assert.equal(spec.collector.authentication, "none");
  assert.equal(spec.similarity.flagged, false);
  assert.equal(validateBehaviorSpec(spec).ok, true);
  assert.ok(spec.features.some((feature) => feature.name === "Shared boards"));
  assert.ok(spec.features.some((feature) => feature.name === "Public API"));
  const apiFeature = spec.features.find(
    (feature) => feature.name === "Public API",
  );
  assert.equal(
    apiFeature.quote.text,
    "Automate board updates from your own tools.",
  );
  assert.equal(apiFeature.citations[0].url, "https://widgets.test/");
  assert.equal(apiFeature.citations[0].fetched_at, "2026-01-15T00:00:00.000Z");
  const workflow = spec.workflows.find(
    (item) => item.name === "Create a board",
  );
  assert.deepEqual(
    workflow.steps.map((step) => step.text),
    ["Sign up", "Name the board", "Invite a teammate"],
  );
  assert.deepEqual(spec.integrations.map((item) => item.name).sort(), [
    "GitHub",
    "Slack",
  ]);
  assert.ok(
    spec.limitations.some(
      (item) =>
        item.origin === "stated-limitation" &&
        item.statement.text === "No offline mode",
    ),
  );
  assert.ok(
    spec.limitations.some(
      (item) =>
        item.origin === "stated-review" &&
        item.statement.text === "Export cannot handle boards over 100 items.",
    ),
  );
  const free = spec.pricing.plans.find((plan) => plan.name === "Free");
  const pro = spec.pricing.plans.find((plan) => plan.name === "Pro");
  assert.equal(free.price.amount, "0");
  assert.equal(pro.price.amount, "20");
  assert.equal(pro.price.interval, "month");
  assert.ok(free.limits.includes("100 requests/day"));
  assert.ok(pro.limits.includes("10,000 requests/day"));
  assert.ok(pro.includes.includes("Email support"));
  assert.equal(free.citations[0].url, "https://widgets.test/pricing");
  assert.equal(spec.api.style, "mixed");
  const list = spec.api.endpoints.find(
    (endpoint) => endpoint.operation_id === "listWidgets",
  );
  assert.equal(list.method, "GET");
  assert.equal(list.path, "/v1/widgets");
  assert.deepEqual(list.parameters, ["limit"]);
  assert.ok(list.response_codes.includes("429"));
  assert.equal(list.citations[0].url, "https://widgets.test/openapi.yaml");
  assert.ok(spec.api.auth.some((auth) => auth.style === "bearer"));
  assert.ok(
    spec.api.rate_limits.some(
      (limit) => limit.limit === "100" && limit.window === "minute",
    ),
  );
  assert.ok(
    spec.api.endpoints.some((endpoint) => endpoint.operation_id === "widget"),
  );
  assert.ok(
    spec.api.endpoints.some(
      (endpoint) => endpoint.operation_id === "createWidget",
    ),
  );
  assert.ok(
    spec.api.servers.some(
      (server) => server.url === "https://api.widgets.test",
    ),
  );
  assert.ok(spec.features.some((feature) => feature.origin === "sdk-readme"));
  assert.equal(spec.omitted[0].kind, "fenced-code");
  assert.equal(spec.changes[0].title.text, "Added bulk export");
  assert.equal(spec.changes[0].published_at, "2025-10-01T00:00:00.000Z");
  const packed = JSON.stringify(spec) + result.report;
  for (const marker of DISTINCTIVE)
    assert.equal(packed.includes(marker), false, marker);
  assert.equal(
    result.fixtureReads.includes("https://widgets.test/secret"),
    false,
  );
  assert.equal(
    result.fixtureReads.some((url) => url.includes("api.widgets.test")),
    false,
  );
  assert.ok(
    result.fetches.every((item) => item.headers["user-agent"] === USER_AGENT),
  );
  assert.ok(
    result.fetches.every(
      (item) =>
        !("authorization" in item.headers) && !("cookie" in item.headers),
    ),
  );
  assert.match(result.report, /source: https:\/\/widgets\.test\//);
});

test("robots disallow refuses the target before the page is read", async () => {
  const time = clock();
  const result = await analyzeOutsideIn({
    target: { name: "Blocked", urls: ["https://blocked.test/"] },
    fixtureDir: disallow,
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.spec.status, "refused");
  assert.equal(result.spec.clean_room, true);
  assert.equal(result.spec.refusals[0].reason, "robots-disallow");
  assert.deepEqual(result.fixtureReads, ["https://blocked.test/robots.txt"]);
  assert.equal(
    JSON.stringify(result.spec).includes("SHOULD_NOT_FETCH_HOME"),
    false,
  );
  assert.equal(validateBehaviorSpec(result.spec).ok, true);
});

test("HTTP 429 stops the host and does not read later URLs", async () => {
  const time = clock();
  const result = await analyzeOutsideIn({
    target: { name: "Limited", urls: ["https://limited.test/"] },
    docs: [{ url: "https://limited.test/docs" }],
    fixtureDir: limited,
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(result.exitCode, 3);
  assert.ok(
    result.spec.refusals.some((refusal) => refusal.reason === "rate-limit"),
  );
  assert.equal(
    result.fixtureReads.includes("https://limited.test/docs"),
    false,
  );
  assert.equal(
    JSON.stringify(result.spec).includes("SHOULD_NOT_BE_READ"),
    false,
  );
  assert.match(result.spec.refusals[0].detail, /Retry-After/);
});

test("crawl-delay waits between requests on one host", async () => {
  const dir = join(home, "crawl");
  writeFixture(dir, {
    "https://slow.test/robots.txt": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "User-agent: *\nCrawl-delay: 2\nAllow: /\n",
    },
    "https://slow.test/": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<h2>Features</h2><h3>Boards</h3>",
    },
    "https://slow.test/pricing": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<h2>Pricing</h2><h3>Free</h3><p>$0</p>",
    },
  });
  const waits = [];
  let time = Date.parse("2026-01-15T00:00:00.000Z");
  const result = await analyzeOutsideIn({
    target: { name: "Slow", urls: ["https://slow.test/"] },
    pricingUrl: "https://slow.test/pricing",
    fixtureDir: dir,
    now: () => new Date(time),
    sleep: async (ms) => {
      waits.push(ms);
      time += ms;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.ok(waits.some((ms) => ms >= 2000));
});

test("similarity guard redacts long verbatim text and keeps short quotes", () => {
  const passage =
    "This is a long verbatim passage that the guard must catch because it was copied from the public page into the spec.";
  const spec = {
    features: [{ summary: `intro ${passage} outro` }],
    limitations: [
      { statement: { text: "No offline mode", attributed_quote: true } },
    ],
  };
  const findings = applySimilarityGuard(spec, [
    { url: "https://widgets.test/", body: passage },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(spec.features[0].summary, "[redacted similar passage]");
  assert.equal(spec.limitations[0].statement.text, "No offline mode");
  assert.equal(JSON.stringify(findings).includes(passage), false);
});

test("missing robots.txt allows the page and a robots failure stays closed", async () => {
  const open = join(home, "robots-404");
  writeFixture(open, {
    "https://open.test/robots.txt": {
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "missing",
    },
    "https://open.test/": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<h2>Features</h2><h3>Boards</h3>",
    },
  });
  const opened = await analyzeOutsideIn({
    target: { name: "Open", urls: ["https://open.test/"] },
    fixtureDir: open,
    ...clock(),
  });
  assert.equal(opened.spec.status, "completed");
  assert.ok(opened.spec.features.some((feature) => feature.name === "Boards"));

  const closed = join(home, "robots-500");
  writeFixture(closed, {
    "https://closed.test/robots.txt": {
      status: 500,
      headers: { "content-type": "text/plain" },
      body: "down",
    },
    "https://closed.test/": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<h2>Features</h2><h3>Hidden</h3>",
    },
  });
  const refused = await analyzeOutsideIn({
    target: { name: "Closed", urls: ["https://closed.test/"] },
    fixtureDir: closed,
    ...clock(),
  });
  assert.equal(refused.spec.refusals[0].reason, "robots-unavailable");
  assert.equal(refused.fixtureReads.includes("https://closed.test/"), false);
});

test("auth, captcha, binaries, and private hosts are refused", async () => {
  const dir = join(home, "refuse");
  writeFixture(dir, {
    "https://wall.test/robots.txt": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "User-agent: *\nAllow: /\n",
    },
    "https://wall.test/login": {
      status: 401,
      headers: { "content-type": "text/html" },
      body: "sign in",
    },
    "https://wall.test/captcha": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<div class="g-recaptcha"></div><h2>Features</h2>',
    },
    "https://wall.test/app": {
      status: 200,
      headers: { "content-type": "application/javascript" },
      body: "function superSecretSource(){return 1}",
    },
  });
  const time = clock();
  const auth = await analyzeOutsideIn({
    target: { name: "Wall", urls: ["https://wall.test/login"] },
    fixtureDir: dir,
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(auth.spec.refusals[0].reason, "auth-required");
  const captcha = await analyzeOutsideIn({
    target: { name: "Wall", urls: ["https://wall.test/captcha"] },
    fixtureDir: dir,
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(captcha.spec.refusals[0].reason, "captcha");
  assert.equal(JSON.stringify(captcha.spec).includes("Features"), false);
  const source = await analyzeOutsideIn({
    target: { name: "Wall", urls: ["https://wall.test/app"] },
    fixtureDir: dir,
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(source.spec.refusals[0].reason, "source-or-binary");
  assert.equal(
    JSON.stringify(source.spec).includes("superSecretSource"),
    false,
  );
  const binary = await analyzeOutsideIn({
    target: { name: "Wall", urls: ["https://wall.test/app.exe"] },
    fixtureDir: dir,
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(binary.spec.refusals[0].reason, "source-or-binary");
  assert.equal(binary.fixtureReads.length, 0);
  const local = await analyzeOutsideIn({
    target: { name: "Local", urls: ["http://127.0.0.1/secret"] },
    fixtureDir: dir,
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(local.spec.refusals[0].reason, "private-host");
  const creds = await analyzeOutsideIn({
    target: { name: "Creds", urls: ["https://user:pass@wall.test/"] },
    fixtureDir: dir,
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(creds.spec.refusals[0].reason, "credentials-in-url");
  assert.equal(creds.spec.refusals[0].url.includes("user"), false);
});

test("cache reuses the first fetch time and skips fixture reads", async () => {
  const cacheDir = join(home, "cache");
  const time = clock();
  const first = await analyzeOutsideIn({
    target: { name: "Widget Cloud", urls: ["https://widgets.test/"] },
    fixtureDir: product,
    cacheDir,
    now: time.now,
    sleep: time.sleep,
  });
  const fetchedAt = first.spec.sources[0].fetched_at;
  assert.equal(first.spec.sources[0].cache.hit, false);
  time.advance(60_000);
  const second = await analyzeOutsideIn({
    target: { name: "Widget Cloud", urls: ["https://widgets.test/"] },
    fixtureDir: product,
    cacheDir,
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(second.fixtureReads.length, 0);
  assert.ok(second.spec.sources.every((source) => source.cache.hit));
  assert.equal(second.spec.sources[0].fetched_at, fetchedAt);
  assert.equal(validateBehaviorSpec(second.spec).ok, true);
});

test("deterministic extraction ignores a failing summarizer and accepts a local one", async () => {
  const time = clock();
  const failed = await analyzeOutsideIn({
    target: { name: "Widget Cloud", urls: ["https://widgets.test/"] },
    fixtureDir: product,
    now: time.now,
    sleep: time.sleep,
    summarizer: {
      id: "local-test",
      summarize() {
        throw new Error("offline");
      },
    },
  });
  assert.equal(failed.spec.llm.used, false);
  assert.equal(failed.spec.llm.error, "summarizer-failed");
  assert.ok(failed.spec.features.length > 0);
  const summarized = await analyzeOutsideIn({
    target: { name: "Widget Cloud", urls: ["https://widgets.test/"] },
    fixtureDir: product,
    now: time.now,
    sleep: time.sleep,
    summarizer: {
      id: "local-test",
      async summarize() {
        return {
          text: "Widget Cloud documents boards, an API, and published plans.",
        };
      },
    },
  });
  assert.equal(summarized.spec.llm.used, true);
  assert.equal(summarized.spec.llm.provider, "local-test");
  assert.equal(summarized.spec.llm.ree_remote_calls, "not-performed");
  assert.match(summarized.spec.llm.summary, /published plans/);
  await assert.rejects(
    () =>
      analyzeOutsideIn({
        target: { name: "Widget Cloud", urls: ["https://widgets.test/"] },
        fixtureDir: product,
        fetchImpl: async () => {
          throw new Error("network");
        },
        summarizerChoice: "remote",
      }),
    /Remote model calls are refused/,
  );
});

test("output and cache directories inside the repository are refused", async () => {
  const inside = fileURLToPath(
    new URL("./fixtures/product/out", import.meta.url),
  );
  await assert.rejects(
    () =>
      analyzeOutsideIn({
        target: { name: "Widget Cloud", urls: ["https://widgets.test/"] },
        fixtureDir: product,
        outDir: inside,
      }),
    /outside the REE repository/,
  );
});

test("schema validation rejects a spec that drops the clean-room flag", () => {
  const invalid = validateBehaviorSpec({
    schema_version: "ree.outside-in.behavior-spec.v1",
  });
  assert.equal(invalid.ok, false);
});

test("CLI writes the spec and JSON for BLAST", () => {
  const out = join(home, "cli-out");
  const cache = join(home, "cli-cache");
  const run = spawnSync(
    process.execPath,
    [
      cli,
      "outside-in",
      "--request",
      join(product, "request.json"),
      "--fixture",
      product,
      "--out",
      out,
      "--cache",
      cache,
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const spec = JSON.parse(run.stdout);
  assert.equal(spec.schema_version, "ree.outside-in.behavior-spec.v1");
  assert.equal(spec.clean_room, true);
  assert.equal(validateBehaviorSpec(spec).ok, true);
  assert.equal(
    readFileSync(join(out, "behavior-spec.json"), "utf8").includes(
      spec.target.name,
    ),
    true,
  );
  assert.match(
    readFileSync(join(out, "OUTSIDE_IN_REPORT.md"), "utf8"),
    /Clean room: yes/,
  );
  const refused = spawnSync(
    process.execPath,
    [
      cli,
      "outside-in",
      "--request",
      join(disallow, "request.json"),
      "--fixture",
      disallow,
      "--out",
      join(home, "refused-out"),
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(refused.status, 3);
  assert.equal(JSON.parse(refused.stdout).status, "refused");
  const remote = spawnSync(
    process.execPath,
    [
      cli,
      "outside-in",
      "--name",
      "X",
      "--url",
      "https://widgets.test/",
      "--summarizer",
      "remote",
    ],
    { encoding: "utf8" },
  );
  assert.equal(remote.status, 2);
  assert.match(remote.stderr, /Remote model calls are refused/);
});

test("inspect stays preview-only and outside-in is documented", () => {
  const help = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /outside-in/);
  const preview = spawnSync(
    process.execPath,
    [cli, "inspect", "https://example.com", "--json"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(preview.status, 0);
  assert.equal(JSON.parse(preview.stdout).execution, "preview-only");
  const run = spawnSync(
    process.execPath,
    [cli, "inspect", "https://example.com", "--run"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Analysis execution is only enabled/);
});
