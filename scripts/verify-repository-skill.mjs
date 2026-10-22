import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { exec, pathExists } from "./lib/verify-package-core.mjs";

/** Exercise Skills' default root discovery without ignored build outputs. */
export async function verifyRepositorySkill({ root, workspace }) {
  const snapshot = join(workspace, "repository");
  const consumer = join(workspace, "skill-consumer");
  const home = join(workspace, "skill-consumer-home");
  const tracked = (
    await exec(
      "git",
      ["ls-files", "--cached", "--format=%(objectmode) %(path)", "-z"],
      { cwd: root },
    )
  ).stdout
    .split("\0")
    .filter(Boolean);
  for (const entry of tracked) {
    const mode = entry.slice(0, 6);
    const path = entry.slice(7);
    const destination = join(snapshot, path);
    // A GitHub clone without submodule initialization has only these directories.
    if (mode === "160000") {
      await mkdir(destination, { recursive: true });
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, path), destination, { verbatimSymlinks: true });
  }
  if (await pathExists(join(snapshot, "skills")))
    throw new Error("repository skill check must run without generated skills");
  await mkdir(consumer, { recursive: true });
  await mkdir(home, { recursive: true });
  const skillsVersion = "1.7.2";
  await execSkillAdd({ snapshot, consumer, home, skillsVersion });
  const authoredRoot = join(
    snapshot,
    ".agents/skills/reverse-engineer-anything",
  );
  const installedSkills = join(consumer, ".agents/skills");
  const installedRoot = join(installedSkills, "reverse-engineer-anything");
  const files = await filePaths(authoredRoot);
  if (
    JSON.stringify(await readdir(installedSkills)) !==
      JSON.stringify(["reverse-engineer-anything"]) ||
    JSON.stringify(await filePaths(installedRoot)) !== JSON.stringify(files)
  )
    throw new Error(
      "Skills did not install exactly the selected public bundle",
    );
  for (const path of files) {
    const authored = await readFile(join(authoredRoot, path));
    if (!authored.equals(await readFile(join(installedRoot, path))))
      throw new Error(`Skills changed authored skill content: ${path}`);
  }
  return { skillsVersion, files };
}

async function execSkillAdd({ snapshot, consumer, home, skillsVersion }) {
  const args = [
    "exec",
    "--yes",
    "--package",
    `skills@${skillsVersion}`,
    "--",
    "skills",
    "add",
    snapshot,
    "--skill",
    "reverse-engineer-anything",
    "--agent",
    "codex",
    "--yes",
  ];
  // CI=1 hides npm's progress bar, so a slow registry read produces no
  // output until this timeout. Darwin runners have exceeded the old 120s
  // budget once while Linux finished the same commit; retry that stall once.
  const options = {
    cwd: consumer,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_HOME: join(home, ".codex"),
      DO_NOT_TRACK: "1",
      SKILLS_NO_TELEMETRY: "1",
      CI: "1",
      GIT_TERMINAL_PROMPT: "0",
      npm_config_fund: "false",
      npm_config_audit: "false",
      npm_config_update_notifier: "false",
    },
    timeout: 180_000,
    killSignal: "SIGKILL",
  };
  try {
    await exec("npm", args, options);
  } catch (cause) {
    if (!commandTimedOut(cause)) throw cause;
    // The killed attempt may still hold the shared npm cache. Retry against
    // a private cache and a clean consumer tree.
    await rm(join(consumer, ".agents"), { recursive: true, force: true });
    await exec("npm", args, {
      ...options,
      env: {
        ...options.env,
        npm_config_cache: join(home, "npm-cache-retry"),
      },
    });
  }
}

function commandTimedOut(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause.killed === true ||
      cause.signal === "SIGTERM" ||
      cause.signal === "SIGKILL" ||
      cause.code === "ETIMEDOUT")
  );
}

async function filePaths(root) {
  return (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}
