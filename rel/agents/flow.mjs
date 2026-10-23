import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeOutsideIn } from "../outside-in/analyze.mjs";
import { ingestSpec, listOpportunities } from "../opportunities/board.mjs";
import { packageRebuild, scaffoldRebuild } from "../rebuild/scaffold.mjs";
import { verifyRebuild } from "../rebuild/verify.mjs";

export const AGENT_SCHEMA = "ree.agent.v1";

const UNSUPPORTED =
  "This page does not support a rebuild. No feature was recovered, and none was invented.";

export async function analyzeForAgent({ outDir, url, name, fixtureDir }) {
  if (typeof outDir !== "string" || outDir.length === 0)
    throw new Error("An output directory is required.");
  mkdirSync(outDir, { recursive: true });
  const request = fixtureDir
    ? {
        ...JSON.parse(readFileSync(join(fixtureDir, "request.json"), "utf8")),
        fixtureDir,
        outDir,
        summarizerChoice: "none",
        minIntervalMs: 0,
      }
    : url && name
      ? {
          target: { name, urls: [url] },
          outDir,
          summarizerChoice: "none",
        }
      : null;
  if (!request)
    throw new Error("Use --url and --name, or --fixture DIR, plus --out DIR.");
  const result = await analyzeOutsideIn(request);
  const findings = writeFindings(outDir, result.spec);
  const rebuild =
    result.spec.status !== "refused" && findings.features.length > 0;
  return envelope("analyze", {
    out_dir: outDir,
    spec_path: join(outDir, "behavior-spec.json"),
    findings_path: join(outDir, "findings.json"),
    status: result.spec.status,
    feature_count: findings.features.length,
    rebuild,
    note: rebuild
      ? "Features were recovered from the public document. Quotes are not copied."
      : refusalNote(result.spec),
  });
}

export function readFindings(runDir) {
  return envelope("findings", readJson(runDir, "findings.json"));
}

export function readSpec(runDir) {
  const spec = readJson(runDir, "behavior-spec.json");
  return envelope("spec", {
    path: join(runDir, "behavior-spec.json"),
    schema_version: spec.schema_version,
    status: spec.status,
    target_name: spec.target?.name ?? null,
    feature_count: Array.isArray(spec.features) ? spec.features.length : 0,
    features: (spec.features ?? []).map((feature) => ({
      id: feature.id,
      name: feature.name,
    })),
    spec,
  });
}

export function rebuildForAgent({ specPath, name, outDir }) {
  if (!specPath || !name || !outDir)
    throw new Error("Use --spec FILE --name NAME --out DIR.");
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  if (!Array.isArray(spec.features) || spec.features.length === 0)
    throw new Error(UNSUPPORTED);
  const built = scaffoldRebuild({
    spec,
    productName: name,
    outDir,
    pack: false,
  });
  return envelope("rebuild", {
    build_id: built.build_id,
    out_dir: built.out_dir,
    feature_count: built.feature_count,
    implemented_count: built.implemented_count,
    unimplemented_count: built.unimplemented_count,
    package_path: built.package_path,
  });
}

export function verifyForAgent(projectDir) {
  if (!projectDir) throw new Error("Use --project DIR.");
  const result = verifyRebuild(projectDir);
  return envelope("verify", {
    implemented: result.implemented,
    unimplemented: result.unimplemented,
    failed: result.failed,
    total: result.total,
    exit_code: result.exit_code,
    features: (result.features ?? []).map((feature) => ({
      id: feature.id,
      match: feature.match,
    })),
  });
}

export function packageForAgent(projectDir) {
  if (!projectDir) throw new Error("Use --project DIR.");
  const archive = packageRebuild(projectDir);
  return envelope("package", { package_path: archive });
}

export function postSpecToBoard({ specPath, dataDir }) {
  if (!specPath || !dataDir) throw new Error("Use --spec FILE --data DIR.");
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  ingestSpec(dataDir, spec);
  const listed = listOpportunities(dataDir);
  const posted = listed.specs.find(
    (item) => item.target_name === spec.target?.name,
  );
  return envelope("board-post", {
    data_dir: dataDir,
    scout: listed.scout.length,
    specs: listed.specs.length,
    posted: posted
      ? {
          target_name: posted.target_name,
          features: posted.listing?.coverage?.features ?? null,
          note: posted.listing?.note ?? "A behavior spec has no market score.",
        }
      : null,
    note: "Posted to the local board. Guard was not called. Blast was not notified. Scale was not called.",
  });
}

function envelope(step, result) {
  return { schema_version: AGENT_SCHEMA, step, ok: true, result };
}

function readJson(dir, name) {
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`No ${name} in that run directory.`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeFindings(outDir, spec) {
  const findings = {
    schema_version: "ree.pipeline.findings.v1",
    source: "outside-in",
    status: spec.status,
    features: (spec.features ?? []).map((feature) => ({
      id: feature.id ?? null,
      name: feature.name ?? null,
      citations: feature.citations ?? [],
      citation_present: Array.isArray(feature.citations)
        ? feature.citations.length > 0
        : false,
    })),
    endpoints: (spec.api?.endpoints ?? []).map((endpoint) => ({
      method: endpoint.method ?? null,
      path: endpoint.path ?? null,
      operation_id: endpoint.operation_id ?? null,
    })),
  };
  writeFileSync(
    join(outDir, "findings.json"),
    JSON.stringify(findings, null, 2) + "\n",
  );
  return findings;
}

function refusalNote(spec) {
  const refusal = (spec.refusals ?? []).find(
    (item) => typeof item?.detail === "string" && item.detail.length > 0,
  );
  if (refusal) return `This page does not support a rebuild. ${refusal.detail}`;
  return UNSUPPORTED;
}
