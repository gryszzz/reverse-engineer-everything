import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { boundedUtf8Text } from "../process/boundedUtf8Text.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisArtifactChangedError,
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { PrivateRuntimeRootUnavailableError } from "../process/PrivateRuntimeRootUnavailableError.js";
import { WABT_LIMITS, WABT_PROVIDER_IDENTITY } from "./WabtRelease.js";
const OUTPUT_LIMIT_EXCERPT_BYTES = 4096;
const OUTPUT_LIMIT_REASON = `WABT output exceeded the ${String(WABT_LIMITS.outputBytes)}-byte output budget`;
/** Past the output budget, retained text is a prefix of an oversized stream; keep a bounded excerpt of each. */
const outputLimitExcerpt = (snapshot: ProviderProcessSnapshot) => ({
  stdout: boundedUtf8Text(snapshot.stdout.text, OUTPUT_LIMIT_EXCERPT_BYTES)
    .text,
  stderr: boundedUtf8Text(snapshot.stderr.text, OUTPUT_LIMIT_EXCERPT_BYTES)
    .text,
  // The command reports output-limit only after retention was truncated.
  truncated: true,
  stdout_bytes: snapshot.stdout.bytes,
  stderr_bytes: snapshot.stderr.bytes,
  exit_code: snapshot.exitCode ?? null,
  signal: snapshot.signal ?? null,
});
/** Preserve lifecycle failures and diagnostic bytes instead of returning partial success. */
export const wabtFailure = (
  cause: unknown,
  phase: "configuration" | "artifact" | "producer",
  path: string,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const artifactCleanup =
    cause instanceof ArtifactReaderFailure ? cause.cleanup : undefined;
  const cleanupOptions =
    artifactCleanup === undefined ? {} : { cleanup: artifactCleanup };
  const reason = cause instanceof Error ? cause.message : String(cause);
  if (
    (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled") ||
    (cause instanceof Error && cause.name === "AbortError")
  )
    return new AnalysisCancelledError("inspect_wasm_artifact", {
      cause,
      ...cleanupOptions,
    });
  if (cause instanceof OwnedCommandFailure) {
    const capturedOutput =
      cause.snapshot === null
        ? undefined
        : cause.reason === "output-limit"
          ? outputLimitExcerpt(cause.snapshot)
          : {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated: cause.snapshot.diagnosticTruncated ?? false,
            };
    const options =
      capturedOutput === undefined ? { cause } : { cause, capturedOutput };
    if (cause.cleanupFailure !== null)
      return new ProviderCleanupError(
        WABT_PROVIDER_IDENTITY.id,
        cause.resources,
        {
          reason: cause.cleanupFailure,
          previous_error:
            cause.reason === "output-limit"
              ? {
                  failure_kind: "output-limit",
                  message: OUTPUT_LIMIT_REASON,
                  max_output_bytes: WABT_LIMITS.outputBytes,
                }
              : reason,
          ...(capturedOutput === undefined
            ? {}
            : { captured_output: capturedOutput }),
        },
        { operation: "inspect_wasm_artifact", cause },
      );
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError("inspect_wasm_artifact", options);
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(
        "inspect_wasm_artifact",
        WABT_LIMITS.timeoutMs,
        options,
      );
    if (phase !== "configuration" && cause.reason === "output-limit")
      return new AnalysisResourceConstraintError(
        "inspect_wasm_artifact",
        "memory",
        OUTPUT_LIMIT_REASON,
        { max_output_bytes: WABT_LIMITS.outputBytes },
        {
          ...options,
          remediationAction:
            "The WABT output budget is fixed, so retrying with the same input will fail the same way.",
        },
      );
    if (phase === "configuration" && cause.reason === "process")
      return new AnalysisCapabilityUnavailableError(
        WABT_PROVIDER_IDENTITY.id,
        "inspect_wasm_artifact",
        reason,
        {
          ...options,
          userMessage:
            "Configured WABT could not start. Check executable/interpreter access and WABT 1.0.42 profile; inspect retained diagnostics.",
        },
      );
    return new AnalysisOutputError("inspect_wasm_artifact", reason, options);
  }
  if (cause instanceof PrivateRuntimeRootUnavailableError)
    return new AnalysisCapabilityUnavailableError(
      WABT_PROVIDER_IDENTITY.id,
      "inspect_wasm_artifact",
      reason,
      { cause, retryable: cause.retryable },
    );
  if (phase === "configuration")
    return new AnalysisCapabilityUnavailableError(
      WABT_PROVIDER_IDENTITY.id,
      "inspect_wasm_artifact",
      reason,
      {
        cause,
        ...cleanupOptions,
        userMessage: `${reason} Supply WABT 1.0.42 via absolute REA_WABT_BIN_DIRECTORY; REA does not install tools.`,
      },
    );
  if (
    phase === "artifact" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      "inspect_wasm_artifact",
      path,
      reason,
      { cause, ...cleanupOptions },
    );
  if (
    phase === "artifact" &&
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EACCES" || cause.code === "EPERM")
  )
    return new AnalysisAccessDeniedError(
      "inspect_wasm_artifact",
      path,
      cause.code,
      { cause, ...cleanupOptions },
    );
  if (phase === "artifact")
    return new AnalysisInputError(
      "inspect_wasm_artifact",
      { cause, ...cleanupOptions },
      [{ path: ["path"], reason: "invalid_value", message: reason }],
    );
  return new AnalysisOutputError("inspect_wasm_artifact", reason, {
    cause,
    ...cleanupOptions,
  });
};
