import { execFileSync } from "node:child_process";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const repository = process.cwd();
const actionPath = join(repository, ".github/actions/npm-cache/action.yml");
const readAction = async () =>
  z
    .object({
      outputs: z.record(z.string(), z.object({ value: z.string() })),
      runs: z.object({
        steps: z.array(
          z.object({
            id: z.string().optional(),
            if: z.string().optional(),
            uses: z.string().optional(),
            with: z.record(z.string(), z.string()).optional(),
            run: z.string().optional(),
            env: z.record(z.string(), z.string()).optional(),
          }),
        ),
      }),
    })
    .parse(parse(await readFile(actionPath, "utf8")));

const readWorkflows = async () => {
  const directory = join(repository, ".github/workflows");
  const files = (await readdir(directory)).filter((file) =>
    /\.ya?ml$/u.test(file),
  );
  return Promise.all(
    files.map(async (file) => ({
      file,
      workflow: z
        .object({
          jobs: z
            .record(
              z.string(),
              z.object({
                steps: z.array(z.record(z.string(), z.unknown())).optional(),
              }),
            )
            .optional(),
        })
        .parse(parse(await readFile(join(directory, file), "utf8"))),
    })),
  );
};

describe("hosted npm download-cache policy", () => {
  it("only allows shared writes for trusted original default-branch events", async () => {
    const action = await readAction();
    const policy = action.runs.steps.find((step) => step.id === "context");
    const command = z.string().parse(policy?.run);

    const outputDirectory = await createTestTempDirectory(
      "rea-ci-cache-policy-",
    );
    const npmStub = join(outputDirectory, "npm");
    await writeFile(
      npmStub,
      String.raw`#!/bin/sh
printf '%s\n' 'C:\Users\runner with spaces\AppData\Local\npm-cache'
`,
    );
    await chmod(npmStub, 0o755);

    for (const [event, ref, defaultBranch, expected] of [
      ["push", "refs/heads/main", "main", "true"],
      ["schedule", "refs/heads/main", "main", "true"],
      ["workflow_dispatch", "refs/heads/main", "main", "true"],
      ["push", "refs/heads/stable", "stable", "true"],
      ["pull_request", "refs/heads/main", "main", "false"],
      ["pull_request_target", "refs/heads/main", "main", "false"],
      ["workflow_call", "refs/heads/main", "main", "false"],
      ["push", "refs/heads/feature/cache", "main", "false"],
      ["push", "refs/heads/main", "stable", "false"],
      ["push", "refs/heads/main", "", "false"],
    ]) {
      const outputPath = join(
        outputDirectory,
        `policy-${Date.now()}-${Math.random()}`,
      );
      execFileSync("bash", ["-euo", "pipefail", "-c", command], {
        env: {
          ...process.env,
          PATH: `${outputDirectory}${delimiter}${process.env.PATH ?? ""}`,
          GITHUB_EVENT_NAME: event,
          GITHUB_REF: ref,
          GITHUB_OUTPUT: outputPath,
          DEFAULT_BRANCH: defaultBranch,
          LOCKFILES_HASH: "lock-hash",
          RUNNER_OS: "Windows",
        },
      });
      const output = await readFile(outputPath, "utf8");
      expect(output).toContain(`can-save=${expected}\n`);
      expect(output).toContain(
        `path=${String.raw`C:\Users\runner with spaces\AppData\Local\npm-cache`}\n`,
      );
      expect(output).toContain(
        `key=npm-download-Windows-${process.arch}-lock-hash\n`,
      );
    }
  });

  it("uses a lockfile-, npmrc-, OS-, and runtime-architecture-scoped download cache", async () => {
    const action = await readAction();
    const policy = action.runs.steps.find((step) => step.id === "context");
    const restoreAndSave = action.runs.steps.find((step) =>
      step.uses?.startsWith("actions/cache@"),
    );
    const restoreOnly = action.runs.steps.find((step) =>
      step.uses?.startsWith("actions/cache/restore@"),
    );

    expect(action.outputs["can-save"]?.value).toBe(
      "${{ steps.context.outputs.can-save }}",
    );
    expect(action.outputs.path?.value).toBe(
      "${{ steps.context.outputs.path }}",
    );
    expect(policy?.env?.DEFAULT_BRANCH).toBe(
      "${{ github.event.repository.default_branch }}",
    );
    expect(policy?.env?.LOCKFILES_HASH).toBe(
      "${{ hashFiles('package-lock.json', 'npm-shrinkwrap.json', '.npmrc') }}",
    );
    expect(policy?.run).toContain(
      'cache_key="npm-download-${RUNNER_OS}-${runtime_arch}-${LOCKFILES_HASH}"',
    );
    expect(restoreAndSave?.uses).toBe(
      "actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830",
    );
    expect(restoreAndSave?.if).toBe("steps.context.outputs.can-save == 'true'");
    expect(restoreOnly?.uses).toBe(
      "actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830",
    );
    expect(restoreOnly?.if).toBe("steps.context.outputs.can-save != 'true'");
    expect(restoreAndSave?.with?.path).toBe(
      "${{ steps.context.outputs.path }}",
    );
    expect(restoreOnly?.with?.path).toBe(restoreAndSave?.with?.path);
    expect(restoreAndSave?.with?.key).toBe("${{ steps.context.outputs.key }}");
    expect(restoreOnly?.with?.key).toBe(restoreAndSave?.with?.key);
    expect(restoreAndSave?.with).not.toHaveProperty("restore-keys");
    expect(restoreOnly?.with).not.toHaveProperty("restore-keys");
  });

  it("replaces every inline setup-node npm cache immediately and preserves conditions", async () => {
    const workflows = await readWorkflows();
    let npmCacheSteps = 0;

    for (const { file, workflow } of workflows) {
      const source = await readFile(
        join(repository, ".github/workflows", file),
        "utf8",
      );
      expect(source).not.toMatch(/^\s+cache:\s*npm\s*$/mu);
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const steps = job.steps ?? [];
        for (let index = 0; index < steps.length; index++) {
          const step = steps[index];
          if (step?.uses !== "./.github/actions/npm-cache") continue;
          npmCacheSteps++;
          expect(step.id).toBe("npm-cache");
          const setup = steps[index - 1];
          expect(
            typeof setup?.uses === "string" &&
              setup.uses.startsWith("actions/setup-node@"),
            `${file}:${jobName} npm cache action must immediately follow setup-node`,
          ).toBe(true);
          expect(step.if).toBe(setup?.if);
          expect(setup?.with).not.toHaveProperty("cache", "npm");
          const npmCiIndex = steps.findIndex(
            (candidate, candidateIndex) =>
              candidateIndex > index && candidate.run === "npm ci",
          );
          expect(
            npmCiIndex,
            `${file}:${jobName} retains npm ci after cache`,
          ).toBeGreaterThan(index);
        }
      }
    }

    expect(npmCacheSteps).toBeGreaterThan(0);
  });
});

it("shares static task snapshots only after validation using the npm cache owner's write authority", async () => {
  const workflows = await readWorkflows();
  const ci = workflows.find(({ file }) => file === "ci.yml");
  const steps = ci?.workflow.jobs?.static?.steps ?? [];
  const restore = steps.find((step) => step.id === "static-cache");
  const save = steps.find(
    (step) => step.name === "Save validated static task cache",
  );
  expect(restore?.uses).toBe(
    "actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830",
  );
  expect(restore?.if).toBe("needs.changes.outputs.code == 'true'");
  expect(restore?.with).toMatchObject({ path: ".turbo/cache/" });
  expect(save?.uses).toBe(
    "actions/cache/save@0057852bfaa89a56745cba8c7296529d2fc39830",
  );
  expect(save?.if).toContain("success()");
  expect(save?.if).toContain("steps.npm-cache.outputs.can-save == 'true'");
  expect(save?.with).toEqual({
    path: ".turbo/cache/",
    key: "${{ steps.static-cache.outputs.cache-primary-key }}",
  });
  expect(steps.indexOf(save!)).toBeGreaterThan(
    steps.findIndex((step) => step.run === "npm run test:python"),
  );
});

it("bounds the rolling static snapshot with Turbo age and size eviction", async () => {
  const turbo = z
    .object({
      cacheMaxAge: z.string(),
      cacheMaxSize: z.string(),
    })
    .parse(JSON.parse(await readFile(join(repository, "turbo.json"), "utf8")));
  // The static job restores the previous snapshot by prefix and saves the
  // whole .turbo/cache directory again. Without local eviction every main
  // commit carries all historical entries into a new immutable GitHub cache,
  // growing transfers toward the 10 GB repository limit.
  expect(turbo.cacheMaxAge).toMatch(/^[1-9]\d*(s|m|h|d|w)$/u);
  expect(turbo.cacheMaxAge).not.toBe("0");
  const size = /^(\d+(?:\.\d+)?)(MB|GB|TB)$/iu.exec(turbo.cacheMaxSize);
  expect(size, "cacheMaxSize must use an explicit MB/GB/TB budget").not.toBe(
    null,
  );
  const value = Number(size?.[1] ?? "0");
  const unit = (size?.[2] ?? "MB").toUpperCase();
  const megabytes =
    unit === "TB" ? value * 1024 * 1024 : unit === "GB" ? value * 1024 : value;
  expect(megabytes).toBeGreaterThan(0);
  expect(megabytes).toBeLessThanOrEqual(1024);
});
