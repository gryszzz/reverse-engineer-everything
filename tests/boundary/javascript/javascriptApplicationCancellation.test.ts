import { setImmediate } from "node:timers";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import {
  ArtifactResourceScope,
  type ArtifactResourceOwner,
} from "../../../src/artifacts/ArtifactResourceScope.js";
import { analyzeJavaScriptApplication as analyzeOwnedApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";

it.each(["during cleanup", "on the next control turn"] as const)(
  "retains the final source when cancellation arrives %s after analysis",
  async (timing) => {
    const root = await createTestTempDirectory("rea-js-cancel-handoff-");
    await writeFile(
      join(root, "main.js"),
      'import { readFile } from "node:fs/promises"; export { readFile };\n',
    );
    const controller = new AbortController();
    class CancellingCleanupScope extends ArtifactResourceScope {
      override async release(owner: ArtifactResourceOwner) {
        const result = await super.release(owner);
        if (owner.kind === "javascript-source-analysis") {
          if (timing === "during cleanup") controller.abort();
          else setImmediate(() => controller.abort());
        }
        return result;
      }
    }
    const scope = new CancellingCleanupScope();
    onTestFinished(() => scope.close());
    const result = await analyzeOwnedApplication(
      { input_path: root, format: "directory" },
      scope,
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Cancelled handoff must not succeed");
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("cancelled");
    const partial = z
      .object({
        details: z.object({
          partial_observation: z.object({
            normalized_result: javascriptApplicationAnalysisResultSchema,
          }),
        }),
      })
      .parse(projected).details.partial_observation.normalized_result;
    expect(partial.statistics).toMatchObject({
      relevant_files: 1,
      parsed_javascript_files: 1,
      parse_failures: 0,
    });
    expect(partial.graph.edges).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          specifier: "node:fs/promises",
          module_link_kind: "import",
        }),
      }),
    );
  },
);

it("preserves imported manifest status when cancelled before visiting manifests", async () => {
  const root = await createTestTempDirectory("rea-js-cancel-package-");
  const manifests = [
    ["valid", '{"version":"1.0.0"}', "included"],
    ["malformed", "{", "invalid"],
    ["non-object", "[]", "included"],
    ["unavailable", Buffer.from([0xff]), "unavailable"],
  ] as const;
  await Promise.all(
    manifests.map(async ([name, content]) => {
      const directory = join(root, "z", name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), content);
    }),
  );
  await writeFile(
    join(root, "a.cjs"),
    manifests
      .map(
        ([name], index) =>
          `const manifest${index} = require("./z/${name}/package.json");`,
      )
      .join("\n"),
  );
  await writeFile(join(root, "b.cjs"), "module.exports = 1;");
  const controller = new AbortController();
  const visited: string[] = [];
  const result = await analyzeJavaScriptApplication(
    { input_path: root, format: "directory" },
    {
      signal: controller.signal,
      progress: {
        async report(event) {
          if (event.phase !== "parse_javascript_source") return;
          visited.push(event.message);
          if (event.message.includes("b.cjs")) controller.abort();
        },
      },
    },
  );
  if (result.ok) throw new Error("Cancelled analysis must return a failure");
  const failure = projectAnalysisError(result.error);
  expect(failure.code).toBe("cancelled");
  expect(visited).toHaveLength(2);
  const { graph } = z
    .object({
      details: z.object({
        partial_observation: z.object({
          normalized_result: javascriptApplicationAnalysisResultSchema,
        }),
      }),
    })
    .parse(failure).details.partial_observation.normalized_result;
  for (const [name, , status] of manifests)
    expect(
      graph.edges.find(
        ({ properties }) =>
          properties.module_link_kind === "require" &&
          properties.specifier === `./z/${name}/package.json`,
      )?.properties,
    ).toMatchObject({
      resolution_status: "resolved",
      target_file_kind: "package-json",
      target_json_status: status,
    });
});

it("interrupts semantic graph commitment before result validation", async () => {
  const root = await createTestTempDirectory("rea-js-cancel-semantic-");
  await writeFile(
    join(root, "main.js"),
    Array.from(
      { length: 500 },
      (_, index) =>
        `export function inspect${index}(value) { return JSON.stringify(value); }`,
    ).join("\n"),
  );
  const controller = new AbortController();
  const phases: string[] = [];
  const result = await analyzeJavaScriptApplication(
    { input_path: root, format: "directory" },
    {
      signal: controller.signal,
      progress: {
        async report(event) {
          phases.push(event.phase);
          if (event.phase === "seal_javascript_semantic_graph")
            setImmediate(() => controller.abort());
        },
      },
    },
  );
  if (result.ok)
    throw new Error(
      "Cancelled commitment must not publish a successful analysis",
    );
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cancelled",
    details: { reason: "cancelled" },
  });
  expect(phases).toContain("seal_javascript_semantic_graph");
  expect(phases).not.toContain("validate_javascript_application_result");
});

it("honors control turns and cancellation while preparing one large source for owned analysis (#1462)", async () => {
  const root = await createTestTempDirectory("rea-js-cancel-in-file-");
  await writeFile(
    join(root, "index.js"),
    Array.from(
      { length: 1200 },
      (_, index) =>
        `export function f${index}(){return {name:'f${index}',value:${index}};}`,
    ).join("\n"),
  );
  const controller = new AbortController();
  const phases: string[] = [];
  let turns = 0;
  // Count event-loop turns once the file starts; parsing, analysis and
  // projection of this one file must leave room for them.
  const tick = (): void => {
    turns += 1;
    if (turns === 3) controller.abort();
    else if (!controller.signal.aborted) setImmediate(tick);
  };
  const result = await analyzeJavaScriptApplication(
    { input_path: root, format: "directory" },
    {
      signal: controller.signal,
      progress: {
        async report(event) {
          phases.push(event.phase);
          if (event.phase === "parse_javascript_source") setImmediate(tick);
        },
      },
    },
  );
  if (result.ok) throw new Error("Cancelled analysis must not succeed");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cancelled",
  });
  expect(phases).toContain("parse_javascript_source");
  expect(phases).not.toContain("build_javascript_application_graph");
});

it.each([
  "parse_javascript_source",
  "build_javascript_application_graph",
  "seal_javascript_application_graph",
  "build_javascript_semantic_graph",
  "seal_javascript_semantic_graph",
  "validate_javascript_application_result",
  "create_javascript_application_evidence",
  "seal_javascript_application_result",
  "validate_javascript_application_evidence",
  "hash_javascript_application_evidence",
])("rejects cancellation scheduled during %s", async (phase) => {
  const root = await createTestTempDirectory("rea-js-cancel-phase-");
  await writeFile(
    join(root, "main.js"),
    "export function inspect(value) { return JSON.stringify(value); }\n",
  );
  const controller = new AbortController();
  let requested = false;
  const terminal: string[] = [];
  const result = await analyzeJavaScriptApplication(
    { input_path: root, format: "directory" },
    {
      signal: controller.signal,
      progress: {
        async report(event) {
          if (event.terminal) terminal.push(event.phase);
          if (event.phase === phase) {
            requested = true;
            setImmediate(() => controller.abort());
          }
        },
      },
    },
  );
  expect(requested).toBe(true);
  if (result.ok) throw new Error("Cancelled analysis must return a failure");
  const failure = projectAnalysisError(result.error);
  expect(failure).toMatchObject({ code: "cancelled" });
  expect(failure).toMatchObject({
    details: {
      operation: "analyze_javascript_application",
      partial_observation: {
        normalized_result: {
          statistics: {
            relevant_files: 1,
            parsed_javascript_files:
              phase === "parse_javascript_source" ? 0 : 1,
            parse_failures: 0,
          },
        },
      },
    },
  });
  if (phase === "parse_javascript_source")
    expect(failure.details).toMatchObject({ cleanup: "complete" });
  expect(terminal).toEqual([]);
});

it("honors cancellation observed during the terminal publication race", async () => {
  const root = await createTestTempDirectory("rea-js-cancel-terminal-");
  await writeFile(join(root, "main.js"), "export const value = 1;\n");
  const controller = new AbortController();
  const result = await analyzeJavaScriptApplication(
    { input_path: root, format: "directory" },
    {
      signal: controller.signal,
      progress: {
        async report(event) {
          if (event.terminal) controller.abort();
        },
      },
    },
  );
  if (result.ok) throw new Error("Expected cancellation before admission");
  const failure = projectAnalysisError(result.error);
  expect(failure).toMatchObject({
    details: { reason: "cancelled" },
  });
  expect(failure).toMatchObject({
    details: {
      partial_observation: {
        normalized_result: {
          statistics: { relevant_files: 1, parsed_javascript_files: 1 },
        },
      },
    },
  });
});
