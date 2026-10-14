import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import {
  parseStaticTaskContext,
  recordStaticTaskContext,
} from "../../../scripts/ci/static-task-context.mjs";
import { createGhApiRequest } from "../../../scripts/ci/github-api.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const scopeFlags = async () =>
  z
    .object({ CI_FLAGS: z.array(z.string()) })
    .parse(
      await import(
        new URL("../../../scripts/ci/scopes.mjs", import.meta.url).href
      ),
    ).CI_FLAGS;
const workflow = async () =>
  z
    .object({
      jobs: z.record(
        z.string(),
        z
          .object({
            needs: z.union([z.string(), z.array(z.string())]).optional(),
            if: z.string().optional(),
            steps: z
              .array(
                z
                  .object({
                    run: z.string().optional(),
                    env: z.record(z.string(), z.string()).optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      ),
    })
    .parse(
      parse(
        await readFile(
          new URL("../../../.github/workflows/ci.yml", import.meta.url),
          "utf8",
        ),
      ),
    ).jobs;

it("starts source feedback before build and requires both groups without waiving missing jobs", async () => {
  const jobs = await workflow();
  expect(
    jobs.static?.steps?.find(
      (step) => step.run === "npm run ci:static-context",
    )?.["continue-on-error"],
  ).toBe(true);
  expect(jobs["test-source"]?.needs).toBe("changes");
  expect(jobs["test-shard"]?.needs).toEqual(["changes", "build"]);
  expect(
    jobs["test-source"]?.steps?.some(
      (step) =>
        step.run === "npm run test:fast -- --reporter=default --reporter=blob",
    ),
  ).toBe(true);
  const required = fileURLToPath(
    new URL("../../../scripts/ci/required.mjs", import.meta.url),
  );
  const flags = await scopeFlags();
  for (const tier of ["fast", "full"]) {
    for (const result of [
      "success",
      "failure",
      "cancelled",
      "skipped",
      "missing",
    ]) {
      const needs = Object.fromEntries(
        Object.keys(jobs)
          .filter((name) => name !== "required")
          .map((name) => [name, { result: "success" }]),
      );
      const outputs = {
        ...Object.fromEntries(
          flags.map((flag) => [flag, tier === "full" ? "true" : "false"]),
        ),
        tier,
        code: "true",
      };
      const context: Record<
        string,
        { result: string; outputs?: Record<string, string> }
      > = { ...needs, changes: { result: "success", outputs } };
      if (result === "missing") delete context["test-source"];
      else context["test-source"] = { result };
      const run = execute(process.execPath, [required], {
        env: {
          ...process.env,
          CI_JOBS: JSON.stringify(context),
          CI_QUALIFICATION_DIRECTORY: "",
        },
      });
      if (
        result === "success" ||
        (tier === "full" && ["skipped", "missing"].includes(result))
      )
        await expect(run).resolves.toMatchObject({ stderr: "" });
      else
        await expect(run).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining("test-source"),
        });
    }
  }
});

it("records the actual static task graph with explicit source identity and no ambient environment", async () => {
  const directory = await createTestTempDirectory("rea-ci-context-");
  const context = await recordStaticTaskContext({ outputDirectory: directory });
  const head = await execute("git", ["rev-parse", "HEAD"]);
  expect(context.sourceSha).toBe(head.stdout.trim());
  expect(context.taskHashes["lint:built"]).toMatch(/^[a-f0-9]{16}$/u);
  expect(context.taskHashes.jscpd).toMatch(/^[a-f0-9]{16}$/u);
  expect(context).not.toHaveProperty("environmentVariables");
  expect(context).not.toHaveProperty("env");
  expect(
    JSON.parse(await readFile(`${directory}/static-task-context.json`, "utf8")),
  ).toEqual(context);
  for (const invalid of [
    undefined,
    {},
    { ...context, sourceSha: "bad" },
    { ...context, prHeadSha: "bad" },
    { ...context, taskHashes: { jscpd: "stale" } },
  ])
    expect(() => parseStaticTaskContext(invalid)).toThrow();
});

it("rejects mutation methods at the shared GitHub transport before invoking the CLI", async () => {
  const request = createGhApiRequest({ env: { PATH: "" } });
  await expect(
    request("POST", "repos/owner/repo/actions/runs/1/rerun", {
      requests: 0,
      startedAt: Date.now(),
      limitMs: 1000,
    }),
  ).rejects.toThrow("read-only GET");
});

it("collects basic CI telemetry before optional dependency installation can fail", async () => {
  const { jobs } = z
    .object({
      jobs: z.object({
        report: z.object({
          steps: z.array(
            z.object({
              id: z.string().optional(),
              run: z.string().optional(),
              if: z.string().optional(),
              "continue-on-error": z.boolean().optional(),
            }),
          ),
        }),
      }),
    })
    .parse(
      parse(
        await readFile(
          new URL("../../../.github/workflows/ci-timings.yml", import.meta.url),
          "utf8",
        ),
      ),
    );
  const steps = jobs.report.steps;
  const installation = steps.findIndex((step) => step.id === "failure-deps");
  for (const script of ["pr-ci-health.mjs", "job-timings-batch.mjs"]) {
    const collection = steps.findIndex(
      (step) => step.run === `node scripts/ci/${script}`,
    );
    expect(collection).toBeGreaterThanOrEqual(0);
    expect(installation).toBeGreaterThan(collection);
  }
  expect(steps[installation]).toMatchObject({
    run: "npm ci",
    "continue-on-error": true,
  });
  expect(
    steps.find((step) => step.id === "npm-cache")?.["continue-on-error"],
  ).toBe(true);
  expect(
    steps.find((step) => step.run === "node scripts/ci/failure-report.mjs")?.if,
  ).toContain("steps.failure-deps.outcome == 'success'");
});

it("merges source and built reports exactly once using the workflow's shard matrix", async () => {
  const jobs = await workflow();
  const matrix = z
    .object({
      matrix: z.object({ shard: z.string().regex(/^\$\{\{.*\}\}$/u) }),
    })
    .parse(jobs["test-shard"]?.strategy).matrix.shard;
  const shards = z
    .array(z.string().regex(/^\d+\/\d+$/u))
    .min(1)
    .parse(
      runInNewContext(
        matrix.slice(3, -2),
        {
          fromJSON: JSON.parse,
          needs: { changes: { outputs: { tier: "fast" } } },
        },
        { timeout: 1_000 },
      ),
    );
  const labels = Object.fromEntries(
    ["source", "built"].map((group) => [
      group,
      z
        .string()
        .min(1)
        .parse(
          jobs[group === "source" ? "test-source" : "test-shard"]?.steps?.find(
            (step) => step.env?.VITEST_BLOB_LABEL,
          )?.env?.VITEST_BLOB_LABEL,
        ),
    ]),
  );
  const root = await createTestTempDirectory("rea-ci-group-merge-");
  const config = join(root, "vitest.config.mjs");
  await writeFile(
    config,
    `export default { test: { maxWorkers: 1, projects: [${["source", "built"].map((name) => `{ test: { name: "${name}", globals: true, include: ["${name}*.test.js"] } }`).join(",")}] } };`,
  );
  const files = [
    "source.test.js",
    ...Array.from(
      { length: shards.length },
      (_, index) => `built-${index}.test.js`,
    ),
  ];
  for (const file of files)
    await writeFile(
      join(root, file),
      'it("runs its selected group", () => expect(true).toBe(true));',
    );
  const vitest = fileURLToPath(
    new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
  );
  const blobs = new Map<string, Buffer>();
  const runs = [
    { group: "source", shard: [] },
    ...shards.map((shard) => ({ group: "built", shard: [`--shard=${shard}`] })),
  ];
  for (const { group, shard } of runs) {
    await execute(
      process.execPath,
      [
        vitest,
        "run",
        "--config",
        config,
        "--project",
        group,
        "--reporter=blob",
        ...shard,
      ],
      {
        cwd: root,
        env: { ...process.env, VITEST_BLOB_LABEL: labels[group]! },
        timeout: 20_000,
      },
    );
    for (const filename of await readdir(join(root, ".vitest/blob"))) {
      expect(blobs.has(filename)).toBe(false);
      blobs.set(filename, await readFile(join(root, ".vitest/blob", filename)));
    }
    // Separate hosted jobs start with independent report directories.
    await rm(join(root, ".vitest/blob"), { recursive: true });
  }
  expect(blobs.size).toBe(runs.length);
  await mkdir(join(root, ".vitest/blob"), { recursive: true });
  for (const [filename, bytes] of blobs)
    await writeFile(join(root, ".vitest/blob", filename), bytes);
  await execute(
    process.execPath,
    [
      vitest,
      "--config",
      config,
      "--merge-reports",
      "--reporter=json",
      "--outputFile.json=merged.json",
    ],
    { cwd: root, timeout: 20_000 },
  );
  const merged = z
    .object({
      success: z.literal(true),
      testResults: z.array(z.object({ name: z.string() })),
    })
    .parse(JSON.parse(await readFile(join(root, "merged.json"), "utf8")));
  expect(
    merged.testResults.map(({ name }) => name.split("/").at(-1)).sort(),
  ).toEqual(files.toSorted());
});
