import { z } from "incur";

import { inspectAnalysisViewValidated } from "../application/analysisView/AnalysisViewService.js";
import { readEvidenceBundle } from "../application/EvidenceBundleFiles.js";
import { inspectEvidenceBundle } from "../application/investigation/InspectEvidenceBundle.js";
import {
  getEvidenceBundleInputSchema,
  importEvidenceBundleInputSchema,
} from "../contracts/sessionToolSchemas.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { parseEvidence } from "../domain/evidence.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";

import { inspectAnalysisViewInputSchema } from "../domain/analysisView/analysisView.js";
/** Project selected views of completed analysis Evidence through the CLI. */
export const registerAnalysisViewCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectEvidenceBundle, {
    description:
      "Inspect complete or selected discovery metadata from a local Evidence bundle",
    args: z.object({
      inputJson: z
        .string()
        .describe(
          "JSON or JSON file with absolute path, detail and optional record filters",
        ),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.inspectEvidenceBundle, async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          CLI_COMMANDS.inspectEvidenceBundle,
        );
        if (!input.ok) return input.error;
        const schema = getEvidenceBundleInputSchema.safeExtend({
          path: importEvidenceBundleInputSchema.shape.path,
        });
        const parsed = schema.safeParse(input.value);
        if (!parsed.success)
          return {
            error: "Evidence bundle inspection failed",
            ...projectAnalysisError(
              analysisInputErrorFromIssues(
                CLI_COMMANDS.inspectEvidenceBundle,
                parsed.error.issues,
                input.value,
              ),
            ),
          };
        const loaded = await readEvidenceBundle(parsed.data.path);
        if (!loaded.ok)
          return {
            error: "Evidence bundle inspection failed",
            ...projectAnalysisError(loaded.error),
          };
        const result = inspectEvidenceBundle(loaded.value, parsed.data);
        return result.ok
          ? result.value
          : {
              error: "Evidence bundle inspection failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
  cli.command(CLI_COMMANDS.inspectAnalysisView, {
    description:
      "Project a selected view of completed layout, JavaScript application or native function Evidence JSON",
    args: z.object({
      inputJson: z.string().describe("Inline workflow JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.inspectAnalysisView, async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          CLI_COMMANDS.inspectAnalysisView,
        );
        if (!input.ok) return input.error;
        const normalized = await resolveCliEvidenceFile(input.value);
        if (!normalized.ok) return normalized.error;
        const parsed = inspectAnalysisViewInputSchema.safeParse(
          normalized.value,
        );
        if (!parsed.success)
          return {
            error: "Application workflow failed",
            ...projectAnalysisError(
              analysisInputErrorFromIssues(
                CLI_COMMANDS.inspectAnalysisView,
                parsed.error.issues,
                normalized.value,
              ),
            ),
          };
        const result = inspectAnalysisViewValidated(parsed.data);
        return result.ok
          ? jsonValueSchema.parse(result.value)
          : {
              error: "Application workflow failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
};

/** Resolve the CLI-only file reference without widening the MCP contract. */
const resolveCliEvidenceFile = async (
  input: unknown,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: JsonValue }
> => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { ok: true, value: input };
  const source = Reflect.get(input, "source");
  if (typeof source !== "object" || source === null || Array.isArray(source))
    return { ok: true, value: input };
  if (Reflect.get(source, "kind") !== "evidence-file")
    return { ok: true, value: input };
  const path = Reflect.get(source, "path");
  if (typeof path !== "string" || path.length === 0)
    return { ok: true, value: input };
  const loaded = await parseCliJsonInput(
    path,
    CLI_COMMANDS.inspectAnalysisView,
  );
  if (!loaded.ok) return loaded;
  try {
    const evidence = parseEvidence(loaded.value);
    return {
      ok: true,
      value: { ...input, source: { kind: "inline", evidence } },
    };
  } catch {
    return {
      ok: false,
      error: {
        error: "Application workflow failed",
        ...projectAnalysisError(
          new AnalysisInputError(CLI_COMMANDS.inspectAnalysisView, undefined, [
            {
              path: ["source", "path"],
              reason: "invalid_value",
              message:
                "Saved Evidence file is not a valid complete Evidence record.",
            },
          ]),
        ),
      },
    };
  }
};
