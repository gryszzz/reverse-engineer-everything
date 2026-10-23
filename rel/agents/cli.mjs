import {
  analyzeForAgent,
  packageForAgent,
  postSpecToBoard,
  readFindings,
  readSpec,
  rebuildForAgent,
  verifyForAgent,
} from "./flow.mjs";

const HELP = [
  "REE agents — headless steps for another bot. Existing pipeline commands stay as they are.",
  "",
  "node ree.mjs agents analyze --url URL --name NAME --out DIR [--json]",
  "node ree.mjs agents analyze --fixture DIR --out DIR [--json]",
  "node ree.mjs agents findings --run DIR [--json]",
  "node ree.mjs agents spec --run DIR [--json]",
  "node ree.mjs agents rebuild --spec FILE --name NAME --out DIR [--json]",
  "node ree.mjs agents verify --project DIR [--json]",
  "node ree.mjs agents package --project DIR [--json]",
  "node ree.mjs agents board-post --spec FILE --data DIR [--json]",
  "node ree.mjs agents mcp",
  "",
  "analyze reads a public document with outside-in. A fixture directory is the",
  "offline form of that read. It does not log in or fetch source. When no",
  "feature is recovered, the JSON says the page does not support a rebuild.",
  "rebuild, verify, and package are separate. board-post writes the local",
  "board. Guard, Blast, and Scale are not called.",
  "REE is built on morluto's REA engine (MIT).",
].join("\n");

export async function runAgentsCommand(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (argv[0] === "mcp") {
    const { serveAgentMcp } = await import("./mcp.mjs");
    await serveAgentMcp();
    return 0;
  }
  const json = argv.includes("--json");
  try {
    const value = await dispatch(argv);
    if (json) console.log(JSON.stringify(value, null, 2));
    else printText(value);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json)
      console.log(
        JSON.stringify(
          {
            schema_version: "ree.agent.v1",
            step: argv[0],
            ok: false,
            error: message,
          },
          null,
          2,
        ),
      );
    else console.error("REE: " + message);
    return 2;
  }
}

async function dispatch(argv) {
  const command = argv[0];
  if (command === "analyze")
    return analyzeForAgent({
      outDir: flag(argv, "--out"),
      url: flag(argv, "--url"),
      name: flag(argv, "--name"),
      fixtureDir: flag(argv, "--fixture"),
    });
  if (command === "findings") return readFindings(flag(argv, "--run"));
  if (command === "spec") return readSpec(flag(argv, "--run"));
  if (command === "rebuild")
    return rebuildForAgent({
      specPath: flag(argv, "--spec"),
      name: flag(argv, "--name"),
      outDir: flag(argv, "--out"),
    });
  if (command === "verify") return verifyForAgent(flag(argv, "--project"));
  if (command === "package") return packageForAgent(flag(argv, "--project"));
  if (command === "board-post")
    return postSpecToBoard({
      specPath: flag(argv, "--spec"),
      dataDir: flag(argv, "--data"),
    });
  throw new Error("Unknown agents command. Run node ree.mjs agents --help.");
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(name + " requires a value.");
  return value;
}

function printText(value) {
  const result = value.result ?? {};
  if (value.step === "analyze") {
    console.log(result.note);
    console.log("Spec " + result.spec_path);
    console.log("Findings " + result.findings_path);
    return;
  }
  if (value.step === "findings") {
    console.log(`Features ${result.features?.length ?? 0}`);
    return;
  }
  if (value.step === "spec") {
    console.log(`${result.target_name}: ${result.feature_count} features`);
    return;
  }
  if (value.step === "rebuild") {
    console.log("Rebuild " + result.build_id);
    console.log("Folder " + result.out_dir);
    return;
  }
  if (value.step === "verify") {
    console.log(
      `Implemented ${result.implemented}. Unimplemented ${result.unimplemented}. Failed ${result.failed}.`,
    );
    return;
  }
  if (value.step === "package") {
    console.log("Package " + result.package_path);
    return;
  }
  if (value.step === "board-post") {
    console.log(result.note);
  }
}
