import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { packageRunnerRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const ompConfigurationSchema = z.object({
  mcpServers: z.object({
    rea: z.object({ command: z.string(), args: z.array(z.string()) }),
  }),
});

// Package runners set these variables for the bin they launch from a temporary cache.
for (const { runner, userAgent } of [
  { runner: "npx", userAgent: "npm/10.9.0 node/v24.11.0 linux x64" },
  { runner: "bunx", userAgent: "bun/1.4.2 npm/? node/v26.3.0 linux x64" },
] as const) {
  cliTest(
    `${runner} setup registers the pinned ${runner} launcher instead of its cache`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-package-runner-");
      const run = (arguments_: readonly string[]) =>
        cli.run({
          arguments: arguments_,
          cwd: home,
          environment: {
            HOME: home,
            USERPROFILE: home,
            npm_command: "exec",
            npm_config_user_agent: userAgent,
          },
          timeoutMs: 20_000,
        });
      const setup = await run([
        "setup",
        "--client",
        "omp",
        "--no-skill",
        "--yes",
        "--json",
      ]);
      expect(setup.exitCode).toBe(0);
      expect(setup.json).toMatchObject({ status: "ready" });
      const configuration = ompConfigurationSchema.parse(
        JSON.parse(
          await readFile(join(home, ".omp", "agent", "mcp.json"), "utf8"),
        ),
      );
      const { command, args } = configuration.mcpServers.rea;
      expect([command, ...args]).toEqual(
        packageRunnerRegistrationCommand(runner, process.platform),
      );
      const doctor = await run(["doctor", "--client", "omp", "--json"]);
      expect(doctor.json).toMatchObject({
        identity: { registrations: [{ client: "omp", state: "aligned" }] },
      });
      const repeat = await run([
        "setup",
        "--client",
        "omp",
        "--no-skill",
        "--dry-run",
        "--json",
      ]);
      expect(repeat.json).toMatchObject({ plannedActions: [] });
    },
  );
}
