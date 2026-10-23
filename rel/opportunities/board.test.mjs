import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exportBoard, listPicks, postPipelineBoard } from "./board.mjs";

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
