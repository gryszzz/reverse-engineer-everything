import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "skill-only setup verifies its selected client copy on install, rerun and repair",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-selected-skill-");
    const selected = join(
      directory,
      ".claude/skills/reverse-engineer-anything",
    );
    const shared = join(directory, ".agents/skills/reverse-engineer-anything");
    const run = (args: readonly string[]) =>
      cli.run({
        arguments: [...args, "--json"],
        cwd: directory,
        environment: { USERPROFILE: directory },
      });
    const preview = await run([
      "setup",
      "--skill-client",
      "claude_code",
      "--dry-run",
    ]);
    expect(preview.exitCode, preview.stdout).toBe(0);
    expect(preview.json).toMatchObject({
      status: "planned",
      doctor: {
        scope: {
          clients: [],
          skill: true,
          skill_clients: ["claude_code"],
        },
      },
    });
    const registered = await run([
      "setup",
      "--client",
      "claude_code",
      "--skill=false",
      "--yes",
    ]);
    expect(registered.exitCode, registered.stderr).toBe(0);
    const configuration = join(directory, ".claude.json");
    const before = await readFile(configuration, "utf8");
    const args = ["setup", "--skill-client", "claude_code", "--yes"];
    const installed = await run(args);
    expect(installed.exitCode, installed.stdout).toBe(0);
    expect(installed.json).toMatchObject({
      status: "ready",
      appliedActions: ["installed_skill"],
      doctor: {
        healthy: true,
        scope: { clients: [], skill: true, skill_clients: ["claude_code"] },
        identity: { skill: { state: "aligned" } },
      },
    });
    const bundle = resolve("skills/reverse-engineer-anything");
    const assertAligned = async () => {
      for (const entry of await readdir(bundle, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile()) continue;
        const path = relative(bundle, join(entry.parentPath, entry.name));
        expect(await readFile(join(selected, path))).toEqual(
          await readFile(join(bundle, path)),
        );
      }
    };
    await assertAligned();
    const repeated = await run(args);
    expect(repeated.exitCode, repeated.stdout).toBe(0);
    expect(repeated.json).toMatchObject({
      status: "ready",
      appliedActions: [],
    });

    await writeFile(
      join(selected, "references/native-and-artifacts.md"),
      "damaged selected copy\n",
    );
    const damaged = await run(["doctor", "--client", "claude_code", "--skill"]);
    expect(damaged.json).toMatchObject({
      healthy: false,
      identity: { skill: { state: "stale" } },
    });
    const repaired = await run(args);
    expect(repaired.exitCode, repaired.stdout).toBe(0);
    expect(repaired.json).toMatchObject({
      status: "ready",
      appliedActions: ["installed_skill"],
    });
    await assertAligned();
    await expect(access(shared)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(configuration, "utf8")).toBe(before);

    const sharedControl = await run([
      "setup",
      "--skill-client",
      "shared",
      "--yes",
    ]);
    expect(sharedControl.exitCode, sharedControl.stdout).toBe(0);
    expect(sharedControl.json).toMatchObject({ status: "ready" });
    await access(join(shared, "SKILL.md"));
  },
);

cliTest(
  "setup keeps registration and skill readiness selections independent",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-independent-skill-");
    const result = await cli.run({
      arguments: [
        "setup",
        "--client",
        "codex",
        "--skill-client",
        "claude_code",
        "--yes",
        "--json",
      ],
      cwd: directory,
      environment: { USERPROFILE: directory },
    });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.json).toMatchObject({
      status: "ready",
      doctor: {
        healthy: true,
        scope: {
          clients: ["codex"],
          skill_clients: ["claude_code"],
          skill: true,
        },
        identity: { skill: { state: "aligned" } },
      },
    });
    await access(join(directory, ".codex/config.toml"));
    await access(
      join(directory, ".claude/skills/reverse-engineer-anything/SKILL.md"),
    );
    await expect(access(join(directory, ".claude.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(
      access(join(directory, ".agents/skills/reverse-engineer-anything")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
