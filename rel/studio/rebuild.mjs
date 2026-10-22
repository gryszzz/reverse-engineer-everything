import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { studioError } from "./errors.mjs";
import { assertDataDir } from "./projects.mjs";
import { graphFacts } from "./theater.mjs";

const OWNED_NATIVE = realpathSync(
  fileURLToPath(
    new URL("../../experiments/ree-investigation-boundary/", import.meta.url),
  ),
);
const NATIVE_PROBE = fileURLToPath(
  new URL(
    "../../scripts/verify/reconstruction/c-process-probe.mjs",
    import.meta.url,
  ),
);

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeName(file) {
  return file.replaceAll("/", "__");
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Module map the rebuild will write. It does not read or copy source text. */
export function rebuildPlan(record, output) {
  const destination = assertDataDir(output);
  if (existsSync(destination))
    throw studioError(
      "Choose a new output directory. A rebuild does not replace an existing folder.",
      409,
    );
  const evidenceId = record?.evidence_id;
  if (typeof evidenceId !== "string" || !evidenceId.startsWith("ev_"))
    throw studioError("That run has no Evidence to rebuild from.", 409);
  const facts = graphFacts(record);
  if (facts.modules.length === 0)
    throw studioError(
      "This Evidence record has no recovered JavaScript module identities. Nothing was written.",
      409,
    );
  const modules = facts.modules.map((module) => ({
    file: module.file,
    identity: "recovered",
    implementation: "reconstructed",
    verification: "unverified",
    imports: facts.imports
      .filter((edge) => edge.from === module.file)
      .map((edge) => edge.specifier),
  }));
  const files = [
    "README.md",
    "module-map.json",
    "graph.svg",
    "verify-map.test.mjs",
    ...modules.map((module) => `src/${safeName(module.file)}`),
  ];
  const body = { evidence_id: evidenceId, output: destination, modules, files };
  return {
    ...body,
    imports: facts.imports,
    digest: digest(body),
    statement:
      "Recovered identities come from Evidence. The files written here are reconstructed stubs with no copied source. Behavior is unverified.",
  };
}

function svg(modules, imports) {
  const height = Math.max(160, modules.length * 48 + 48);
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${height}" viewBox="0 0 760 ${height}">`,
    `<rect width="100%" height="100%" fill="#101318"/>`,
    `<text x="24" y="28" fill="#8eb0ff" font-size="14">Reconstructed module map. Edges are inferred imports from Evidence.</text>`,
  ];
  const y = new Map();
  modules.forEach((module, index) => {
    const top = 48 + index * 48;
    y.set(module.file, top);
    lines.push(
      `<rect x="24" y="${top}" width="240" height="36" rx="8" fill="#1e2531" stroke="#8eb0ff"/>`,
      `<text x="36" y="${top + 23}" fill="#e8eef6" font-size="13">${escapeXml(module.file)}</text>`,
    );
  });
  for (const edge of imports) {
    if (!edge.to || !y.has(edge.from) || !y.has(edge.to)) continue;
    const from = y.get(edge.from) + 18;
    const to = y.get(edge.to) + 18;
    lines.push(
      `<path d="M 264 ${from} C 320 ${from}, 320 ${to}, 400 ${to}" fill="none" stroke="#8eb0ff"/>`,
    );
  }
  lines.push("</svg>");
  return lines.join("\n");
}

function stub(module, evidenceId) {
  return [
    "// Reconstructed stub. No source text was copied from the analyzed artifact.",
    `// Evidence: ${evidenceId}`,
    `// Recovered identity: ${module.file}`,
    "// Implementation: reconstructed. Verification: unverified.",
    `export const moduleId = ${JSON.stringify(module.file)};`,
    `export const imports = ${JSON.stringify(module.imports)};`,
    "",
  ].join("\n");
}

function mapTest() {
  return [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import test from 'node:test';",
    "",
    "const map = JSON.parse(readFileSync(new URL('./module-map.json', import.meta.url), 'utf8'));",
    "",
    "test('stubs list the same imports as the Evidence module map', () => {",
    "  assert.equal(map.kind, 'ree-reconstructed-module-map');",
    "  assert.equal(map.behavior, 'unverified');",
    "  for (const module of map.modules) {",
    "    const name = module.file.replaceAll('/', '__');",
    "    const source = readFileSync(new URL('./src/' + name, import.meta.url), 'utf8');",
    "    assert.match(source, /No source text was copied/);",
    "    assert.match(source, /Verification: unverified/);",
    "    assert.equal(source.includes('function rank('), false);",
    "    assert.equal(source.includes('export const imports = ' + JSON.stringify(module.imports) + ';'), true);",
    "  }",
    "});",
    "",
  ].join("\n");
}

function readme(plan) {
  return [
    "# Reconstructed module map",
    "",
    plan.statement,
    "",
    `- Evidence: \`${plan.evidence_id}\``,
    "- Identity: recovered from the Evidence graph.",
    "- Implementation: reconstructed stubs. Source text was not copied.",
    "- Verification: unverified. The map test only checks that the stubs match this map.",
    "",
    "This is not a claim that the rebuilt files behave like the original program.",
    "",
  ].join("\n");
}

/** Write the previewed rebuild and run its map test. */
export function writeRebuild(record, output, expectedDigest) {
  const plan = rebuildPlan(record, output);
  if (plan.digest !== expectedDigest)
    throw studioError(
      "The rebuild preview changed. Open the preview again before writing.",
      409,
    );
  mkdirSync(join(plan.output, "src"), { recursive: true });
  const map = {
    kind: "ree-reconstructed-module-map",
    evidence_id: plan.evidence_id,
    behavior: "unverified",
    statement: plan.statement,
    modules: plan.modules,
    imports: plan.imports,
  };
  writeFileSync(join(plan.output, "README.md"), readme(plan));
  writeFileSync(
    join(plan.output, "module-map.json"),
    `${JSON.stringify(map, null, 2)}\n`,
  );
  writeFileSync(
    join(plan.output, "graph.svg"),
    svg(plan.modules, plan.imports),
  );
  writeFileSync(join(plan.output, "verify-map.test.mjs"), mapTest());
  for (const module of plan.modules)
    writeFileSync(
      join(plan.output, "src", safeName(module.file)),
      stub(module, plan.evidence_id),
    );
  const test = spawnSync(
    process.execPath,
    ["--test", join(plan.output, "verify-map.test.mjs")],
    { cwd: plan.output, encoding: "utf8", timeout: 20000 },
  );
  return {
    output: plan.output,
    evidence_id: plan.evidence_id,
    modules: plan.modules,
    behavior: "unverified",
    map_test: test.status === 0 ? "green" : "red",
    test_status: test.status,
    test_stdout: (test.stdout ?? "").slice(-2000),
    test_stderr: (test.stderr ?? "").slice(-2000),
  };
}

function insideRoot(root, candidate) {
  try {
    const resolved = realpathSync(candidate);
    return resolved === root || resolved.startsWith(`${root}${sep}`);
  } catch {
    return false;
  }
}

function textDiff(file, original, rebuilt) {
  const left = original.split("\n");
  const right = rebuilt.split("\n");
  const lines = [`--- original/${file}`, `+++ rebuilt/${file}`];
  let shown = 0;
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count && shown < 24; index += 1) {
    if (left[index] === right[index]) continue;
    if (index < left.length) {
      lines.push(`-${left[index].slice(0, 160)}`);
      shown += 1;
    }
    if (shown >= 24) break;
    if (index < right.length) {
      lines.push(`+${right[index].slice(0, 160)}`);
      shown += 1;
    }
  }
  lines.push(
    shown === 0
      ? "The displayed texts match. Engine verification is still unverified."
      : "Shown lines differ. The engine did not score behavioral match.",
  );
  return lines.join("\n");
}

/** Display-only comparison. It reads original text and does not write it. */
export function moduleComparisons(record, artifactPath) {
  let root;
  try {
    root = realpathSync(artifactPath);
  } catch {
    return [];
  }
  const evidenceId =
    typeof record?.evidence_id === "string" ? record.evidence_id : "unrecorded";
  const facts = graphFacts(record);
  return facts.modules.slice(0, 40).map((module) => {
    const rebuilt = stub(
      {
        file: module.file,
        imports: facts.imports
          .filter((edge) => edge.from === module.file)
          .map((edge) => edge.specifier),
      },
      evidenceId,
    );
    let original = null;
    const candidate = join(root, module.file);
    if (insideRoot(root, candidate)) {
      try {
        const text = readFileSync(realpathSync(candidate), "utf8");
        if (!text.includes("\0") && text.length <= 200_000)
          original = text.slice(0, 8000);
      } catch {
        original = null;
      }
    }
    const relation =
      original === null
        ? "unavailable"
        : original === rebuilt
          ? "same-text"
          : "different";
    return {
      file: module.file,
      identity: "recovered",
      implementation: "reconstructed",
      verification: "unverified",
      engine_match: "not-scored",
      text_relation: relation,
      original_excerpt: original
        ? original.split("\n").slice(0, 40).join("\n")
        : null,
      rebuilt_text: rebuilt,
      diff:
        relation === "different"
          ? textDiff(module.file, original, rebuilt)
          : null,
    };
  });
}

/** Timeline rows for a finished rebuild. They restate the write, not a new analysis. */
export function rebuildTimeline(result) {
  return [
    ...result.modules.slice(0, 40).map((module) => ({
      source: "rebuild",
      phase: "rebuild",
      file: module.file,
      identity: "recovered",
      implementation: "reconstructed",
      verification: "unverified",
      message: `Wrote reconstructed stub for ${module.file}. Identity recovered. Verification unverified.`,
    })),
    {
      source: "rebuild",
      phase: "map-test",
      message: `Map test ${result.map_test}. Behavior remains unverified.`,
      verification: "unverified",
    },
  ];
}

/** Timeline rows for verify-reconstruction claim statuses. */
export function claimTimeline(claims) {
  return claims.map((claim) => ({
    source: "verify-reconstruction",
    phase: "claim",
    verification: claim.status,
    message: `verify-reconstruction claim ${claim.name}: ${claim.status}. Scope ${claim.scope}.`,
  }));
}

/** The owned C fixture is the only native target this studio rebuilds. */
export function planOwnedNativeProbe(artifactPath, output) {
  let artifact;
  try {
    artifact = realpathSync(artifactPath);
  } catch {
    throw studioError("The native fixture path is not available.", 404);
  }
  if (artifact !== OWNED_NATIVE)
    throw studioError(
      "The native rebuild runs only for experiments/ree-investigation-boundary. Nothing was started.",
      409,
    );
  const destination = assertDataDir(output);
  if (existsSync(destination))
    throw studioError(
      "Choose a new output directory for the owned native probe.",
      409,
    );
  return {
    argv: [process.execPath, NATIVE_PROBE, destination],
    output: destination,
    executes: "owned-fixture-only",
    note: "This starts the existing owned C reconstruction probe. It compiles and captures that fixture. It does not analyze an arbitrary binary. Claim status comes from verify-reconstruction.",
  };
}

export function claimRows(summary) {
  const statuses = summary?.claim_statuses;
  if (!statuses || typeof statuses !== "object") return [];
  return Object.entries(statuses).map(([name, status]) => ({
    name,
    status:
      status === "pass" || status === "fail" || status === "unknown"
        ? status
        : "unknown",
    scope: "declared-claim-only",
  }));
}

/** Spawn the owned probe. The caller records its real output. */
export function spawnOwnedNativeProbe(plan, options = {}) {
  return spawn(plan.argv[0], plan.argv.slice(1), {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
    windowsHide: true,
  });
}
