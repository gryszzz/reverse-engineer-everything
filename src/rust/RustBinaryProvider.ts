import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { RustBinaryPort } from "../application/rust/RustBinaryPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  rustBinarySchema,
  type InspectRustBinaryInput,
  type RustBinary,
} from "../domain/rust/rustBinary.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { readRustBinaryImage } from "./RustBinaryImage.js";
import {
  RUST_BINARY_INPUT_BYTES,
  RUST_OUTPUT_BYTES,
  RustAuditableFormatFailure,
  RustAuditableResourceFailure,
} from "./RustAuditableReader.js";

/** Bundled reader identity. Embedded package versions are separate observed facts. */
export const RUST_BINARY_PROVIDER_IDENTITY = {
  id: "rust-auditable",
  name: "REA Rust dependency reader",
  version: "1",
} as const;
const OPERATION = "inspect_rust_binary";

/** Stable in-process dependency inspection without subprocesses, temporary files, or a Rust toolchain. */
export class RustBinaryProvider implements RustBinaryPort {
  readonly identity = RUST_BINARY_PROVIDER_IDENTITY;

  /** Read one dependency section and any inferred rustc commit from the selected file. */
  async inspect(
    input: InspectRustBinaryInput,
    options?: ExecutionOptions,
  ): Promise<Result<RustBinary, AnalysisError>> {
    try {
      const snapshot = await readStableArtifact(
        input.path,
        RUST_BINARY_INPUT_BYTES,
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      const image = readRustBinaryImage(snapshot.bytes);
      const report = {
        ...image,
        artifact: {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        },
        limitations: limitationsFor(image),
      };
      if (Buffer.byteLength(JSON.stringify(report), "utf8") > RUST_OUTPUT_BYTES)
        throw outputLimit(input.path);
      const parsed = rustBinarySchema.safeParse(report);
      if (!parsed.success)
        throw new AnalysisOutputError(
          OPERATION,
          "Rust reader produced an invalid dependency report.",
          { cause: parsed.error },
        );
      options?.signal?.throwIfAborted();
      return ok(parsed.data);
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, options?.signal));
    }
  }
}

const outputLimit = (path: string) =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "transport",
    `Complete Rust metadata for ${path} exceeds the inline output budget; no partial success is returned.`,
    { maximum_output_bytes: RUST_OUTPUT_BYTES },
  );

const limitationsFor = (
  image: ReturnType<typeof readRustBinaryImage>,
): string[] => [
  "Embedded dependency metadata is file content. It does not authenticate package names, versions, sources, or the compiler that produced the binary.",
  "Only the .dep-v0 dependency section and read-only compiler path strings are inspected. Functions, types, and runtime behavior are not recovered.",
  "Resource guards bound the selected file to 256 MiB, a dependency section to 1 MiB, inflated JSON to the smaller of 8 MiB and 64 times the section size, and the complete report to 8 MiB. Package and dependency counts are admitted against that output budget before schema cloning, graph objects, or reverse-edge allocation.",
  ...(image.auditable_metadata === null
    ? [
        "No .dep-v0 section was found. Absence of .dep-v0 does not mean the binary has no dependencies.",
      ]
    : []),
  ...(image.auditable_metadata?.packages.some((pkg) => pkg.kind === null)
    ? [
        "An omitted package kind is left null. The embedded format treats an omitted kind as runtime, and that default was not stored in the section.",
      ]
    : []),
  ...(image.auditable_metadata !== null &&
  image.auditable_metadata.cyclic_dependency_indices.length > 0
    ? [
        "Dependency indices contain a cycle. The cycle is reported and was not traversed.",
      ]
    : []),
  ...rustcLimitation(image.rustc_commit),
];

const rustcLimitation = (
  commit: ReturnType<typeof readRustBinaryImage>["rustc_commit"],
): string[] => {
  if (commit === null)
    return [
      "No /rustc/<40-hex>/ path was found in read-only data, so a rustc commit hash is unknown.",
    ];
  if (commit.hashes.length === 1)
    return [
      "The rustc commit hash is inferred from a /rustc/<40-hex>/ path in read-only data. It does not by itself prove which compiler produced the binary.",
    ];
  return [
    "Read-only data contains more than one /rustc/<40-hex>/ path, so a single rustc commit is unknown.",
  ];
};

const failureFor = (
  cause: unknown,
  path: string,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (signal?.aborted) return new AnalysisCancelledError(OPERATION);
  if (cause instanceof RustAuditableResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      cause.constraint.resource,
      `Selected artifact ${path}: ${cause.message}`,
      cause.constraint.reported_limits,
      { cause },
    );
  if (cause instanceof RustAuditableFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(OPERATION, path, cause.message, {
          cause,
        })
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected artifact ${path}: ${cause.message}`,
          },
        ]);
  return artifactFailure(cause, path);
};

const artifactFailure = (cause: unknown, path: string): AnalysisError => {
  if (cause instanceof ArtifactReaderFailure)
    return artifactReaderFailure(cause, path);
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(
        String(cause.code),
      )
    )
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected artifact could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(RUST_BINARY_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const artifactReaderFailure = (
  cause: ArtifactReaderFailure,
  path: string,
): AnalysisError => {
  if (cause.reason === "integrity")
    return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
      cause,
    });
  if (cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION);
  if (cause.reason === "limit")
    return new AnalysisResourceConstraintError(
      OPERATION,
      "file-size",
      cause.message,
      { maximum_input_bytes: RUST_BINARY_INPUT_BYTES },
      { cause },
    );
  if (cause.reason === "path")
    return new AnalysisInputError(OPERATION, { cause }, [
      { path: ["path"], reason: "invalid_format", message: cause.message },
    ]);
  return new ProviderAdapterError(RUST_BINARY_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: { path, reason: cause.message },
  });
};
