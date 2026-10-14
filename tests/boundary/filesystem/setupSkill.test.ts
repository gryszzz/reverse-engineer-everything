import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
  skillDestinations,
  type SkillInstallFileOperations,
} from "../../../src/application/SetupSkill.js";
import {
  runDoctor,
  systemDoctorHost,
} from "../../../src/application/Doctor.js";
import { createDoctorHostFixture } from "../../../src/application/Doctor.fixture.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { skillReferenceIssues } from "../../../scripts/lib/docs-facts.mjs";

const expectPermissionMode = async (
  path: string,
  expected: number,
): Promise<void> => {
  if (process.platform === "win32") return;
  expect((await stat(path)).mode & 0o777).toBe(expected);
};

describe("canonical skill transaction", () => {
  it("does not roll back files when backup preparation fails", async () => {
    const home = await createTestTempDirectory("rea-skill-backup-failure-");
    const root = join(home, ".agents/skills/reverse-engineer-anything");
    const manifest = join(root, "SKILL.md");
    const connection = join(root, "references/connection-and-recovery.md");
    const original = "operator-owned manifest bytes\n";
    const secondOriginal = "operator-owned reference bytes\n";
    await mkdir(dirname(connection), { recursive: true });
    await writeFile(manifest, original, { mode: 0o640 });
    await writeFile(connection, secondOriginal, { mode: 0o644 });
    const writes: string[] = [];
    let backups = 0;
    const operations: SkillInstallFileOperations = {
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      backup: async (source, target) => {
        backups += 1;
        if (backups === 2) throw new Error("injected backup failure");
        await copyFile(source, target, fsConstants.COPYFILE_EXCL);
      },
      write: async (path, content, mode) => {
        writes.push(path);
        await writeFile(path, content, { mode });
      },
      remove: async (path) => rm(path, { force: true }),
    };

    const result = await installCanonicalSkill(
      home,
      [],
      {},
      process.platform,
      operations,
    );

    if (result.ok) throw new Error("Expected backup failure");
    expect(result.error.stage).toBe("backup");
    expect(result.error.rollbackFailures).toEqual([]);
    expect(writes).toEqual([]);
    expect(await readFile(manifest, "utf8")).toBe(original);
    expect(await readFile(connection, "utf8")).toBe(secondOriginal);
    expect(await readFile(`${manifest}.rea.backup`, "utf8")).toBe(original);
    await expect(
      readFile(`${connection}.rea.backup`, "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectPermissionMode(manifest, 0o640);
    await expectPermissionMode(connection, 0o644);
  });

  it("rolls back attempted writes independently and preserves original modes", async () => {
    const home = await createTestTempDirectory("rea-skill-rollback-failure-");
    const [destination] = skillDestinations(home, []);
    if (destination === undefined) throw new Error("Missing shared skill root");
    const root = destination.path;
    const manifest = join(root, "SKILL.md");
    const connection = join(root, "references/connection-and-recovery.md");
    const native = join(root, "references/native-and-artifacts.md");
    await mkdir(dirname(native), { recursive: true });
    await writeFile(manifest, "old manifest\n", { mode: 0o640 });
    await writeFile(connection, "old connection\n", { mode: 0o644 });
    await writeFile(native, "old native\n", { mode: 0o600 });
    const writes = new Map<string, number>();
    const nativeWrites: string[] = [];
    const operations: SkillInstallFileOperations = {
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      backup: async (source, target) =>
        copyFile(source, target, fsConstants.COPYFILE_EXCL),
      write: async (path, content, mode) => {
        const attempt = (writes.get(path) ?? 0) + 1;
        writes.set(path, attempt);
        if (path === native) nativeWrites.push(content);
        if (path === native && attempt === 2)
          throw new Error("injected rollback failure");
        await writeFileAtomic(path, content, { encoding: "utf8", mode });
        if (path === native && attempt === 1)
          throw new Error("injected ambiguous publication failure");
      },
      remove: async (path) => rm(path, { force: true }),
    };

    const result = await installCanonicalSkill(
      home,
      [],
      {},
      process.platform,
      operations,
    );

    if (result.ok) throw new Error("Expected write failure");
    expect(result.error.stage).toBe("write");
    expect(result.error.path).toBe(native);
    expect(result.error.rollbackFailures).toEqual([
      { path: native, reason: "injected rollback failure" },
    ]);
    expect(result.error.recoveryBackupPaths).toEqual([
      `${manifest}.rea.backup`,
      `${connection}.rea.backup`,
      `${native}.rea.backup`,
    ]);
    expect(result.error.message).toContain(
      `${native} (injected rollback failure)`,
    );
    expect(await readFile(manifest, "utf8")).toBe("old manifest\n");
    expect(await readFile(connection, "utf8")).toBe("old connection\n");
    await expectPermissionMode(manifest, 0o640);
    await expectPermissionMode(connection, 0o644);
    expect(await readFile(native, "utf8")).not.toBe("old native\n");
    expect(await readFile(`${native}.rea.backup`, "utf8")).toBe("old native\n");
    expect(nativeWrites).toHaveLength(2);
    expect(nativeWrites[1]).toBe("old native\n");
    expect(result.error.message).toContain(
      `Existing-file backups remain at ${manifest}.rea.backup`,
    );
  });
});

describe("canonical skill discovery", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "preserves an unreadable existing skill instead of treating it as absent",
    async () => {
      const home = await createTestTempDirectory("rea-skill-unreadable-");
      const destination = join(
        home,
        ".agents/skills/reverse-engineer-anything/SKILL.md",
      );
      const original = "existing private skill bytes\n";
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, original, { mode: 0o200 });
      try {
        await chmod(destination, 0o200);
        const result = await installCanonicalSkill(home);
        if (result.ok) throw new Error("Expected unreadable skill failure");
        expect(result.error.stage).toBe("prepare");
      } finally {
        await chmod(destination, 0o600);
      }
      expect(await readFile(destination, "utf8")).toBe(original);
      await expect(
        readFile(`${destination}.rea.backup`, "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("installs only the selected Claude Code personal skill", async () => {
    const home = await createTestTempDirectory("rea-claude-skill-");
    const configDirectory = join(home, "claude-config");
    const skillsDirectory = join(configDirectory, "skills");
    const claudeSkill = join(
      skillsDirectory,
      "reverse-engineer-anything/SKILL.md",
    );
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          },
        },
      }),
    );
    const host = systemDoctorHost({
      environment: {
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: configDirectory,
      },
    });

    expect(
      await canonicalSkillNeedsInstall(home, ["claude_code"], {
        CLAUDE_CONFIG_DIR: dirname(skillsDirectory),
      }),
    ).toBe(true);
    expect(
      await installCanonicalSkill(home, ["claude_code"], {
        CLAUDE_CONFIG_DIR: dirname(skillsDirectory),
      }),
    ).toMatchObject({ ok: true, value: "installed" });
    expect(
      await canonicalSkillNeedsInstall(home, ["claude_code"], {
        CLAUDE_CONFIG_DIR: dirname(skillsDirectory),
      }),
    ).toBe(false);
    await expect(access(claudeSkill)).resolves.toBeUndefined();
    await expect(
      access(join(home, ".agents/skills/reverse-engineer-anything")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await runDoctor(undefined, host, {
          clients: ["claude_code"],
          skill: true,
        })
      ).identity?.skill.state,
    ).toBe("aligned");
  });

  it("checks selected skill locations for independent drift", async () => {
    const home = await createTestTempDirectory("rea-mixed-skill-");
    const sharedSkill = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    const claudeSkills = join(home, ".claude", "skills");
    const claudeSkill = join(
      claudeSkills,
      "reverse-engineer-anything/SKILL.md",
    );
    const host = systemDoctorHost({
      environment: { HOME: home, USERPROFILE: home },
    });
    const doctorScope = { clients: ["claude_code", "codex"], skill: true };

    expect(
      await installCanonicalSkill(home, ["claude_code", "codex"]),
    ).toMatchObject({ ok: true, value: "installed" });
    await rm(sharedSkill);
    expect(
      (await runDoctor(undefined, host, doctorScope)).identity?.skill.state,
    ).toBe("stale");
    expect(
      await installCanonicalSkill(home, ["claude_code", "codex"]),
    ).toMatchObject({ ok: true, value: "installed" });
    for (const skill of [sharedSkill, claudeSkill]) {
      await writeFile(skill, "selected copy changed\n");
      expect(
        (await runDoctor(undefined, host, doctorScope)).identity?.skill.state,
      ).toBe("stale");
      expect(
        await installCanonicalSkill(home, ["claude_code", "codex"]),
      ).toMatchObject({ ok: true, value: "installed" });
      expect(
        (await runDoctor(undefined, host, doctorScope)).identity?.skill.state,
      ).toBe("aligned");
    }
  });
});

describe("canonical skill transaction", () => {
  it("backs up and upgrades a stale managed skill without touching siblings", async () => {
    const home = await createTestTempDirectory("rea-skill-test-");
    const destination = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    const sibling = join(home, ".agents/skills/unrelated/SKILL.md");
    const nativeGuide = join(
      dirname(destination),
      "references/native-and-artifacts.md",
    );
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(dirname(nativeGuide), { recursive: true });
    await mkdir(dirname(sibling), { recursive: true });
    await writeFile(destination, "stale managed skill\n", { mode: 0o640 });
    await writeFile(nativeGuide, "stale filesystem-write permission grant\n");
    await writeFile(sibling, "unrelated skill\n");

    expect(await canonicalSkillNeedsInstall(home)).toBe(true);
    expect(await installCanonicalSkill(home)).toMatchObject({
      ok: true,
      value: "installed",
    });
    expect(await readFile(`${destination}.rea.backup`, "utf8")).toBe(
      "stale managed skill\n",
    );
    const installedSkill = await readFile(destination, "utf8");
    expect(installedSkill).toBe(
      await readFile(
        new URL(
          "../../../skills/reverse-engineer-anything/SKILL.md",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(installedSkill).toContain(
      `version: "${PRODUCT_IDENTITY.skillVersion}"`,
    );
    await expectPermissionMode(destination, 0o640);
    expect(await readFile(`${nativeGuide}.rea.backup`, "utf8")).toBe(
      "stale filesystem-write permission grant\n",
    );
    for (const reference of [
      "connection-and-recovery.md",
      "native-and-artifacts.md",
      "javascript-applications.md",
      "android-applications.md",
      "runtime-observation.md",
      "evidence-workflows.md",
    ]) {
      const installed = await readFile(
        join(dirname(destination), "references", reference),
        "utf8",
      );
      expect(installed).toBe(
        await readFile(
          new URL(
            `../../../skills/reverse-engineer-anything/references/${reference}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(installed).not.toMatch(
        /filesystem-write permission grant|native_mount_approved|only with explicit approval|Obtain the per-call/u,
      );
    }
    expect(installedSkill).toContain(
      "use normal repository tools and do not run REA",
    );
    expect(installedSkill).toContain(
      `tool_count: ${String(TOOL_CONTRACTS.length)}`,
    );
    expect(await readFile(sibling, "utf8")).toBe("unrelated skill\n");
    expect(
      await readFile(
        join(
          home,
          ".agents/skills/reverse-engineer-anything/references/javascript-applications.md",
        ),
        "utf8",
      ),
    ).toContain("analyze_javascript_application");
    expect(await canonicalSkillNeedsInstall(home)).toBe(false);
    expect(await installCanonicalSkill(home)).toMatchObject({
      ok: true,
      value: "unchanged",
    });
    expect(await skillReferenceIssues(dirname(destination))).toEqual([]);
  });

  it("binds portable conformance to the generated skill bytes that setup installs", async () => {
    const home = await createTestTempDirectory("rea-skill-commitment-");
    expect(await installCanonicalSkill(home)).toMatchObject({
      ok: true,
      value: "installed",
    });
    const paths = [
      "SKILL.md",
      "references/android-applications.md",
      "references/connection-and-recovery.md",
      "references/evidence-workflows.md",
      "references/javascript-applications.md",
      "references/native-and-artifacts.md",
      "references/runtime-observation.md",
    ];
    const records = await Promise.all(
      paths.map(async (path) => {
        const bytes = await readFile(
          join(home, ".agents/skills/reverse-engineer-anything", path),
        );
        return `${path}\0${createHash("sha256").update(bytes).digest("hex")}\n`;
      }),
    );
    const manifest = z
      .object({
        skill_digests: z.array(
          z.object({ skill_id: z.string(), sha256: z.string() }),
        ),
      })
      .parse(
        JSON.parse(
          await readFile(
            "docs/verification/managed-conformance-manifest.json",
            "utf8",
          ),
        ),
      );
    expect(manifest.skill_digests).toContainEqual({
      skill_id: "reverse-engineer-anything",
      sha256: createHash("sha256").update(records.join("")).digest("hex"),
    });
  });
});

it("doctor verifies installed instructions and references even when metadata is current", async () => {
  const home = await createTestTempDirectory("rea-skill-doctor-");
  const destination = join(
    home,
    ".agents/skills/reverse-engineer-anything/SKILL.md",
  );
  const reference = join(
    dirname(destination),
    "references/evidence-workflows.md",
  );
  const system = systemDoctorHost({
    environment: { HOME: home, USERPROFILE: home },
  });
  const host = createDoctorHostFixture({
    installedSkillIdentity: (registrations) =>
      system.installedSkillIdentity?.(registrations) ??
      Promise.resolve(undefined),
  });
  expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
    "missing",
  );
  expect(await installCanonicalSkill(home)).toMatchObject({
    ok: true,
    value: "installed",
  });
  expect((await runDoctor(undefined, host)).identity?.skill).toMatchObject({
    state: "aligned",
  });
  for (const [path, remove] of [
    [destination, false],
    [reference, false],
    [reference, true],
  ] as const) {
    if (remove) await rm(path);
    else await writeFile(path, "Locally changed instructions.\n");
    expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
      "stale",
    );
    expect(await installCanonicalSkill(home)).toMatchObject({
      ok: true,
      value: "installed",
    });
    expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
      "aligned",
    );
  }
});
