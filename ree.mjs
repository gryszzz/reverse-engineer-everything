#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyTarget,
  renderPlan,
  availableCategories,
} from "./rel/intake.mjs";
import { runStaticAnalysis } from "./rel/analyze-static.mjs";
import { startLabServer, openLabInBrowser } from "./rel/lab-server.mjs";
import { diagnoseMac, formatMacDiagnosis } from "./rel/mac-doctor.mjs";
import {
  defaultStudioDataDir,
  openStudioInBrowser,
  startStudio,
} from "./rel/studio/server.mjs";
import { buildMacApp } from "./rel/app/build-mac-app.mjs";
import { installMacApp } from "./rel/app/install-mac-app.mjs";

const repo = dirname(fileURLToPath(import.meta.url));
const help = [
  "REE — a simple front door to the local REA analysis engine.",
  "",
  "node ree.mjs types                              Supported target families",
  "node ree.mjs inspect TARGET --question TEXT     Classify without running tools",
  "node ree.mjs demo                               Preview our own lab",
  "node ree.mjs lab [--open]                       Open visual learning lab locally",
  "node ree.mjs studio [--open] [--port N] [--data DIR]",
  "                                                Open the local Investigation Studio",
  "node ree.mjs app build [--out REE.app]         Build a local unsigned REE.app",
  "node ree.mjs app install [--app REE.app] [--home DIR]",
  "                                                Copy REE.app to ~/Applications",
  "node ree.mjs demo --run --out DIR                Run our verified lab",
  "node ree.mjs analyze TARGET --authorized --out DIR [--question TEXT]",
  "                                                Static JavaScript/Electron folder or ASAR",
  "node ree.mjs outside-in --name NAME --url URL --out DIR [--json]",
  "                                                Public-docs behavior spec; no target source",
  "node ree.mjs agents <step> --json               Headless analyze through board post. See docs/agents.md",
  "node ree.mjs ingest-docs <url-or-dir> --out DIR [--name NAME] [--json]",
  "                                                OpenAPI, HTML, or a docs folder into that spec",
  "node ree.mjs pipeline TARGET --out DIR [--name NAME] [--resume] [--authorized]",
  "                                                Directory, or an http(s) URL that needs --authorized",
  "node ree.mjs opportunities ingest FILE --out DIR",
  "node ree.mjs opportunities list --data DIR",
  "node ree.mjs board picks --data DIR",
  "node ree.mjs board picks --from DIR",
  "node ree.mjs board export --data DIR --out DIR",
  "node ree.mjs board export --to DIR",
  "node ree.mjs rebuild --spec FILE --name NAME --out DIR",
  "node ree.mjs verify --project DIR",
  "node ree.mjs handoff --project DIR [--blast-dir DIR] [--scout FILE]",
  "node ree.mjs edition [--json]                   License and edition boundary",
  "node ree.mjs codex                              Check Codex project setup",
  "node ree.mjs doctor [--json]                    Read-only Mac readiness check",
  "node ree.mjs bench [--json] [--case ID]         Score owned fixtures against ground truth",
  "",
  "All output goes outside the REE repository. Other target families use REA's",
  "documented providers/MCP tools, not a fabricated universal analyzer.",
].join("\n");

function options(args) {
  const values = {
    json: false,
    run: false,
    authorized: false,
    open: false,
    out: null,
    question: null,
    port: null,
    data: null,
    app: null,
    home: null,
    layoutOnly: false,
    positional: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") values.json = true;
    else if (arg === "--run") values.run = true;
    else if (arg === "--authorized") values.authorized = true;
    else if (arg === "--open") values.open = true;
    else if (arg === "--port") {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0 || value > 65535)
        throw new Error("--port must be an integer from 0 to 65535.");
      values.port = value;
    } else if (arg === "--data") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("--data requires a directory.");
      values.data = args[++i];
    } else if (arg === "--app" || arg === "--home") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(arg + " requires a path.");
      values[arg === "--app" ? "app" : "home"] = args[++i];
    } else if (arg === "--layout-only") values.layoutOnly = true;
    else if (["--out", "--question", "-q"].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(arg + " requires a value.");
      values[arg === "--out" ? "out" : "question"] = args[++i];
    } else if (arg.startsWith("-")) throw new Error("Unknown option: " + arg);
    else values.positional.push(arg);
  }
  return values;
}

async function runAppCommand(settings) {
  const subcommand = settings.positional[1];
  if (
    settings.run ||
    settings.authorized ||
    settings.open ||
    settings.question ||
    settings.port !== null ||
    settings.data
  ) {
    throw new Error(
      "Use node ree.mjs app build [--out REE.app] or node ree.mjs app install [--app REE.app] [--home DIR].",
    );
  }
  if (subcommand === "build" && settings.positional.length === 2) {
    if (settings.app || settings.home) {
      throw new Error("app build accepts --out and --layout-only.");
    }
    const built = buildMacApp({
      out: settings.out ?? undefined,
      layoutOnly: settings.layoutOnly,
    });
    if (settings.json) console.log(JSON.stringify(built));
    else {
      console.log("Built " + built.app);
      console.log(
        built.window === "built"
          ? "WebKit window architectures: " + built.architectures.join(", ")
          : "WebKit window: " + built.window_reason,
      );
      console.log("Checkout: " + built.checkout);
      console.log("Node: " + built.node);
    }
    return;
  }
  if (subcommand === "install" && settings.positional.length === 2) {
    if (settings.out || settings.layoutOnly) {
      throw new Error("app install accepts --app and --home.");
    }
    const installed = installMacApp({
      app: settings.app ?? undefined,
      home: settings.home ?? undefined,
    });
    if (settings.json) console.log(JSON.stringify(installed));
    else {
      console.log("Installed " + installed.app);
      console.log(
        "Desktop " + installed.alias_kind + " alias: " + installed.alias,
      );
      console.log("Window: " + installed.window);
      console.log(
        "The bundle is unsigned. If macOS blocks the first open, right-click REE.app, choose Open, then Open.",
      );
    }
    return;
  }
  throw new Error(
    "Use node ree.mjs app build [--out REE.app] or node ree.mjs app install [--app REE.app] [--home DIR].",
  );
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "bench") {
    const { runBenchCommand } = await import("./rel/bench/cli.mjs");
    process.exitCode = await runBenchCommand(args.slice(1));
  } else if (args[0] === "ingest-docs") {
    const { runIngestDocsCommand } = await import("./rel/ingest/cli.mjs");
    process.exitCode = await runIngestDocsCommand(args.slice(1));
  } else if (args[0] === "outside-in") {
    const { runOutsideInCommand } = await import("./rel/outside-in/cli.mjs");
    process.exitCode = await runOutsideInCommand(args.slice(1));
  } else if (args[0] === "agents") {
    const { runAgentsCommand } = await import("./rel/agents/cli.mjs");
    process.exitCode = await runAgentsCommand(args.slice(1));
  } else if (args[0] === "edition") {
    const { formatEdition } = await import("./rel/edition.mjs");
    console.log(formatEdition(args.includes("--json")));
  } else if (
    [
      "opportunities",
      "rebuild",
      "verify",
      "handoff",
      "pipeline",
      "board",
    ].includes(args[0])
  ) {
    const { runPipelineCommand } = await import("./rel/pipeline/cli.mjs");
    process.exitCode = await runPipelineCommand(args);
  } else if (
    args.length === 0 ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    console.log(help);
  } else {
    const settings = options(args);
    const [mode, target] = settings.positional;
    if (settings.open && mode !== "lab" && mode !== "studio")
      throw new Error("--open is available only for the local lab or studio.");
    if ((settings.port !== null || settings.data) && mode !== "studio")
      throw new Error("--port and --data are only available for the studio.");
    if (
      (settings.app || settings.home || settings.layoutOnly) &&
      mode !== "app"
    )
      throw new Error(
        "--app, --home, and --layout-only are only available for the app command.",
      );
    if (mode === "doctor" && settings.positional.length === 1) {
      if (
        settings.run ||
        settings.authorized ||
        settings.out ||
        settings.question ||
        settings.open
      )
        throw new Error(
          "Use doctor [--json] without execution or analysis flags.",
        );
      const diagnosis = diagnoseMac();
      console.log(
        settings.json
          ? JSON.stringify(diagnosis, null, 2)
          : formatMacDiagnosis(diagnosis),
      );
    } else if (mode === "types" && settings.positional.length === 1) {
      if (settings.run || settings.authorized || settings.out)
        throw new Error("types is preview-only.");
      const list = availableCategories();
      console.log(
        settings.json
          ? JSON.stringify(list, null, 2)
          : list.map((x) => x.label + " — " + x.capability).join("\n"),
      );
    } else if (mode === "codex" && settings.positional.length === 1) {
      if (settings.run || settings.authorized || settings.out || settings.json)
        throw new Error("codex has no execution flags.");
      console.log(
        "REE / Codex workspace configuration: " +
          (existsSync(resolve(repo, ".codex/config.toml"))
            ? "present"
            : "not found"),
      );
      console.log(
        "REA compiled MCP runtime: " +
          (existsSync(resolve(repo, "dist/mcp/main.js"))
            ? "built"
            : "missing — run npm ci && npm run build:cached"),
      );
      console.log(
        "Open this REE checkout from its root in a trusted Codex workspace; check /mcp and use $ree-investigator.",
      );
      console.log(
        "Project settings are not your personal Codex config. Only this REE fork was changed.",
      );
    } else if (mode === "lab" && settings.positional.length === 1) {
      if (
        settings.run ||
        settings.authorized ||
        settings.out ||
        settings.json ||
        settings.question
      )
        throw new Error(
          "Use node ree.mjs lab [--open] with no analysis flags.",
        );
      const { url } = await startLabServer();
      console.log("REE Visual Lab — learn by seeing what the code does.");
      console.log("Open this local address: " + url);
      console.log(
        "No internet, target execution, global Codex installation, or other projects involved.",
      );
      console.log("Press Ctrl+C to close the local lab.");
      if (settings.open) openLabInBrowser(url);
    } else if (mode === "studio" && settings.positional.length === 1) {
      if (
        settings.run ||
        settings.authorized ||
        settings.out ||
        settings.question
      )
        throw new Error(
          "Use node ree.mjs studio [--open] [--port N] [--data DIR].",
        );
      const started = await startStudio({
        port: settings.port ?? 0,
        dataDir: settings.data ?? defaultStudioDataDir(),
      });
      const message = {
        url: started.url,
        data_dir: started.dataDir,
        bind: "127.0.0.1",
      };
      if (settings.json) console.log(JSON.stringify(message));
      else {
        console.log("REE Investigation Studio");
        console.log("Open this local address: " + started.url);
        console.log("Projects and Evidence stay in: " + started.dataDir);
        console.log("Loopback only. No account and no remote upload.");
        console.log("Press Ctrl+C to stop.");
      }
      if (settings.open) openStudioInBrowser(started.url);
    } else if (mode === "app") {
      await runAppCommand(settings);
    } else if (mode === "demo" && settings.positional.length === 1) {
      const lab = resolve(repo, "experiments/rel-first-lab");
      if (settings.run) {
        if (!settings.out || settings.authorized || settings.json)
          throw new Error(
            "Use demo --run --out DIR, without --authorized or --json.",
          );
        const child = spawnSync(
          process.execPath,
          [
            resolve(repo, "experiments/rel-first-lab/run-real-analysis.mjs"),
            resolve(settings.out),
          ],
          { cwd: repo, stdio: "inherit", timeout: 240000 },
        );
        if (child.error || child.status !== 0)
          throw new Error("REE demo run failed; see output and logs.");
      } else {
        if (settings.out || settings.authorized)
          throw new Error(
            "Demo preview does not accept --out or --authorized.",
          );
        const plan = classifyTarget(lab);
        console.log(
          settings.json
            ? JSON.stringify({ ...plan, safe_demo: true }, null, 2)
            : renderPlan(plan, settings.question) +
                "\n\nTo run: node ree.mjs demo --run --out /tmp/ree-evidence",
        );
      }
    } else if (
      mode === "analyze" &&
      target &&
      settings.positional.length === 2
    ) {
      if (settings.run)
        throw new Error("analyze uses --authorized (not --run).");
      const result = runStaticAnalysis({
        target,
        out: settings.out,
        authorized: settings.authorized,
        question: settings.question,
      });
      console.log(
        settings.json
          ? JSON.stringify(result, null, 2)
          : "REE static analysis verified: " +
              result.nodes +
              " graph nodes, " +
              result.edges +
              " edges.\nEvidence: " +
              result.evidence_id +
              "\nReport: " +
              result.report,
      );
    } else {
      if (mode === "inspect") {
        if (!target || settings.positional.length !== 2)
          throw new Error("Usage: node ree.mjs inspect TARGET");
      } else {
        if (settings.positional.length !== 1)
          throw new Error("Choose a single supported command or target.");
      }
      if (settings.run || settings.authorized || settings.out)
        throw new Error(
          "Analysis execution is only enabled for the REE-owned demo or via analyze --authorized for static JavaScript.",
        );
      const plan = classifyTarget(mode === "inspect" ? target : mode);
      console.log(
        settings.json
          ? JSON.stringify(
              {
                ...plan,
                question: settings.question,
                execution: "preview-only",
              },
              null,
              2,
            )
          : renderPlan(plan, settings.question),
      );
    }
  }
} catch (error) {
  console.error("REE: " + error.message);
  process.exitCode = 2;
}
