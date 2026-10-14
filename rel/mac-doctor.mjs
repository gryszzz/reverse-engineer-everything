/**
 * Read-only platform readiness diagnostics. No packages are installed,
 * no targets are inspected, and no external network requests are made.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { arch, cpus, freemem, platform, totalmem } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const gib = (bytes) => Math.round((bytes / 1073741824) * 10) / 10;
const parsed = (version) => {
  const values = String(version).replace(/^v/u, "").split(".").map(Number);
  return values.length >= 2 && values.slice(0, 2).every(Number.isInteger)
    ? values
    : [];
};
export function supportedNode(version) {
  const [major, minor] = parsed(version);
  return (
    major >= 26 ||
    (major === 24 && minor >= 11) ||
    (major === 22 && minor >= 19)
  );
}

export function assessMacHost(input) {
  const isMac = input.platform === "darwin";
  const ram = Number(input.totalMemoryGiB ?? 0);
  const disk = input.diskFreeGiB;
  const nodeSupported = supportedNode(input.nodeVersion);
  const tools = input.tools ?? {};
  const steps = [];
  if (!isMac)
    steps.push(
      "This check is tuned for macOS; the current runner is " +
        input.platform +
        ".",
    );
  if (!nodeSupported)
    steps.push(
      "Install a supported Node version (see .nvmrc) before running the full REA build.",
    );
  else if (input.nodeVersion !== input.pinnedNode)
    steps.push(
      "For reproducible builds, use the repository-pinned Node " +
        input.pinnedNode +
        ".",
    );
  if (isMac && input.rosetta === "yes")
    steps.push(
      "Node appears to run through Rosetta. Prefer native architecture Node for build tooling.",
    );
  if (ram > 0 && ram <= 8.5)
    steps.push(
      "Low-memory profile: analyze one target at a time, keep scope small, and avoid parallel native analyzers.",
    );
  if (typeof disk === "number" && disk < 10)
    steps.push(
      "Less than 10 GiB free on this volume. Keep evidence output in a roomy separate directory or external SSD.",
    );
  if (!input.dependenciesPresent)
    steps.push(
      "The full analyzer needs repository dependencies: npm ci (after choosing the pinned Node version).",
    );
  if (!input.runtimeBuilt)
    steps.push(
      "REA is not yet built here: run npm run build:cached after npm ci.",
    );
  if (!tools.codex)
    steps.push(
      "Codex CLI is not on this process's PATH; the visual lab and terminal analysis can still run.",
    );
  return {
    profile: "macos-first-read-only",
    host: {
      platform: input.platform,
      architecture: input.architecture,
      nodeArchitecture: input.nodeArchitecture,
      rosetta: isMac ? input.rosetta : "not-applicable",
      cpuThreads: input.cpuThreads,
      memoryGiB: ram,
      freeMemoryGiB: input.freeMemoryGiB,
      diskFreeGiB: disk,
    },
    node: {
      current: input.nodeVersion,
      pinned: input.pinnedNode,
      supported: nodeSupported,
    },
    capabilities: {
      // The dependency-free teaching server is already running on this Node.
      visualLab: true,
      repoDependencies: Boolean(input.dependenciesPresent),
      builtReaCli: Boolean(input.runtimeBuilt),
      builtMcpServer: Boolean(input.mcpBuilt),
      projectCodexConfig: Boolean(input.projectConfig),
    },
    optionalTools: {
      codex: Boolean(tools.codex),
      java: Boolean(tools.java),
      ghidraCommand: Boolean(tools.ghidraRun),
      graphviz: Boolean(tools.dot),
      homebrew: Boolean(tools.brew),
      xcodeSelect: Boolean(tools["xcode-select"]),
    },
    guidance: steps,
    limits: [
      "A readiness check does not run REE, REA or a reverse-engineering provider.",
      "PATH checks cannot confirm tools installed as Mac apps or verify tool licenses.",
      "The exact Mac CPU and available storage must be read on the actual machine.",
    ],
  };
}

const binaryPresent = (command) => {
  const result = spawnSync("/usr/bin/which", [command], {
    encoding: "utf8",
    timeout: 1500,
  });
  return result.status === 0;
};
const rosettaState = () => {
  if (platform() !== "darwin") return "not-applicable";
  const result = spawnSync(
    "/usr/sbin/sysctl",
    ["-in", "sysctl.proc_translated"],
    {
      encoding: "utf8",
      timeout: 1500,
    },
  );
  if (result.status !== 0) return "unknown";
  return result.stdout.trim() === "1" ? "yes" : "no";
};
const freeDisk = (root) => {
  try {
    const stat = statfsSync(root);
    return gib(stat.bavail * stat.bsize);
  } catch {
    return null;
  }
};

/** Collect only current-machine facts. Safe on macOS and in non-Mac CI tests. */
export function diagnoseMac(root = ROOT) {
  const pinned = readFileSync(resolve(root, ".nvmrc"), "utf8").trim();
  const names = ["codex", "java", "ghidraRun", "dot", "brew", "xcode-select"];
  const found = Object.fromEntries(
    names.map((name) => [name, binaryPresent(name)]),
  );
  return assessMacHost({
    platform: platform(),
    architecture: arch(),
    nodeArchitecture: process.arch,
    rosetta: rosettaState(),
    cpuThreads: cpus().length,
    totalMemoryGiB: gib(totalmem()),
    freeMemoryGiB: gib(freemem()),
    diskFreeGiB: freeDisk(root),
    nodeVersion: process.versions.node,
    pinnedNode: pinned,
    dependenciesPresent: existsSync(resolve(root, "node_modules")),
    runtimeBuilt: existsSync(resolve(root, "dist/cli-runtime/cli.js")),
    mcpBuilt: existsSync(resolve(root, "dist/mcp/main.js")),
    projectConfig: existsSync(resolve(root, ".codex/config.toml")),
    tools: found,
  });
}

export function formatMacDiagnosis(result) {
  const r = result;
  const format = (v) => (v === null || v === undefined ? "unknown" : String(v));
  return [
    "REE / Mac readiness check (read-only)",
    "System: " +
      r.host.platform +
      " / " +
      r.host.architecture +
      " | Node architecture: " +
      r.host.nodeArchitecture +
      " | Rosetta: " +
      r.host.rosetta,
    "CPU threads: " +
      r.host.cpuThreads +
      " | RAM: " +
      r.host.memoryGiB +
      " GiB | free: " +
      r.host.freeMemoryGiB +
      " GiB",
    "Free space in REE volume: " + format(r.host.diskFreeGiB) + " GiB",
    "Node: " +
      r.node.current +
      " (pinned " +
      r.node.pinned +
      ", compatible: " +
      r.node.supported +
      ")",
    "Dependencies: " +
      (r.capabilities.repoDependencies ? "present" : "not installed"),
    "Compiled REA CLI: " + (r.capabilities.builtReaCli ? "found" : "not built"),
    "Compiled REA MCP: " +
      (r.capabilities.builtMcpServer ? "found" : "not built"),
    "Project Codex configuration: " +
      (r.capabilities.projectCodexConfig ? "found" : "missing"),
    "Optional commands on PATH: " +
      Object.entries(r.optionalTools)
        .map(([k, v]) => k + "=" + (v ? "yes" : "no"))
        .join(", "),
    "",
    "Suggested next steps:",
    ...(r.guidance.length
      ? r.guidance.map((s) => "- " + s)
      : ["- Basic readiness checks found no issues."]),
    "",
    "No system configuration or software was changed. Missing optional tools do not prevent the beginner lab.",
  ].join("\n");
}
