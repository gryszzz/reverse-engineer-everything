import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { diagnoseMac, supportsSqliteInspection } from "../mac-doctor.mjs";
import { assessRoutes, collectRouteFacts } from "./engine-routes.mjs";
import { repositoryRoot } from "./paths.mjs";
import { setupOffers } from "./setup-offers.mjs";

const commandPresent = (command) => {
  const result = spawnSync("/usr/bin/which", [command], {
    encoding: "utf8",
    timeout: 1500,
  });
  return result.status === 0;
};

const anyPresent = (commands) =>
  commands.some((command) => commandPresent(command));

function prerequisite(present) {
  return present ? "present" : "missing";
}

/**
 * Route status for this checkout and this machine.
 * implemented/available/configured/verified are separate facts.
 * PATH presence is not a successful analysis and not a license check.
 */
export function assessStudioReadiness({
  verifiedCounts = {},
  root = repositoryRoot,
} = {}) {
  const host = diagnoseMac(root);
  const runtimeBuilt = existsSync(join(root, "dist/cli-runtime/cli.js"));
  const tools = {
    ghidra: anyPresent(["ghidraRun", "ghidra"]),
    ida: anyPresent(["idat", "idat64", "ida64", "ida"]),
    hopper: anyPresent(["hopper"]),
    jadx: anyPresent(["jadx"]),
    apktool: anyPresent(["apktool"]),
    jeb: anyPresent(["jeb"]),
    binwalk: anyPresent(["binwalk"]),
    unblob: anyPresent(["unblob"]),
    wabt: anyPresent(["wasm-objdump", "wasm-validate"]),
    tshark: anyPresent(["tshark", "capinfos"]),
    java: anyPresent(["java"]),
    frida: anyPresent(["frida"]),
  };
  const recorded = (id) =>
    Number.isSafeInteger(verifiedCounts[id]) && verifiedCounts[id] > 0
      ? "recorded-in-this-studio"
      : "not-recorded";
  const facts = collectRouteFacts({ root });
  const engineRoutes = assessRoutes(facts).map((route) => ({
    id: route.id,
    label: route.label,
    status: route.status,
    engine: route.engine,
    studio: route.studio,
    prerequisites:
      route.status === "ready"
        ? "present"
        : route.status === "missing-tool"
          ? "missing"
          : route.status === "unsupported"
            ? "not-applicable"
            : route.status,
    configured:
      route.status === "ready"
        ? "configured"
        : route.status === "unsupported"
          ? "not-applicable"
          : "not-configured",
    verified_on_host: recorded(route.id),
    notes: route.detail,
  }));
  const routes = [
    {
      id: "sqlite",
      label: "SQLite snapshot inspection",
      engine: "implemented",
      studio: "not-supported",
      prerequisites: prerequisite(
        supportsSqliteInspection(process.versions.node),
      ),
      configured: "not-applicable",
      verified_on_host: "not-recorded",
      notes:
        "The engine has a read-only SQLite route. This studio does not invoke it. Node support is not a completed database inspection.",
    },
    {
      id: "ida",
      label: "IDA native analysis",
      engine: "implemented",
      studio: "unsupported",
      status: "unsupported",
      prerequisites: prerequisite(tools.ida),
      configured: "not-applicable",
      verified_on_host: "not-recorded",
      notes:
        "IDA is bring-your-own and read-only in REA. The studio does not attach to IDA.",
    },
    {
      id: "hopper",
      label: "Hopper native analysis",
      engine: "implemented",
      studio: "unsupported",
      status: "unsupported",
      prerequisites: prerequisite(tools.hopper),
      configured: "unknown",
      verified_on_host: "not-recorded",
      notes:
        "Hopper is commonly a Mac app rather than a PATH command. This check does not verify it, and the studio does not launch it.",
    },
    {
      id: "jeb",
      label: "JEB",
      engine: "implemented",
      studio: "not-supported",
      prerequisites: prerequisite(tools.jeb),
      configured: "unknown",
      verified_on_host: "not-recorded",
      notes: "No JEB analysis was run. The studio has no JEB route.",
    },
    {
      id: "firmware",
      label: "Firmware extraction",
      engine: "implemented",
      studio: "not-supported",
      prerequisites: prerequisite(tools.binwalk || tools.unblob),
      configured: "unknown",
      verified_on_host: "not-recorded",
      notes:
        "Binwalk or Unblob on PATH is not a completed extraction. The studio does not extract firmware.",
    },
    {
      id: "pcap",
      label: "Packet capture inspection",
      engine: "implemented",
      studio: "not-supported",
      prerequisites: prerequisite(tools.tshark),
      configured: "unknown",
      verified_on_host: "not-recorded",
      notes:
        "The studio does not parse packet captures or open a live interface.",
    },
    {
      id: "process-capture",
      label: "REA process capture",
      engine: "implemented",
      studio: "not-supported",
      prerequisites: "not-applicable",
      configured: "not-applicable",
      verified_on_host: "not-recorded",
      notes:
        "The engine can capture an explicitly scoped process. The studio experiment is a separate owned-fixture probe and does not call capture-process.",
    },
    {
      id: "finite-hypotheses",
      label: "Finite hypothesis planner",
      engine: "implemented",
      studio: "preview-only",
      prerequisites: prerequisite(runtimeBuilt),
      configured: "not-applicable",
      verified_on_host: recorded("finite-hypotheses"),
      notes:
        "discriminate-finite-hypotheses ranks caller-declared predictions and does not launch a target. With no REA Evidence IDs linked, it reports insufficient evidence. The studio does not mint Evidence IDs.",
    },
    {
      id: "owned-fixture-probe",
      label: "Owned first-lab runtime probe",
      engine: "not-applicable",
      studio: "implemented",
      prerequisites: "present",
      configured: "not-applicable",
      verified_on_host: recorded("owned-fixture-probe"),
      notes:
        "Runs only experiments/rel-first-lab/search.mjs for an allowlisted query, after a digest-matched approval. Output is runtime capture, kept apart from static Evidence.",
    },
    {
      id: "remote-model",
      label: "Remote model commentary",
      engine: "not-applicable",
      studio: "unsupported",
      prerequisites: "not-applicable",
      configured: "refused",
      verified_on_host: "not-recorded",
      notes:
        "The studio does not send Evidence or source to a model service. Local research stages only restate retained tool results.",
    },
  ];
  return {
    generated_at: new Date().toISOString(),
    host,
    runtime_built: runtimeBuilt,
    tool_commands_on_path: tools,
    verification_meaning:
      "recorded-in-this-studio counts completed Investigation Studio actions in this data directory. It is not a CI result, provider certification, or proof about another machine.",
    limits: [
      "A readiness check does not analyze a target or install software.",
      "An install runs only after the page shows the exact argv and the request repeats its digest with approved true.",
      "PATH checks miss Mac app bundles and do not verify licenses or versions.",
      "Studio support is narrower than the REA engine.",
    ],
    routes: [...engineRoutes, ...routes],
    setup: setupOffers({
      platform: facts.platform,
      brew: facts.brew,
      apktoolReady: facts.apktool.state === "ready",
    }),
  };
}

export function countStudioVerifications(store) {
  const counts = {
    "javascript-static": 0,
    "finite-hypotheses": 0,
    "owned-fixture-probe": 0,
  };
  for (const summary of store.list()) {
    if (summary.error) continue;
    const project = store.read(summary.id);
    for (const run of project.runs) {
      if (run.status !== "completed" || !run.evidence_id) continue;
      const key =
        run.kind === "static-javascript" ? "javascript-static" : run.kind;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    counts["owned-fixture-probe"] += project.experiments.filter(
      (experiment) =>
        experiment.status === "completed" && experiment.observation,
    ).length;
    counts["finite-hypotheses"] += project.experiments.filter(
      (experiment) => experiment.planner?.status === "completed",
    ).length;
  }
  return counts;
}
