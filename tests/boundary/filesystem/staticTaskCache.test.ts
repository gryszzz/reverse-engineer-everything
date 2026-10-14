import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { workflowGit } from "../../support/workflowGit.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const turbo = join(repository, "node_modules/turbo/bin/turbo");
const reportScript = join(repository, "scripts/ci/static-check-report.mjs");
const rootConfigSchema = z.object({
  globalDependencies: z.array(z.string()).optional(),
  globalPassThroughEnv: z.array(z.string()).optional(),
  tasks: z.record(z.string(), z.record(z.string(), z.unknown())),
});
const dryRunSchema = z.object({
  tasks: z.array(z.object({ taskId: z.string(), hash: z.string() })),
});

const execute = (command: string, args: string[], cwd: string) =>
  spawnSync(process.execPath, [command, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });

const readRootConfig = async () =>
  rootConfigSchema.parse(
    JSON.parse(await readFile(join(repository, "turbo.json"), "utf8")),
  );

const writeTaskFixture = async (
  root: string,
  taskNames: string[],
  scripts: Record<string, string>,
) => {
  const config = await readRootConfig();
  const tasks = Object.fromEntries(
    taskNames.map((name) => {
      const task = config.tasks[name];
      if (task === undefined) throw new Error(`Missing Turbo task ${name}`);
      // These tests measure a task's own inputs. Drop dependency edges so the
      // unrelated compile task cannot add fixture-specific inputs or outputs.
      const { dependsOn: _dependsOn, ...definition } = task;
      return [name, definition];
    }),
  );
  await writeFile(
    join(root, "turbo.json"),
    JSON.stringify(
      {
        ...(config.globalDependencies === undefined
          ? {}
          : { globalDependencies: config.globalDependencies }),
        ...(config.globalPassThroughEnv === undefined
          ? {}
          : { globalPassThroughEnv: config.globalPassThroughEnv }),
        tasks,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "rea-static-task-cache-fixture",
      version: "1.0.0",
      private: true,
      packageManager: "npm@11.16.0",
      scripts,
    }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "rea-static-task-cache-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "rea-static-task-cache-fixture", version: "1.0.0" },
      },
    }),
  );
};

const runTurbo = (
  root: string,
  task: string,
  cacheDirectory: string,
  dryRun = false,
) =>
  execute(
    turbo,
    [
      "run",
      task,
      ...(dryRun ? ["--dry=json"] : ["--output-logs=errors-only"]),
      "--cache=local:rw,remote:r",
      "--cache-dir",
      cacheDirectory,
    ],
    root,
  );

const taskHash = (root: string, task: string, cacheDirectory: string) => {
  const result = runTurbo(root, task, cacheDirectory, true);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const { tasks } = dryRunSchema.parse(JSON.parse(result.stdout));
  const entry = tasks.find(({ taskId }) => taskId === task);
  if (entry === undefined) throw new Error(`Turbo omitted task ${task}`);
  return entry.hash;
};

it("restores a real lint report across cold, warm, and fresh consumer checkouts", async () => {
  const producer = await createTestTempDirectory("rea-static-cache-producer-");
  const consumer = await createTestTempDirectory("rea-static-cache-consumer-");
  const cache = await createTestTempDirectory("rea-static-cache-store-");
  const script = "node scripts/ci/static-check-report.mjs lint";
  for (const root of [producer, consumer]) {
    await mkdir(join(root, "scripts/ci"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await symlink(
      join(repository, "node_modules"),
      join(root, "node_modules"),
      "junction",
    );
    await writeTaskFixture(root, ["lint"], { lint: script });
    await writeFile(
      join(root, ".nvmrc"),
      await readFile(join(repository, ".nvmrc")),
    );
    await writeFile(join(root, ".gitignore"), ".cache/\nnode_modules/\n");
    await writeFile(
      join(root, ".oxlintrc.json"),
      JSON.stringify({ rules: { "no-debugger": "error" } }),
    );
    await writeFile(join(root, "src/check.js"), "export const ready = true;\n");
    await writeFile(
      join(root, "scripts/ci/static-check-report.mjs"),
      await readFile(reportScript, "utf8"),
    );
    await workflowGit(root, ["init", "--initial-branch=main"]);
    await workflowGit(root, ["add", "."]);
    await workflowGit(root, ["commit", "-m", "test: seed static task cache"]);
  }

  const cold = runTurbo(producer, "lint", cache);
  expect(cold.error).toBeUndefined();
  expect(cold.status, cold.stderr).toBe(0);
  expect(cold.stdout).toMatch(/Cached:\s+0 cached/u);
  const report = join(producer, ".cache/static-checks/oxlint.json");
  const cleanReport = await readFile(report, "utf8");

  await rm(join(producer, ".cache"), { recursive: true });
  const warm = runTurbo(producer, "lint", cache);
  expect(warm.error).toBeUndefined();
  expect(warm.status, warm.stderr).toBe(0);
  expect(warm.stdout).toMatch(/Cached:\s+1 cached/u);
  expect(await readFile(report, "utf8")).toBe(cleanReport);

  const freshConsumer = runTurbo(consumer, "lint", cache);
  expect(freshConsumer.error).toBeUndefined();
  expect(freshConsumer.status, freshConsumer.stderr).toBe(0);
  expect(freshConsumer.stdout).toMatch(/Cached:\s+1 cached/u);
  expect(
    await readFile(join(consumer, ".cache/static-checks/oxlint.json"), "utf8"),
  ).toBe(cleanReport);

  await writeFile(join(consumer, "src/check.js"), "debugger;\n");
  const invalid = runTurbo(consumer, "lint", cache);
  expect(invalid.error).toBeUndefined();
  expect(invalid.status).not.toBe(0);
  expect(invalid.stdout).toMatch(/Cached:\s+0 cached/u);
  const { diagnostics } = z
    .object({
      diagnostics: z.array(
        z.object({ code: z.string().optional(), severity: z.string() }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          join(consumer, ".cache/static-checks/oxlint.json"),
          "utf8",
        ),
      ),
    );
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      code: "eslint(no-debugger)",
      severity: "error",
    }),
  );
});

it("invalidates checker task hashes for Node, ignore, and VitePress config changes", async () => {
  const root = await createTestTempDirectory("rea-static-cache-inputs-");
  const cache = await createTestTempDirectory("rea-static-cache-hashes-");
  await mkdir(join(root, "docs/.vitepress"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeTaskFixture(
    root,
    ["jscpd", "knip", "metadata:check", "scan:todos"],
    // This fixture probes only Turbo's real task hash; the checker commands
    // are intentionally inert so the hash test cannot invoke large suites.
    {
      jscpd: 'node -e "process.exit(0)"',
      knip: 'node -e "process.exit(0)"',
      "metadata:check": 'node -e "process.exit(0)"',
      "scan:todos": 'node -e "process.exit(0)"',
    },
  );
  await writeFile(join(root, ".nvmrc"), "24.18.0\n");
  await writeFile(join(root, ".npmrc"), "engine-strict=true\n");
  await writeFile(join(root, ".gitignore"), ".cache/\n");
  await writeFile(join(root, ".jscpd.json"), "{}\n");
  await writeFile(join(root, "docs/.vitepress/config.ts"), "export {};\n");
  await writeFile(
    join(root, "vitest.config.ts"),
    'import { CiTestSequencer } from "./tests/ciTestSequencer.js";\nexport const sequencer = CiTestSequencer;\n',
  );
  await writeFile(join(root, "src/input.ts"), "export {};\n");
  await writeFile(join(root, "tests/input.ts"), "export {};\n");

  const initial = new Map<string, string>();
  for (const task of ["jscpd", "knip", "metadata:check", "scan:todos"])
    initial.set(task, taskHash(root, task, cache));

  await writeFile(join(root, ".nvmrc"), "24.19.0\n");
  for (const task of ["jscpd", "metadata:check", "scan:todos"])
    expect(
      taskHash(root, task, cache),
      `${task} must hash the Node pin`,
    ).not.toBe(initial.get(task));
  await writeFile(join(root, ".nvmrc"), "24.18.0\n");

  await writeFile(join(root, ".npmrc"), "engine-strict=false\n");
  for (const task of ["jscpd", "knip", "metadata:check", "scan:todos"])
    expect(
      taskHash(root, task, cache),
      `${task} must hash npm settings`,
    ).not.toBe(initial.get(task));
  await writeFile(join(root, ".npmrc"), "engine-strict=true\n");
  for (const task of ["jscpd", "metadata:check", "scan:todos"])
    expect(taskHash(root, task, cache), `${task} restores after Node pin`).toBe(
      initial.get(task),
    );

  await writeFile(join(root, ".gitignore"), ".cache/\ncoverage/\n");
  for (const task of ["jscpd", "knip"])
    expect(taskHash(root, task, cache), `${task} must hash gitignore`).not.toBe(
      initial.get(task),
    );
  await writeFile(join(root, ".gitignore"), ".cache/\n");
  for (const task of ["jscpd", "knip"])
    expect(
      taskHash(root, task, cache),
      `${task} restores after gitignore`,
    ).toBe(initial.get(task));

  await writeFile(
    join(root, "docs/.vitepress/config.ts"),
    "export const configRevision = 2;\n",
  );
  expect(
    taskHash(root, "knip", cache),
    "knip must hash its configured VitePress entry",
  ).not.toBe(initial.get("knip"));
  await writeFile(join(root, "docs/.vitepress/config.ts"), "export {};\n");

  await writeFile(join(root, "vitest.config.ts"), "export {};\n");
  expect(
    taskHash(root, "knip", cache),
    "knip must hash vitest.config.ts so unused sequencer imports invalidate the cache",
  ).not.toBe(initial.get("knip"));
  for (const task of ["jscpd", "metadata:check", "scan:todos"])
    expect(
      taskHash(root, task, cache),
      `${task} must ignore vitest.config.ts`,
    ).toBe(initial.get(task));
});
