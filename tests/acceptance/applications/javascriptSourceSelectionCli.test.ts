import { createPackageWithOptions } from "@electron/asar";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { writeJavaScriptSourceSelectionFixture } from "../../fixtures/javascriptSourceSelection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for([
  { format: "directory", command: "analyze" },
  { format: "asar", command: "analyze-javascript-application" },
])(
  "analyzes selected $format sources through $command with complete artifact identity",
  { timeout: 60_000 },
  async ({ format, command }, { cli }) => {
    const directory = await createTestTempDirectory("rea-js-source-selection-");
    const files = await writeJavaScriptSourceSelectionFixture(directory);
    let input = directory;
    if (format === "asar") {
      input = join(
        await createTestTempDirectory("rea-js-selected-asar-"),
        "app.asar",
      );
      await createPackageWithOptions(directory, input, {});
    }
    const requested = ["main.mjs", "package.json", "main.mjs"];
    const response = await cli.run({
      arguments: [
        command,
        input,
        ...requested.flatMap((path) => ["--source-path", path]),
        "--format",
        "json",
      ],
    });
    expect(response.exitCode).toBe(0);
    const evidence = parseEvidence(response.json);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      evidence.normalized_result,
    );
    expect(result.source_selection).toEqual({
      requested_paths: requested,
      unselected_files: 4,
    });
    expect(evidence.parameters.source_paths).toEqual(requested);
    expect(result.statistics).toMatchObject({
      relevant_files: 6,
      parsed_javascript_files: 1,
      invalid_utf8_files: 0,
      parse_failures: 0,
      text_bytes_read:
        files.get("main.mjs")!.length + files.get("package.json")!.length,
    });
    expect(result.graph.coverage.status).toBe("partial");
    expect(result.semantic_graph.coverage).toMatchObject({
      status: "partial",
      truncated: false,
    });
    expect(
      result.semantic_graph.nodes.some(
        ({ kind, label }) => kind === "function" && label === "selected",
      ),
    ).toBe(true);
    expect(
      result.semantic_graph.unknowns.some(
        ({ reason, detail }) =>
          reason === "incomplete-module" &&
          detail.includes("caller-selected source_paths"),
      ),
    ).toBe(true);
    for (const [path, bytes] of files) {
      const properties = result.graph.nodes
        .flatMap(({ observations }) =>
          observations.map(({ properties }) => properties),
        )
        .find(
          (properties) =>
            properties.path === path && properties.text_status !== undefined,
        );
      expect(properties?.text_status).toBe(
        requested.includes(path) ? "included" : "outside-analysis-scope",
      );
      expect(properties?.parse_status).toBe(
        path === "main.mjs" ? "complete" : null,
      );
      expect(await readFile(join(directory, path))).toEqual(bytes);
    }
    const fullResponse = await cli.run({
      arguments: [command, input, "--format", "json"],
    });
    expect(fullResponse.exitCode).toBe(0);
    const full = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(fullResponse.json).normalized_result,
    );
    expect(full.source_selection).toBeUndefined();
    expect(full.statistics.invalid_utf8_files).toBe(1);
    expect(full.statistics.parse_failures).toBeGreaterThan(0);
    expect([
      result.root_artifact_sha256,
      result.inventory_manifest_id,
      result.inventory_graph_sha256,
    ]).toEqual([
      full.root_artifact_sha256,
      full.inventory_manifest_id,
      full.inventory_graph_sha256,
    ]);
    if (format === "asar")
      expect(result.root_artifact_sha256).toBe(
        createHash("sha256")
          .update(await readFile(input))
          .digest("hex"),
      );
  },
);

cliTest(
  "rejects source selection when an explicit provider chooses the native lane",
  async ({ cli }) => {
    const directory = await createTestTempDirectory(
      "rea-js-source-native-refusal-",
    );
    await writeJavaScriptSourceSelectionFixture(directory);
    const response = await cli.run({
      arguments: [
        "analyze",
        directory,
        "--provider",
        "ghidra",
        "--source-path",
        "main.mjs",
        "--format",
        "json",
      ],
    });
    expect(response.exitCode).toBe(1);
    expect(response.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [{ path: ["source_paths"], reason: "invalid_value" }],
      },
    });
  },
);
