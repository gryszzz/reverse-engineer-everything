import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { applicationVersionComparisonResultSchema } from "../../../src/domain/javascript/javascriptApplicationVersionComparisonSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "pairs repeated factory bodies by identity when application versions retain a shared bundle",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-version-matching-");
    const factoryCount = 32;
    const factories = Array.from(
      { length: factoryCount },
      (_, index) => `${index}: function() {}`,
    ).join(",");
    const bundle = `globalThis.webpackChunkApp.push([[1], {${factories}}]);`;
    const versions = await Promise.all(
      [1, 2].map(async (version) => {
        const application = join(root, String(version));
        await mkdir(application);
        await writeFile(
          join(application, "package.json"),
          JSON.stringify({ name: "shared-bundle", version: `${version}.0.0` }),
        );
        await writeFile(join(application, "chunk.js"), bundle);
        const response = await cli.run({
          arguments: ["analyze-javascript-application", application, "--json"],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(response.exitCode, response.stderr).toBe(0);
        return parseEvidence(response.json);
      }),
    );
    const [left, right] = versions;
    if (left === undefined || right === undefined)
      throw new Error("Missing application version Evidence");
    const analyses = versions.map(({ normalized_result }) =>
      javascriptApplicationAnalysisResultSchema.parse(normalized_result),
    );
    const factoryNodes = analyses.map(({ graph }) => {
      expect(graph.coverage.status).toBe("complete");
      const nodes = graph.nodes.filter(
        ({ kind, observations }) =>
          kind === "javascript-module" &&
          observations.some(
            ({ properties }) => properties.module_key !== undefined,
          ),
      );
      expect(nodes).toHaveLength(factoryCount);
      const sourceDigests = nodes.flatMap(({ observations }) =>
        observations.map(({ properties }) => properties.source_sha256),
      );
      expect(sourceDigests.every((digest) => typeof digest === "string")).toBe(
        true,
      );
      expect(new Set(sourceDigests).size).toBe(1);
      return nodes;
    });
    const inputPath = join(root, "comparison.json");
    await writeFile(inputPath, JSON.stringify({ left, right }));
    const response = await cli.run({
      arguments: ["compare-application-versions", inputPath, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const result = applicationVersionComparisonResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );

    expect(result.left.root_artifact_sha256).not.toBe(
      result.right.root_artifact_sha256,
    );
    expect(result.matching.ambiguous).toBe(0);
    expect(result.coverage.status).toBe("complete-within-inputs");
    expect(factoryNodes[0]?.map(({ node_id }) => node_id)).toEqual(
      factoryNodes[1]?.map(({ node_id }) => node_id),
    );
    for (const node of factoryNodes[0] ?? []) {
      expect(
        result.items.find(({ left_node_id }) => left_node_id === node.node_id),
      ).toMatchObject({
        status: "unchanged",
        right_node_id: node.node_id,
        match: {
          status: "matched",
          basis: "exact-node-identity",
          candidate_left_node_ids: [],
          candidate_right_node_ids: [],
        },
      });
    }
  },
);
