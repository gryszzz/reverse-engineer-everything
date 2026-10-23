import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectRoute } from "./analysis.mjs";
import { assessRoutes, artifactFamily } from "./engine-routes.mjs";
import { narrateEvidence } from "./narrative.mjs";
import { projectEngineGraph } from "./engine-window.mjs";
import { approveSetup, setupOffers } from "./setup-offers.mjs";
import { safeUploadRelative, writeUpload } from "./uploads.mjs";

const facts = {
  platform: "linux",
  arch: "x64",
  runtime: true,
  evmole: true,
  java: true,
  objdump: true,
  otool: false,
  lipo: false,
  brew: false,
  apktool: { state: "missing", source: "path" },
  wabt: { state: "unset" },
  jadx: "unset",
  pwntools: "unset",
  ghidra: "unset",
};

function status(id, patch = {}) {
  return assessRoutes({ ...facts, ...patch }).find((route) => route.id === id)
    .status;
}

test("route status follows the engine contract instead of PATH guesses", () => {
  assert.equal(status("javascript-static"), "ready");
  assert.equal(status("pe-resources"), "ready");
  assert.equal(status("javascript-static", { runtime: false }), "missing-tool");
  assert.equal(status("wasm"), "not-configured");
  assert.equal(status("wasm", { wabt: { state: "ready" } }), "ready");
  assert.equal(
    status("wasm", { wabt: { state: "incomplete", missing: ["wasm2wat"] } }),
    "missing-tool",
  );
  assert.equal(status("evm"), "ready");
  assert.equal(status("evm", { evmole: false }), "missing-tool");
  assert.equal(status("android-package"), "not-configured");
  assert.equal(status("android-package", { jadx: "ready" }), "ready");
  assert.equal(
    status("android-package", { jadx: "ready", java: false }),
    "missing-tool",
  );
  assert.equal(status("android-apktool"), "missing-tool");
  assert.equal(
    status("android-apktool", { apktool: { state: "ready", source: "path" } }),
    "ready",
  );
  assert.equal(status("elf-layout"), "not-configured");
  assert.equal(status("elf-layout", { platform: "darwin" }), "unsupported");
  assert.equal(status("elf-layout", { pwntools: "ready" }), "ready");
  assert.equal(status("macho"), "unsupported");
  assert.equal(
    status("macho", { platform: "darwin", otool: true, lipo: true }),
    "ready",
  );
  assert.equal(status("objdump-headers"), "ready");
  assert.equal(status("objdump-headers", { objdump: false }), "missing-tool");
  assert.equal(status("ghidra"), "not-configured");
  assert.equal(status("ghidra", { ghidra: "ready" }), "ready");
  assert.equal(status("rizin"), "unsupported");
  assert.equal(status("radare2"), "unsupported");
  assert.equal(status("go-binary"), "ready");
  assert.equal(status("rust-binary"), "ready");
  assert.equal(status("go-binary", { runtime: false }), "missing-tool");
  assert.equal(status("java-class"), "unsupported");
  assert.match(
    assessRoutes(facts).find((route) => route.id === "java-class").detail,
    /partial/,
  );
  const radare = assessRoutes(facts).find((route) => route.id === "radare2");
  assert.match(radare.detail, /no radare2 provider/);
  const wabt = assessRoutes(facts).find((route) => route.id === "wasm");
  assert.match(wabt.detail, /does not install WABT/);
});

test("an applicable route with no runtime reports missing-tool and starts nothing", () => {
  const directory = mkdtempSync(join(tmpdir(), "ree-missing-runtime-"));
  const target = join(directory, "app.js");
  writeFileSync(target, "export const value = 1;\n");
  try {
    assert.throws(
      () =>
        selectRoute({ path: target, intake: { kind: "javascript" } }, null, {
          ...facts,
          runtime: false,
        }),
      /JavaScript \/ Electron \/ ASAR is missing-tool[\s\S]*Nothing was started/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("family detection uses headers and does not treat every binary as EVM", () => {
  const directory = mkdtempSync(join(tmpdir(), "ree-family-"));
  const wasm = join(directory, "mod.bin");
  const elf = join(directory, "a.out");
  const pe = join(directory, "a.exe");
  writeFileSync(
    wasm,
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  );
  writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
  writeFileSync(pe, Buffer.from("MZ"));
  assert.equal(artifactFamily(wasm, "unknown"), "wasm");
  assert.equal(artifactFamily(elf, "native"), "elf");
  assert.equal(artifactFamily(pe, "native"), "pe");
  assert.equal(
    artifactFamily(join(directory, "carrier.hex"), "unknown"),
    "evm",
  );
  rmSync(directory, { recursive: true, force: true });
});

test("narratives and icon edges quote stored Evidence fields", () => {
  const evidenceId = `ev_${"a".repeat(64)}`;
  const record = {
    evidence_id: evidenceId,
    provider: {
      id: "rea-pe-resources",
      name: "REA PE resource parser",
      version: "1",
    },
    operation: "inspect_pe_resources",
    limitations: ["Payloads other than icon groups stay opaque."],
    normalized_result: {
      format: "pe32",
      artifact: { bytes: 4, sha256: "b".repeat(64) },
      coverage: { status: "complete", examined_entries: 2, resources: 2 },
      resources: [
        { type: { kind: "id", id: 14 }, name: { kind: "id", id: 1 } },
        { type: { kind: "id", id: 3 }, name: { kind: "id", id: 1 } },
      ],
      icon_groups: [
        {
          resource_index: 0,
          images: [{ candidate_resource_indices: [1] }],
        },
      ],
    },
  };
  const narrative = narrateEvidence(record);
  assert.ok(
    narrative.statements.every((item) => item.evidence_id === evidenceId),
  );
  assert.match(
    narrative.statements.map((item) => item.text).join("\n"),
    /pe32/,
  );
  assert.ok(narrative.unknowns.some((item) => /Entry points/.test(item)));
  const graph = projectEngineGraph(record, { find: "", limit: 20 });
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].relation, "candidate_resource_indices");
  assert.equal(graph.edges[0].basis, "derived");
  assert.equal(graph.provider.id, "rea-pe-resources");
  const empty = projectEngineGraph(
    {
      evidence_id: evidenceId,
      provider: { id: "gnu.objdump", name: "GNU objdump", version: null },
      operation: "inspect_with_objdump",
      normalized_result: { stdout: "headers" },
    },
    { find: "", limit: 20 },
  );
  assert.equal(empty.edges.length, 0);
  assert.match(empty.execution_note, /gnu.objdump/);
});

test("setup approval rejects a mismatched or unapproved command before argv is returned", () => {
  const catalog = setupOffers({
    platform: "darwin",
    brew: true,
    apktoolReady: false,
  });
  const offer = catalog.offers[0];
  assert.deepEqual(offer.argv, ["brew", "install", "apktool"]);
  assert.equal(offer.available, true);
  assert.throws(
    () =>
      approveSetup({
        offerId: "apktool",
        approved: false,
        commandDigest: offer.command_digest,
        catalog,
      }),
    /approved: true/,
  );
  assert.throws(
    () =>
      approveSetup({
        offerId: "apktool",
        approved: true,
        commandDigest: "different",
        catalog,
      }),
    /exact argv/,
  );
  assert.deepEqual(
    approveSetup({
      offerId: "apktool",
      approved: true,
      commandDigest: offer.command_digest,
      catalog,
    }),
    ["brew", "install", "apktool"],
  );
  const linux = setupOffers({
    platform: "linux",
    brew: true,
    apktoolReady: false,
  });
  assert.equal(linux.offers[0].available, false);
  assert.throws(
    () =>
      approveSetup({
        offerId: "apktool",
        approved: true,
        commandDigest: linux.offers[0].command_digest,
        catalog: linux,
      }),
    /not run on this host/,
  );
  assert.match(
    linux.guidance.map((item) => item.text).join("\n"),
    /does not install WABT/,
  );
});

test("dropped paths cannot escape the upload directory", () => {
  assert.throws(
    () => safeUploadRelative("../secret"),
    /inside the upload folder/,
  );
  assert.throws(
    () => safeUploadRelative("/etc/passwd"),
    /inside the upload folder/,
  );
  const directory = mkdtempSync(join(tmpdir(), "ree-upload-"));
  const saved = writeUpload({
    directory,
    batchId: null,
    name: "empty.wasm",
    relative: null,
    bytes: Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  });
  assert.equal(saved.classifyPath, saved.path);
  assert.match(saved.batchId, /^up_[a-f0-9]{16}$/u);
  rmSync(directory, { recursive: true, force: true });
});
