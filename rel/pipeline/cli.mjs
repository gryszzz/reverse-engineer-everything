import { readFileSync } from "node:fs";
import { emitHandoff } from "../handoff/emit.mjs";
import {
  ingestScout,
  ingestSpec,
  listOpportunities,
} from "../opportunities/board.mjs";
import { scaffoldRebuild } from "../rebuild/scaffold.mjs";
import { verifyRebuild } from "../rebuild/verify.mjs";
import { runProductPipeline } from "./run.mjs";

const HELP = [
  "REE pipeline — investigation, a clean-room HTTP product, checks, and dry-run sell files.",
  "",
  "node ree.mjs pipeline TARGET --out DIR [--name NAME] [--json]",
  "  [--resume] [--authorized]",
  "  [--approve-launch] [--approve-guard] [--approve-blast]",
  "  [--approve-scale] [--approve-vault]",
  "node ree.mjs opportunities ingest FILE --out DIR [--json]",
  "node ree.mjs opportunities list --data DIR [--json]",
  "node ree.mjs rebuild --spec FILE --name NAME --out DIR [--json]",
  "node ree.mjs verify --project DIR [--json]",
  "node ree.mjs handoff --project DIR --blast-dir DIR [--scout FILE] [--json]",
  "",
  "pipeline runs scope, investigate, findings, spec, rebuild, verify, package,",
  "guard, and handoff. Each stage writes checkpoints/<stage>.json. A failed",
  "stage stops the run. --resume continues a run in the same --out directory.",
  "An owned fixture is a directory with request.json and manifest.json. No",
  "network request is made. A directory with no request.json needs --authorized",
  "and is static analysis only. It does not become a product spec.",
  "The default product name is REE Product. It must differ from the spec target.",
  "Launch and sell flags record approval. They do not call Guard, notify Blast,",
  "notify Scale, or copy into Vault. dry_run stays true.",
  "See docs/pipeline-contracts.md.",
  "ingest accepts a Scout target or a ree.outside-in.behavior-spec.v1 document.",
  "rebuild writes a new folder. It does not copy original code.",
  "verify runs the product tests. pass means the route ran. unimplemented means it was not built.",
  "handoff writes handoff.json, README.md, a Guard submission, a Scale manifest,",
  "and a Vault manifest. It does not notify Blast, call Guard, call Scale, or",
  "copy into Vault.",
  "On a machine with /home/box/shared, omit --blast-dir to use",
  "/home/box/shared/ree-to-blast/<build_id>/.",
].join("\n");

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(name + " requires a value.");
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function runPipelineCommand(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(HELP);
    return 0;
  }
  const json = argv.includes("--json");
  try {
    const command = argv[0];
    if (command === "opportunities" && argv[1] === "ingest") {
      const file = argv[2];
      const out = flag(argv, "--out");
      if (!file || file.startsWith("--") || !out)
        throw new Error("Use opportunities ingest FILE --out DIR.");
      const value = readJson(file);
      const board =
        value.schema_version === "ree.outside-in.behavior-spec.v1"
          ? ingestSpec(out, value)
          : ingestScout(out, value);
      const listed = listOpportunities(out);
      if (json) console.log(JSON.stringify(listed, null, 2));
      else console.log(`Board ${out} has ${board.items.length} item(s).`);
      return 0;
    }
    if (command === "opportunities" && argv[1] === "list") {
      const data = flag(argv, "--data");
      if (!data) throw new Error("Use opportunities list --data DIR.");
      const listed = listOpportunities(data);
      if (json) console.log(JSON.stringify(listed, null, 2));
      else {
        console.log(`Scout records: ${listed.scout.length}`);
        for (const item of listed.scout)
          console.log(
            `${item.target_name} total ${item.listing.scores.total}/25 confidence ${item.listing.confidence}`,
          );
        console.log(`Behavior specs: ${listed.specs.length}`);
        for (const item of listed.specs)
          console.log(
            `${item.target_name} features ${item.listing.coverage.features} (no market score)`,
          );
      }
      return 0;
    }
    if (command === "pipeline") {
      const target = argv[1];
      const out = flag(argv, "--out");
      const name = flag(argv, "--name");
      if (!target || target.startsWith("--") || !out)
        throw new Error("Use pipeline TARGET --out DIR [--name NAME].");
      const outcome = await runProductPipeline({
        target,
        outDir: out,
        productName: name,
        resume: argv.includes("--resume"),
        authorized: argv.includes("--authorized"),
        approvals: {
          launch: argv.includes("--approve-launch"),
          guard: argv.includes("--approve-guard"),
          blast: argv.includes("--approve-blast"),
          scale: argv.includes("--approve-scale"),
          vault: argv.includes("--approve-vault"),
        },
      });
      if (outcome.message) console.error("REE: " + outcome.message);
      if (json) console.log(JSON.stringify(outcome, null, 2));
      else if (!outcome.message) {
        console.log("Pipeline product " + outcome.product_name);
        console.log("Run " + outcome.run_id);
        console.log("Spec status " + outcome.spec_status);
        console.log(
          `Implemented ${outcome.implemented}. Unimplemented ${outcome.unimplemented}. Failed ${outcome.failed}.`,
        );
        console.log("Package " + outcome.package_path);
        console.log("Board " + outcome.board_dir);
        console.log("Handoff " + outcome.handoff_dir);
        console.log(
          "Stages " +
            outcome.stages
              .map((stage) => `${stage.id} ${stage.status}`)
              .join(", ") +
            ".",
        );
        console.log(
          "Dry run. Blast was not notified. Guard was not called. Scale was not called. Vault was not copied.",
        );
      }
      return outcome.code;
    }
    if (command === "rebuild") {
      const spec = flag(argv, "--spec");
      const name = flag(argv, "--name");
      const out = flag(argv, "--out");
      if (!spec || !name || !out)
        throw new Error("Use rebuild --spec FILE --name NAME --out DIR.");
      const built = scaffoldRebuild({
        spec: readJson(spec),
        productName: name,
        outDir: out,
      });
      if (json) console.log(JSON.stringify(built, null, 2));
      else {
        console.log("Rebuild " + built.build_id);
        console.log("Folder " + built.out_dir);
        console.log("Implemented routes: " + built.implemented_count);
        console.log("Unimplemented features: " + built.unimplemented_count);
        console.log("Package " + built.package_path);
        console.log("Original code was not read or copied.");
      }
      return 0;
    }
    if (command === "verify") {
      const project = flag(argv, "--project");
      if (!project) throw new Error("Use verify --project DIR.");
      const result = verifyRebuild(project);
      if (json)
        console.log(
          JSON.stringify(
            { ...result, stdout: undefined, stderr: undefined },
            null,
            2,
          ),
        );
      else {
        console.log(`Implemented ${result.implemented} of ${result.total}.`);
        console.log(
          `Unimplemented ${result.unimplemented}. Failed ${result.failed}.`,
        );
        console.log(
          "pass means the HTTP route test passed. unimplemented means the feature was not built.",
        );
        for (const feature of result.features)
          console.log(`${feature.match} ${feature.id}`);
      }
      return result.exit_code === 0 ? 0 : 1;
    }
    if (command === "handoff") {
      const project = flag(argv, "--project");
      const blast = flag(argv, "--blast-dir");
      const scoutPath = flag(argv, "--scout");
      if (!project)
        throw new Error(
          "Use handoff --project DIR [--blast-dir DIR] [--scout FILE].",
        );
      const verify = verifyRebuild(project);
      const emitted = emitHandoff({
        projectDir: project,
        verify,
        scout: scoutPath ? readJson(scoutPath) : null,
        blastDir: blast,
      });
      if (json)
        console.log(
          JSON.stringify(
            { directory: emitted.directory, dry_run: true },
            null,
            2,
          ),
        );
      else {
        console.log("Dry-run handoff: " + emitted.directory);
        console.log(
          "Blast was not notified. Guard was not called. Vault was not copied.",
        );
      }
      return verify.exit_code === 0 ? 0 : 1;
    }
    throw new Error("Unknown pipeline command.");
  } catch (error) {
    console.error("REE: " + error.message);
    return 2;
  }
}
