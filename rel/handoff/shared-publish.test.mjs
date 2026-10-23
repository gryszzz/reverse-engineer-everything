import assert from "node:assert/strict";
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
import {
  publishSharedPipeline,
  resolveSharedBoardDir,
} from "./shared-publish.mjs";

const home = mkdtempSync(join(tmpdir(), "ree-shared-publish-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const runId = "run_" + "ab".repeat(8);
const buildId = "bld_" + "cd".repeat(8);

function input(overrides = {}) {
  return {
    sharedDir: join(home, "board"),
    outDir: join(home, "out"),
    boxShared: join(home, "no-box"),
    runId,
    buildId,
    productName: "Board Desk",
    findings: {
      features: [
        {
          id: "feature:open",
          name: "Open a board",
          citation_present: true,
          citations: [
            {
              url: "https://user:s3cret-token@notes.example/docs?token=s3cret-token",
              fetched_at: "2026-10-23T00:00:00.000Z",
            },
          ],
        },
      ],
      endpoints: [],
    },
    verify: {
      features: [
        {
          id: "feature:open",
          name: "Open a board",
          match: "pass",
          route: { method: "GET", path: "/boards/{id}", success_status: 200 },
        },
      ],
    },
    approvals: { launch: true, guard: true, vault: true },
    now: new Date("2026-10-23T06:00:00.000Z"),
    ...overrides,
  };
}

test("a missing shared directory is not created", () => {
  const missing = join(home, "missing-board");
  const box = join(home, "box-board");
  assert.equal(
    resolveSharedBoardDir({
      env: { REE_SHARED_BOARD: missing },
      boxBoard: box,
    }),
    null,
  );
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(box), false);
  mkdirSync(box);
  assert.equal(resolveSharedBoardDir({ env: {}, boxBoard: box }), box);
  assert.equal(
    resolveSharedBoardDir({
      env: { REE_SHARED_BOARD: missing },
      boxBoard: box,
    }),
    null,
  );
});

test("shared publish appends a dry-run entry and redacts citation secrets", () => {
  const sharedDir = join(home, "board");
  const outDir = join(home, "out");
  const box = join(home, "box");
  mkdirSync(sharedDir);
  mkdirSync(box);
  writeFileSync(
    join(sharedDir, "board.json"),
    JSON.stringify({
      schema_version: "ree.shared.board.v1",
      items: [{ id: "opp_" + "11".repeat(8), title: "Kept" }],
      note: "already here",
    }) + "\n",
  );
  const first = publishSharedPipeline(
    input({ sharedDir, outDir, boxShared: box }),
  );
  assert.equal(first.dry_run, true);
  assert.equal(first.called.guard, false);
  assert.equal(first.called.launch, false);
  assert.equal(first.called.payment, false);
  const board = JSON.parse(readFileSync(join(sharedDir, "board.json"), "utf8"));
  assert.equal(board.items[0].title, "Kept");
  assert.equal(board.runs.length, 1);
  assert.equal(board.runs[0].schema_version, "ree.shared.run.v1");
  assert.equal(board.runs[0].dry_run, true);
  assert.equal(board.runs[0].called.blast, false);
  assert.equal(board.runs[0].launch.performed, false);
  assert.equal(board.runs[0].launch.approval_requested, true);
  assert.equal(board.runs[0].publish.performed, false);
  assert.equal(board.runs[0].payment.performed, false);
  assert.equal(board.runs[0].payment.approval_requested, true);
  const finding = board.runs[0].findings[0];
  const markdown = readFileSync(join(sharedDir, finding), "utf8");
  assert.match(markdown, /Open a board/);
  assert.equal(markdown.includes("s3cret-token"), false);
  assert.match(markdown, /token=REDACTED/);
  assert.match(markdown, /Guard was not called/);
  const guard = JSON.parse(
    readFileSync(join(sharedDir, "requests/guard.json"), "utf8"),
  );
  const blast = JSON.parse(
    readFileSync(join(sharedDir, "requests/blast.json"), "utf8"),
  );
  const scale = JSON.parse(
    readFileSync(join(sharedDir, "requests/scale.json"), "utf8"),
  );
  assert.equal(guard.schema_version, "ree.handoff.request.v1");
  assert.equal(guard.called, false);
  assert.equal(guard.dry_run, true);
  assert.equal(blast.to, "blast");
  assert.equal(blast.called, false);
  assert.equal(scale.to, "scale");
  assert.equal(scale.dry_run, true);
  const verdict = JSON.parse(
    readFileSync(join(box, "guard", "verdicts", `${buildId}.json`), "utf8"),
  );
  assert.deepEqual(verdict, guard);
  const local = JSON.parse(
    readFileSync(join(outDir, "guard", "verdicts", `${buildId}.json`), "utf8"),
  );
  assert.deepEqual(local, guard);
  assert.equal(existsSync(join(home, "guard")), false);
  publishSharedPipeline(input({ sharedDir, outDir, boxShared: box }));
  const again = JSON.parse(readFileSync(join(sharedDir, "board.json"), "utf8"));
  assert.equal(again.runs.length, 1);
  assert.equal(again.items.length, 1);
});

test("a build id that is not a safe filename is rejected", () => {
  assert.throws(
    () => publishSharedPipeline(input({ buildId: "../escape" })),
    /build id must look like bld_/,
  );
});

test("an unreadable shared board stops before a rewrite", () => {
  const sharedDir = join(home, "bad-board");
  mkdirSync(sharedDir);
  writeFileSync(join(sharedDir, "board.json"), "{");
  assert.throws(
    () =>
      publishSharedPipeline(
        input({
          sharedDir,
          outDir: join(home, "bad-out"),
          boxShared: join(home, "bad-box"),
        }),
      ),
    /could not be read/,
  );
});
