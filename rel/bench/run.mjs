import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import {
  elfFindings,
  goFindings,
  javascriptFindings,
  ingestDocsFindings,
  outsideInFindings,
  peResourceFindings,
  rustFindings,
} from "./extract.mjs";
import { scoreFindings, scorePasses } from "./score.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
register(new URL("./fixture-loader.mjs", import.meta.url), {
  parentURL: import.meta.url,
});
const truthPath = join(repoRoot, "experiments/ree-bench/ground-truth.json");
const thresholdPath = join(repoRoot, "experiments/ree-bench/thresholds.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(args, env = process.env) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

function requireOk(child, label) {
  if (child.status === 0) return;
  const detail = `${child.stderr ?? ""}\n${child.stdout ?? ""}`.trim();
  throw new Error(`${label} failed (${child.status}): ${detail.slice(0, 800)}`);
}

function analyze(target, outDir) {
  const child = run([
    join(repoRoot, "ree.mjs"),
    "analyze",
    target,
    "--authorized",
    "--out",
    outDir,
    "--question",
    "Which modules, functions, imports, and strings are present?",
  ]);
  requireOk(child, `analyze ${target}`);
  return readJson(join(outDir, "evidence.json"));
}

function compileElf(source, destination, stripSymbols = false) {
  const child = spawnSync(
    "gcc",
    ["-nostdlib", "-static", "-O0", "-Wl,-e,entry", "-o", destination, source],
    { encoding: "utf8" },
  );
  requireOk(child, "gcc");
  if (stripSymbols) {
    const stripped = spawnSync("strip", ["--strip-all", destination], {
      encoding: "utf8",
    });
    requireOk(stripped, "strip");
  }
  return destination;
}

function inspectElf(binary) {
  const child = run(
    [
      join(repoRoot, "scripts/rea.mjs"),
      "inspect-binary-layout",
      binary,
      "--json",
    ],
    process.env,
  );
  const stdout = child.stdout ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  if (parsed?.code === "provider_unavailable") {
    return {
      blocked: parsed.message ?? "Binary layout provider is unavailable.",
    };
  }
  requireOk(child, "inspect-binary-layout");
  if (!parsed) throw new Error("inspect-binary-layout did not return JSON.");
  return { record: parsed };
}

async function packArchive(directory, destination) {
  await createPackage(directory, destination);
  return destination;
}

function finish(spec, extracted, thresholds) {
  const scores = scoreFindings(spec.expected, extracted.findings);
  const failures = [
    ...scorePasses(scores, thresholds),
    ...extracted.provenance.map(
      (item) =>
        `${item.type} ${item.key} provenance: ${item.problems.join("; ")}`,
    ),
  ];
  if (
    typeof spec.require_note === "string" &&
    !extracted.notes.some((note) => note.includes(spec.require_note))
  )
    failures.push(`missing required note: ${spec.require_note}`);
  return {
    id: spec.id,
    kind: spec.kind,
    scores,
    notes: extracted.notes,
    provenance: extracted.provenance,
    failures,
    passed: failures.length === 0,
  };
}

function parseEngineJson(stdout) {
  const text = stdout.trim();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("\n{");
    if (start === -1) return null;
    try {
      return JSON.parse(text.slice(start + 1));
    } catch {
      return null;
    }
  }
}

function inspectEngine(command, binary) {
  const child = run(
    [join(repoRoot, "scripts/rea.mjs"), command, binary, "--json"],
    { ...process.env, REA_LOG_LEVEL: "silent" },
  );
  return {
    status: child.status,
    parsed: parseEngineJson(child.stdout ?? ""),
    stderr: child.stderr ?? "",
  };
}

function messageFrom(inspected) {
  const parsed = inspected.parsed;
  const parts = [
    parsed?.message,
    parsed?.code,
    parsed?.details?.issues?.map((issue) => issue.message).join(" "),
    inspected.stderr,
  ].filter((part) => typeof part === "string" && part.trim() !== "");
  return parts.join(" ").replace(/\s+/gu, " ").trim();
}

function emptyExtracted(note) {
  return {
    findings: {
      module: [],
      function: [],
      import: [],
      call: [],
      endpoint: [],
      string: [],
      behavior: [],
      resource: [],
    },
    provenance:
      note == null
        ? [
            {
              type: "function",
              key: "silence",
              problems: ["the provider returned no message"],
            },
          ]
        : [],
    notes: note == null ? [] : [note],
  };
}

async function nativeFixtures() {
  const [go, rust, pe] = await Promise.all([
    import("../../tests/fixtures/go/image.ts"),
    import("../../tests/fixtures/rust/image.ts"),
    import("../../src/native/pe/PeResources.fixture.ts"),
  ]);
  return { go, rust, pe };
}

function writeBytes(work, name, bytes) {
  const path = join(work, name);
  writeFileSync(path, bytes);
  return path;
}

/** One-architecture fat Mach-O. Go and Rust readers must refuse it as a slice. */
function fatMachOBytes() {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(1, 4);
  bytes.writeUInt32BE(0x01000007, 8);
  bytes.writeUInt32BE(3, 12);
  bytes.writeUInt32BE(32, 16);
  bytes.writeUInt32BE(32, 20);
  bytes.writeUInt32LE(0xfeedfacf, 32);
  return bytes;
}

async function nativeCase(spec, work) {
  const fixtures = await nativeFixtures();
  if (spec.kind === "go") {
    const image = fixtures.go.createGoBinaryFixture({
      format: spec.format,
      omitBuildInfo: spec.omit_build_info === true,
    });
    const inspected = inspectEngine(
      "inspect-go-binary",
      writeBytes(work, "go.bin", image.bytes),
    );
    if (inspected.parsed?.evidence_id) return goFindings(inspected.parsed);
    return emptyExtracted(
      messageFrom(inspected)
        ? `partial: ${messageFrom(inspected).slice(0, 500)}`
        : null,
    );
  }
  if (spec.kind === "rust") {
    const inspected = inspectEngine(
      "inspect-rust-binary",
      writeBytes(
        work,
        "rust.bin",
        fixtures.rust.createRustImage({ format: spec.format }),
      ),
    );
    if (inspected.parsed?.evidence_id) return rustFindings(inspected.parsed);
    return emptyExtracted(
      messageFrom(inspected)
        ? `partial: ${messageFrom(inspected).slice(0, 500)}`
        : null,
    );
  }
  if (spec.kind === "pe-resources") {
    const inspected = inspectEngine(
      "inspect-pe-resources",
      writeBytes(work, "resources.exe", fixtures.pe.peResourceFixture().bytes),
    );
    if (inspected.parsed?.evidence_id)
      return peResourceFindings(inspected.parsed);
    return emptyExtracted(
      messageFrom(inspected)
        ? `partial: ${messageFrom(inspected).slice(0, 500)}`
        : null,
    );
  }
  if (spec.kind === "macho-host") {
    const inspected = inspectEngine(
      "inspect-macho",
      writeBytes(
        work,
        "thin.macho",
        fixtures.go.createGoBinaryFixture({ format: "macho" }).bytes,
      ),
    );
    const message = messageFrom(inspected);
    if (inspected.parsed?.evidence_id) {
      return emptyExtracted(
        "partial: inspect-macho returned a record. Names from this owned image are not handwritten symbol ground truth, so they are not scored.",
      );
    }
    if (message === "") return emptyExtracted(null);
    return emptyExtracted(`partial: ${message.slice(0, 500)}`);
  }
  const bytes =
    spec.sample === "fat"
      ? fatMachOBytes()
      : Buffer.from("This is not an executable container.");
  const inspected = inspectEngine(
    spec.command,
    writeBytes(work, "sample.bin", bytes),
  );
  const message = messageFrom(inspected);
  if (inspected.parsed?.evidence_id)
    return emptyExtracted(
      "partial: the provider returned Evidence for a sample that has no scored findings.",
    );
  if (message === "") return emptyExtracted(null);
  const code = inspected.parsed?.code ?? "provider";
  return emptyExtracted(`unsupported: ${code} ${message}`.slice(0, 500));
}

async function runCase(spec, thresholds) {
  const work = mkdtempSync(join(tmpdir(), "ree-bench-"));
  try {
    if (spec.kind === "javascript" || spec.kind === "archive") {
      const target =
        spec.kind === "archive"
          ? await packArchive(
              join(repoRoot, spec.members),
              join(work, "app.asar"),
            )
          : join(repoRoot, spec.target);
      const record = analyze(target, join(work, "out"));
      return finish(spec, javascriptFindings(record), thresholds);
    }
    if (spec.kind === "outside-in") {
      const outDir = join(work, "out");
      const child = run([
        join(repoRoot, "ree.mjs"),
        "outside-in",
        "--request",
        join(repoRoot, spec.request),
        "--fixture",
        join(repoRoot, spec.fixture),
        "--out",
        outDir,
        "--json",
      ]);
      requireOk(child, "outside-in");
      const extracted = outsideInFindings(
        JSON.parse(child.stdout),
        join(repoRoot, spec.fixture),
      );
      return finish(spec, extracted, thresholds);
    }
    if (spec.kind === "ingest-docs") {
      const outDir = join(work, "out");
      const child = run([
        join(repoRoot, "ree.mjs"),
        "ingest-docs",
        join(repoRoot, spec.docs),
        "--name",
        spec.name,
        "--out",
        outDir,
        "--json",
      ]);
      requireOk(child, "ingest-docs");
      const extracted = ingestDocsFindings(
        JSON.parse(child.stdout),
        join(repoRoot, spec.docs),
      );
      return finish(spec, extracted, thresholds);
    }
    if (spec.kind === "elf") {
      const binary = compileElf(
        join(repoRoot, spec.source),
        join(work, "fixture"),
        spec.strip === true,
      );
      const inspected = inspectElf(binary);
      if (inspected.blocked) {
        return {
          id: spec.id,
          kind: spec.kind,
          scores: null,
          notes: [inspected.blocked],
          provenance: [],
          failures: [`native layout blocked: ${inspected.blocked}`],
          passed: false,
        };
      }
      return finish(spec, elfFindings(inspected.record), thresholds);
    }
    if (
      spec.kind === "go" ||
      spec.kind === "rust" ||
      spec.kind === "pe-resources" ||
      spec.kind === "macho-host" ||
      spec.kind === "provider-message"
    )
      return finish(spec, await nativeCase(spec, work), thresholds);
    throw new Error(`Unknown bench kind ${spec.kind}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function runBench({ only } = {}) {
  const truth = readJson(truthPath);
  const thresholds = readJson(thresholdPath);
  const selected = truth.cases.filter((spec) => !only || spec.id === only);
  if (selected.length === 0) throw new Error(`No bench case named ${only}.`);
  const cases = [];
  for (const spec of selected) {
    cases.push(await runCase(spec, thresholds[spec.id] ?? {}));
  }
  return {
    schema_version: "ree.bench.v1",
    passed: cases.every((item) => item.passed),
    cases,
  };
}

function ratio(value) {
  return value == null ? "n/a" : value.toFixed(2);
}

export function formatBench(result) {
  const lines = [
    "REE accuracy bench",
    "",
    "case\ttype\tprecision\trecall\texpected\tfound\tfalse claims",
  ];
  for (const item of result.cases) {
    if (!item.scores) {
      lines.push(`${item.id}\tblocked\t\t\t\t\t${item.failures.join(" ")}`);
      continue;
    }
    for (const [type, score] of Object.entries(item.scores)) {
      if (score.expected === 0 && score.found === 0) continue;
      lines.push(
        [
          item.id,
          type,
          ratio(score.precision),
          ratio(score.recall),
          score.expected,
          score.found,
          score.false_claims.length,
        ].join("\t"),
      );
    }
    for (const note of item.notes) lines.push(`note\t${item.id}\t${note}`);
    for (const failure of item.failures)
      lines.push(`fail\t${item.id}\t${failure}`);
  }
  lines.push("", result.passed ? "passed" : "failed");
  return lines.join("\n");
}
