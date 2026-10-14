import { expect, it } from "vitest";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { RustBinary } from "../../domain/rust/rustBinary.js";
import { ok } from "../../domain/result.js";
import { RustBinaryService } from "./RustBinaryService.js";

const identity = {
  id: "fixture-rust",
  name: "Source-owned Rust reader seam",
  version: "1",
};
const report: RustBinary = {
  artifact: { path: "/artifacts/program", sha256: "a".repeat(64), bytes: 128 },
  format: "elf",
  architecture: "amd64",
  bits: 64,
  byte_order: "little",
  auditable_metadata: {
    section_name: ".dep-v0",
    file_offset: 16,
    section_bytes: 8,
    compressed_bytes: 8,
    uncompressed_bytes: 20,
    format_version: 1,
    packages: [
      {
        name: "sample",
        version: "0.1.0",
        source: "local",
        kind: null,
        dependencies: [],
        root: true,
      },
    ],
    root_package_index: 0,
    dependency_edges: [],
    cyclic_dependency_indices: [],
  },
  rustc_commit: null,
  limitations: [
    "No /rustc/<40-hex>/ path was found in read-only data, so a rustc commit hash is unknown.",
  ],
};

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new RustBinaryService({
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "program" });
  const extra = await service.inspect({
    path: report.artifact.path,
    detail: "complete",
  });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  if (!relative.ok) expect(relative.error).toBeInstanceOf(AnalysisInputError);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  expect(calls).toBe(0);
});

it("records the selected artifact and the dependency section range", async () => {
  const result = await new RustBinaryService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: { format: "elf", architecture: "x86_64" },
    normalized_result: report,
    locations: [
      { kind: "artifact-path", path: report.artifact.path },
      { kind: "file-offset-range", start: 16, end: 24 },
    ],
  });
  const mismatched: RustBinary = {
    ...report,
    artifact: { ...report.artifact, path: "/artifacts/other" },
  };
  const invalid = await new RustBinaryService({
    identity,
    inspect: () => Promise.resolve(ok(mismatched)),
  }).inspect({ path: report.artifact.path });
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error).toBeInstanceOf(AnalysisOutputError);
});

it("rejects a cycle claim the package dependencies do not contain", async () => {
  if (report.auditable_metadata === null) throw new Error("expected metadata");
  const invalidReport: RustBinary = {
    ...report,
    auditable_metadata: {
      ...report.auditable_metadata,
      cyclic_dependency_indices: [0],
    },
  };
  const result = await new RustBinaryService({
    identity,
    inspect: () => Promise.resolve(ok(invalidReport)),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it.each([
  { from_index: 1, to_index: 0 },
  { from_index: 0, to_index: 1 },
])("rejects provider edges referencing missing packages: %j", async (edge) => {
  if (report.auditable_metadata === null) throw new Error("expected metadata");
  const invalidReport: RustBinary = {
    ...report,
    auditable_metadata: {
      ...report.auditable_metadata,
      dependency_edges: [edge],
    },
  };
  const result = await new RustBinaryService({
    identity,
    inspect: () => Promise.resolve(ok(invalidReport)),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});
