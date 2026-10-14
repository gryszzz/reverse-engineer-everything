import { resolve } from "node:path";

import { JAVASCRIPT_APPLICATION_PROVIDER } from "../application/InvestigationProviders.js";
import { writeTextParts } from "../application/JsonFiles.js";
import { createProgressReporter } from "../application/ProgressReporter.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { inspectAnalysisViewValidated } from "../application/analysisView/AnalysisViewService.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { parseEvidence } from "../domain/evidence.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { canonicalJsonParts } from "../domain/jsonSerialization.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

/** Execute the shared one-shot CLI boundary for static JavaScript analysis. */
export const runCliJavaScriptApplicationAnalysis = async (
  input: unknown,
  signal?: AbortSignal,
  output: { readonly summary?: boolean; readonly evidenceOut?: string } = {},
): Promise<JsonValue> => {
  if (output.summary === true && output.evidenceOut === undefined)
    return cliError(
      new AnalysisInputError("analyze_javascript_application", undefined, [
        {
          path: ["evidence_out"],
          reason: "missing_argument",
          message:
            "--summary requires --evidence-out to preserve the complete Evidence.",
        },
      ]),
    );
  const { analyzeJavaScriptApplication } =
    await import("../application/javascript/JavaScriptApplicationService.js");
  const progress = createProgressReporter(
    async (update) => {
      process.stderr.write(`${JSON.stringify({ rea_progress: update })}\n`);
    },
    { minimumIntervalMs: 0 },
  );
  const resources = new ArtifactResourceScope();
  const result = await analyzeJavaScriptApplication(input, resources, {
    progress,
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    await resources.close();
  } catch (cause: unknown) {
    const cleanup = ArtifactReaderFailure.cleanupObservation(
      cause,
      "JavaScript application resources",
    );
    const failure = new ProviderCleanupError(
      JAVASCRIPT_APPLICATION_PROVIDER.id,
      cleanup.resources,
      { reason: cleanup.reason },
      { cause, operation: "analyze_javascript_application" },
    );
    return cliError(
      result.ok
        ? failure
        : analysisErrorWithCleanupFailure(
            result.error,
            failure,
            "analyze_javascript_application",
          ),
    );
  }
  if (!result.ok) return cliError(result.error);
  if (output.summary !== true && output.evidenceOut === undefined)
    return result.value;
  let evidence: ReturnType<typeof parseEvidence>;
  try {
    evidence = parseEvidence(result.value);
  } catch (cause: unknown) {
    return cliError(
      new EvidenceIntegrityError(
        `JavaScript analysis did not return complete Evidence: ${String(cause)}`,
        { cause },
      ),
    );
  }
  if (output.evidenceOut !== undefined) {
    const outputResources = new ArtifactResourceScope();
    const written = await writeTextParts(
      canonicalJsonParts(evidence),
      resolve(output.evidenceOut),
      false,
      outputResources,
      signal === undefined
        ? undefined
        : { signal, operation: "analyze_javascript_application" },
    );
    let cleanupError: unknown;
    try {
      await outputResources.close();
    } catch (cause: unknown) {
      cleanupError = cause;
    }
    if (!written.ok) return cliError(written.error);
    if (cleanupError !== undefined)
      return cliError(
        new ProviderCleanupError(
          JAVASCRIPT_APPLICATION_PROVIDER.id,
          ["Evidence output staging"],
          { reason: String(cleanupError) },
          { cause: cleanupError, operation: "analyze_javascript_application" },
        ),
      );
  }
  if (output.summary !== true) return result.value;
  const summary = inspectAnalysisViewValidated({
    source: { kind: "inline", evidence },
    view: { kind: "summary" },
  });
  return summary.ok ? summary.value : cliError(summary.error);
};

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "JavaScript application analysis failed",
  ...projectAnalysisError(error),
});
