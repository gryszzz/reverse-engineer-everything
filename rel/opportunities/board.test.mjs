import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLEAN_ROOM_STATEMENT,
  SCHEMA_VERSION,
  USER_AGENT,
} from "../outside-in/constants.mjs";
import {
  BOARD_SCHEMA,
  exportBoard,
  ingestScout,
  ingestSpec,
  listPicks,
  postPipelineBoard,
  writeBoard,
} from "./board.mjs";
import { exportSharedBoard, readSharedPicks } from "./shared.mjs";

const home = mkdtempSync(join(tmpdir(), "ree-board-"));
const cli = fileURLToPath(new URL("../../ree.mjs", import.meta.url));
const runId = "run_" + "ab".repeat(8);
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const findings = {
  features: [
    {
      id: "feature:shared-boards",
      name: "Shared boards",
      citation_present: true,
      citations: [],
    },
    {
      id: "feature:open-a-board",
      name: "Open a board",
      citation_present: true,
      citations: [],
    },
  ],
  endpoints: [
    {
      method: "GET",
      path: "/boards/{id}",
      operation_id: "openBoard",
      citation_present: true,
      citations: [],
    },
  ],
};

const verify = {
  features: [
    {
      id: "feature:shared-boards",
      name: "Shared boards",
      match: "pass",
      route: { method: "POST", path: "/shared-boards", success_status: 201 },
    },
    {
      id: "feature:open-a-board",
      name: "Open a board",
      match: "unimplemented",
      route: null,
    },
  ],
};

test("a pipeline board posts findings and only passing features as picks", () => {
  const board = join(home, "run", "board");
  const posted = postPipelineBoard({
    directory: board,
    runId,
    findings,
    verify,
    leftOut: [
      { id: "feature:open-a-board", reason: "path template is not expanded" },
    ],
    now: new Date("2026-10-23T02:00:00.000Z"),
  });
  assert.equal(posted.picks.length, 1);
  assert.equal(posted.picks[0].route.path, "/shared-boards");
  assert.equal(posted.picks[0].match, "pass");
  const open = posted.findings.find(
    (finding) => finding.feature_id === "feature:open-a-board",
  );
  assert.equal(open.reason, "path template is not expanded");
  assert.equal(open.match, "unimplemented");
  assert.ok(posted.findings.some((finding) => finding.kind === "endpoint"));
  postPipelineBoard({
    directory: board,
    runId,
    findings,
    verify,
    leftOut: [
      { id: "feature:open-a-board", reason: "path template is not expanded" },
    ],
    now: new Date("2026-10-23T02:00:00.000Z"),
  });
  assert.equal(readdirSync(join(board, "picks")).length, 1);
  assert.equal(readdirSync(join(board, "findings")).length, 3);
  const exported = exportBoard({
    dataDir: join(home, "run"),
    outDir: join(home, "export"),
    now: new Date("2026-10-23T02:00:00.000Z"),
  });
  assert.equal(exported.dry_run, true);
  assert.deepEqual(exported.called, {
    guard: false,
    blast: false,
    scale: false,
  });
  assert.equal(exported.requests.length, 0);
  assert.equal(
    existsSync(join(home, "export", "picks", posted.picks[0].id + ".json")),
    true,
  );
  const listed = spawnSync(
    process.execPath,
    [cli, "board", "picks", "--data", join(home, "run"), "--json"],
    { encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr + listed.stdout);
  const picks = JSON.parse(listed.stdout);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].name, "Shared boards");
  assert.deepEqual(listPicks(join(home, "run")), picks);
  const missing = spawnSync(
    process.execPath,
    [cli, "board", "export", "--data", join(home, "run")],
    { encoding: "utf8" },
  );
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /board export --data DIR --out DIR/);
});

const secretUrl =
  "https://exportuser:s3cret-token@widgets.example/path?token=tokensecretvalue&q=1";

function treeText(directory) {
  let text = "";
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) text += treeText(path);
    else text += readFileSync(path, "utf8");
  }
  return text;
}

function behaviorSpec(url) {
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
    target: { name: "Widget Cloud", urls: [url] },
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
          text: "VERBATIM_QUOTE_MARKER",
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
          method: "GET",
          path: "/boards/{id}",
          operation_id: "openBoard",
          parameters: ["id"],
          response_codes: ["200"],
          citations: [citation],
        },
      ],
      unknowns: [],
    },
    pricing: { plans: [], unknowns: [] },
    integrations: [],
    limitations: [
      {
        statement: {
          text: "LIMITATION_QUOTE_MARKER",
          attributed_quote: true,
        },
        origin: "reviews",
        citations: [citation],
      },
    ],
    changes: [],
    omitted: [],
    similarity: { threshold: 80, quote_max: 160, flagged: false, findings: [] },
    coverage: { examined_urls: [citation.url], unknowns: [] },
  };
}

test("shared export redacts URL secrets and does not invent scores", () => {
  const source = join(home, "opportunities");
  const scout = {
    target_name: "Widget Cloud",
    url: secretUrl,
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
      notes: "See " + secretUrl,
    },
    scores: {
      pain: 2,
      willingness_to_pay: 2,
      build_ease: 4,
      competitor_weakness: 2,
      reach: 2,
      total: 12,
    },
    confidence: 40,
    found_at: "2026-10-22T00:00:00.000Z",
    tracker_ref: "tracker",
  };
  ingestScout(source, scout, new Date("2026-10-23T03:00:00.000Z"));
  ingestSpec(
    source,
    behaviorSpec(secretUrl),
    new Date("2026-10-23T03:00:00.000Z"),
  );
  const stored = JSON.parse(readFileSync(join(source, "board.json"), "utf8"));
  assert.equal(stored.schema_version, BOARD_SCHEMA);
  const specItem = stored.items.find((item) => item.kind === "outside-in");
  assert.equal(specItem.record.spec_facts.features[0].name, "Shared boards");
  assert.equal(specItem.record.spec_facts.features[0].quote, undefined);
  assert.equal(
    JSON.stringify(specItem.record.spec_facts).includes(
      "VERBATIM_QUOTE_MARKER",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(specItem.record.spec_facts).includes(
      "LIMITATION_QUOTE_MARKER",
    ),
    false,
  );
  writeBoard(source, {
    ...stored,
    items: [
      ...stored.items,
      {
        id: "../escape",
        key: "bad",
        kind: "outside-in",
        ingested_at: "2026-10-23T03:00:00.000Z",
        target_name: "Escape",
        url: secretUrl,
        listing: {
          score_source: "spec-coverage",
          scores: null,
          confidence: null,
          coverage: { features: 0, limitations: 0, plans: 0, unknowns: 0 },
          note: "Outside-in specs do not include Scout market scores. Nothing was invented to fill them.",
        },
        record: { clean_room: true },
      },
    ],
  });
  const dest = join(home, "shared");
  const exported = exportSharedBoard({
    sourceDir: source,
    toDir: dest,
    now: new Date("2026-10-23T04:00:00.000Z"),
  });
  assert.equal(exported.dry_run, true);
  assert.deepEqual(exported.called, {
    guard: false,
    blast: false,
    scale: false,
  });
  assert.deepEqual(exported.skipped_ids, ["../escape"]);
  const body = treeText(dest);
  assert.equal(body.includes("s3cret-token"), false);
  assert.equal(body.includes("exportuser"), false);
  assert.equal(body.includes("tokensecretvalue"), false);
  assert.equal(body.includes("VERBATIM_QUOTE_MARKER"), false);
  assert.equal(body.includes("LIMITATION_QUOTE_MARKER"), false);
  assert.match(body, /token=REDACTED/);
  assert.match(body, /q=1/);
  const board = JSON.parse(readFileSync(join(dest, "board.json"), "utf8"));
  assert.equal(board.schema_version, "ree.shared.board.v1");
  const publishedScout = board.items.find((item) => item.kind === "scout");
  const publishedSpec = board.items.find(
    (item) => item.kind === "outside-in" && item.title === "Widget Cloud",
  );
  assert.equal(publishedScout.buildability_score, 4);
  assert.equal(publishedScout.bench_accuracy_confidence, null);
  assert.equal(publishedScout.status, "ingested");
  assert.match(publishedScout.scout_market_notes, /token=REDACTED/);
  assert.match(publishedScout.what_it_does, /Slow replies/);
  assert.equal(publishedSpec.buildability_score, null);
  assert.match(publishedSpec.what_it_does, /Shared boards/);
  assert.equal(publishedSpec.bench_accuracy_confidence, null);
  const draft = JSON.parse(
    readFileSync(
      join(dest, "findings", publishedSpec.id, "spec-draft.json"),
      "utf8",
    ),
  );
  assert.equal(draft.schema_version, "ree.shared.spec-draft.v1");
  assert.equal(draft.clean_room, true);
  assert.equal(draft.quotes_copied, false);
  assert.equal(draft.features[0].name, "Shared boards");
  assert.equal(draft.endpoints[0].path, "/boards/{id}");
  assert.equal(
    existsSync(join(dest, "findings", publishedScout.id, "report.md")),
    true,
  );
  assert.equal(existsSync(join(dest, "picks")), false);
  assert.equal(existsSync(join(dest, "export.json")), false);
  assert.equal(existsSync(join(home, "escape")), false);
  const env = { ...process.env };
  delete env.REE_SHARED_BOARD;
  const missingDir = spawnSync(process.execPath, [cli, "board", "export"], {
    encoding: "utf8",
    env,
  });
  assert.equal(missingDir.status, 2);
  assert.match(missingDir.stderr, /REE_SHARED_BOARD/);
  const viaFlag = spawnSync(
    process.execPath,
    [
      cli,
      "board",
      "export",
      "--data",
      source,
      "--to",
      join(home, "via-flag"),
      "--json",
    ],
    { encoding: "utf8", env },
  );
  assert.equal(viaFlag.status, 0, viaFlag.stderr);
  const manifest = JSON.parse(viaFlag.stdout);
  assert.equal(manifest.item_count, 3);
  assert.equal(manifest.called.guard, false);
  const keptId = "fnd_" + "ab".repeat(8);
  writeFileSync(join(dest, "findings", `${keptId}.md`), "# pipeline finding\n");
  const staleOpp = "opp_" + "ef".repeat(8);
  mkdirSync(join(dest, "findings", staleOpp), { recursive: true });
  writeFileSync(join(dest, "findings", staleOpp, "stale.txt"), "gone\n");
  const withRuns = JSON.parse(readFileSync(join(dest, "board.json"), "utf8"));
  withRuns.runs = [
    {
      schema_version: "ree.shared.run.v1",
      run_id: "run_" + "12".repeat(8),
    },
  ];
  writeFileSync(join(dest, "board.json"), JSON.stringify(withRuns) + "\n");
  exportSharedBoard({
    sourceDir: source,
    toDir: dest,
    now: new Date("2026-10-23T05:00:00.000Z"),
  });
  assert.equal(existsSync(join(dest, "findings", `${keptId}.md`)), true);
  assert.equal(existsSync(join(dest, "findings", staleOpp)), false);
  const again = JSON.parse(readFileSync(join(dest, "board.json"), "utf8"));
  assert.equal(again.runs.length, 1);
  assert.equal(again.runs[0].run_id, "run_" + "12".repeat(8));
  assert.equal(again.items.length, 3);
  assert.equal(
    existsSync(join(dest, "findings", publishedSpec.id, "report.md")),
    true,
  );
});

test("agent verdict files stay separate from pipeline picks", () => {
  const dir = join(home, "agent-picks");
  mkdirSync(join(dir, "picks"), { recursive: true });
  const verdict = {
    agent: "ada",
    id: "opp_" + "cd".repeat(8),
    verdict: "maybe",
    reason: "The stored feature is small.",
    angle: "Ship the shared board route first.",
    date: "2026-10-23T04:00:00.000Z",
    token: "s3cret-token",
  };
  writeFileSync(join(dir, "picks", "ada.json"), JSON.stringify(verdict) + "\n");
  writeFileSync(
    join(dir, "picks", "bad.json"),
    JSON.stringify({ ...verdict, verdict: "BUILD", agent: "nope" }) + "\n",
  );
  writeFileSync(
    join(dir, "picks", "pipeline.json"),
    JSON.stringify({
      schema_version: "ree.board.pick.v1",
      id: "pick_pipeline",
      name: "Shared boards",
      match: "pass",
    }) + "\n",
  );
  const read = readSharedPicks(dir);
  assert.equal(read.picks.length, 1);
  assert.equal(read.picks[0].verdict, "maybe");
  assert.equal(read.picks[0].token, undefined);
  assert.deepEqual(Object.keys(read.picks[0]).sort(), [
    "agent",
    "angle",
    "date",
    "id",
    "reason",
    "verdict",
  ]);
  assert.equal(read.rejected.length, 2);
  assert.equal(
    read.picks.some((pick) => pick.id === "pick_pipeline"),
    false,
  );
  assert.equal(listPicks(dir).length, 1);
  assert.equal(listPicks(dir)[0].schema_version, "ree.board.pick.v1");
  const env = { ...process.env, REE_SHARED_BOARD: dir };
  const listed = spawnSync(
    process.execPath,
    [cli, "board", "picks", "--json"],
    { encoding: "utf8", env },
  );
  assert.equal(listed.status, 0, listed.stderr);
  const payload = JSON.parse(listed.stdout);
  assert.equal(payload.schema_version, "ree.shared.picks.v1");
  assert.equal(payload.picks[0].verdict, "maybe");
  assert.equal(JSON.stringify(payload).includes("s3cret-token"), false);
  const from = spawnSync(
    process.execPath,
    [cli, "board", "picks", "--from", dir, "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, REE_SHARED_BOARD: "" },
    },
  );
  assert.equal(from.status, 0, from.stderr);
  assert.equal(JSON.parse(from.stdout).picks[0].agent, "ada");
  const bare = { ...process.env };
  delete bare.REE_SHARED_BOARD;
  const missing = spawnSync(process.execPath, [cli, "board", "picks"], {
    encoding: "utf8",
    env: bare,
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /REE_SHARED_BOARD/);
});
