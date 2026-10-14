import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";

import type { BinarySession } from "../../../src/application/binary/BinarySession.js";
import {
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
} from "../../../src/contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../../src/domain/process/processCaptureExample.js";
import { PROCESS_PROVIDER } from "../../../src/domain/process/processEvidenceProvider.js";
import { processCaptureComparisonSchema } from "../../../src/domain/process/processComparison.js";
import { digestProcessCommitment } from "../../../src/domain/process/processScenario.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { createJavaScriptSemanticGraph } from "../../../src/domain/javascript/javascriptSemanticGraph.js";
import {
  artifactEvidence,
  sourceMapReference,
} from "../../../src/domain/javascript/javascriptApplicationGraph.fixture.js";
import {
  createApplicationMcpHarness,
  type ApplicationMcpHarness,
} from "../../fixtures/applicationMcpHarness.js";
import { createHistoricalSourceGraph } from "../../../src/domain/referenceSourceGraph.js";

async function runUnicodeSourceMapComparison(
  harness: ApplicationMcpHarness,
): Promise<void> {
  const baseApplication = SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.application;
  const subject = baseApplication.subject;
  if (subject === null) throw new Error("Application Evidence has no subject");
  const baseResult = javascriptApplicationAnalysisResultSchema.parse(
    baseApplication.normalized_result,
  );
  const baseGraph = baseResult.graph;
  const decomposedSource = "cafe\u0301.ts";
  const unicodeSourceNode = createJavaScriptApplicationNode({
    kind: "source-module",
    identity: {
      strategy: "source-map-original",
      source_root: "../src/",
      stability: "source-map-exact",
      source_map_sha256: "1".repeat(64),
      original_source: decomposedSource,
      source_sha256: "3".repeat(64),
    },
    observations: [
      {
        label: "decomposed source-map spelling",
        source_map_reference: sourceMapReference(
          decomposedSource,
          "../src/",
          "dist/main.js.map",
        ),
        properties: { content_available: true, content_sha256: "3".repeat(64) },
        evidence: artifactEvidence("1".repeat(64), "dist/main.js.map"),
      },
    ],
  });
  const applicationGraph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [...baseGraph.root_node_ids, unicodeSourceNode.node_id],
    nodes: [...baseGraph.nodes, unicodeSourceNode],
    edges: baseGraph.edges,
    coverage: baseGraph.coverage,
    limitations: baseGraph.limitations,
  });
  const semantic = baseResult.semantic_graph;
  const { graph_id: _semanticGraphId, ...semanticInput } = semantic;
  const semanticGraph = createJavaScriptSemanticGraph({
    ...semanticInput,
    application_graph_id: applicationGraph.graph_id,
  });
  const unicodeApplication = createEvidence(
    {
      path: baseResult.input_path,
      sha256: subject.digest.sha256,
      format: subject.format,
    },
    baseApplication.provider,
    {
      predicateType: baseApplication.predicate_type,
      operation: baseApplication.operation,
      parameters: baseApplication.parameters,
      result: {
        ...baseResult,
        graph: applicationGraph,
        semantic_graph: semanticGraph,
      },
      confidence: baseApplication.confidence,
      authority: baseApplication.authority,
      limitations: baseApplication.limitations,
      evidenceLinks: baseApplication.evidence_links,
    },
  );
  const historicalUnicodePath = "src/caf\u00e9.ts";
  const unicodeReference = createHistoricalSourceGraph({
    ...SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference,
    root_sha256: undefined,
    entries: SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference.entries.map(
      (entry) =>
        entry.path === "src/main.ts"
          ? { ...entry, path: historicalUnicodePath }
          : entry,
    ),
  });
  const reply = await harness.client.callTool({
    name: "compare_source_to_bundle",
    arguments: { reference: unicodeReference, application: unicodeApplication },
  });
  expect(reply.isError).not.toBe(true);
  expect(reply.structuredContent).toMatchObject({
    normalized_result: {
      items: [
        {
          source_path: historicalUnicodePath,
          status: "unknown",
          current_node_ids: [],
          candidates: [
            expect.objectContaining({
              confidence: "low",
              signals: expect.arrayContaining([
                expect.objectContaining({
                  kind: "unicode-equivalent-path",
                  source_value: historicalUnicodePath,
                  current_values: ["src/cafe\u0301.ts"],
                }),
              ]),
            }),
          ],
        },
      ],
    },
  });
  const advertised = (await harness.client.listTools()).tools.find(
    ({ name }) => name === "compare_source_to_bundle",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("Comparison tool output schema is missing");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const outputSchema = advertised.outputSchema as AnySchema;
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  const validateOutput = ajv.compile(outputSchema);
  expect(validateOutput(reply.structuredContent)).toBe(true);
}

async function runInlineWorkflowScenarios(
  harness: ApplicationMcpHarness,
): Promise<void> {
  const tracedInline = await harness.client.callTool({
    name: "trace_application_feature",
    arguments: {
      ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
    },
  });
  expect(tracedInline.isError).not.toBe(true);
  expect(tracedInline.structuredContent).toMatchObject({
    normalized_result: {
      seed: { kind: "module", value: "renderer.js", match: "exact" },
      summary: { matched_seeds: 1, traced_nodes: 1, unknown_facts: 0 },
      coverage: {
        status: "complete-within-source",
        source_graph_status: "complete",
        total_seed_matches: 1,
      },
    },
  });

  const comparedInline = await harness.client.callTool({
    name: "compare_application_versions",
    arguments: {
      ...JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
    },
  });
  expect(comparedInline).toMatchObject({
    structuredContent: {
      normalized_result: {
        evidence_links: expect.arrayContaining([
          JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE.left.evidence_id,
          JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE.right.evidence_id,
        ]),
      },
    },
  });

  const idsRejected = await harness.client.callTool({
    name: "compare_application_versions",
    arguments: {
      left_evidence_id:
        JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE.left.evidence_id,
      right_evidence_id:
        JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE.right.evidence_id,
    },
  });
  expect(idsRejected.isError).toBe(true);

  const sourceCompared = await harness.client.callTool({
    name: "compare_source_to_bundle",
    arguments: {
      ...SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
    },
  });
  expect(sourceCompared.isError).not.toBe(true);
  expect(sourceCompared.structuredContent).toMatchObject({
    normalized_result: {
      reference: {
        root_sha256: SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference.root_sha256,
        inventory_state: "complete",
      },
      scoring: { algorithm: "rea-source-to-bundle-signals" },
      summary: { unchanged: 0, modified: 0, removed: 1, unknown: 0 },
      items: [
        {
          source_path: "src/main.ts",
          status: "removed",
          current_node_ids: [],
          candidates: [],
        },
      ],
    },
  });

  await runUnicodeSourceMapComparison(harness);

  const referenceWithExclusion = createHistoricalSourceGraph({
    ...SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference,
    root_sha256: undefined,
    inventory_state: "partial",
    exclusions: [
      {
        path: "vendor/removed.ts",
        reason: "project-ignored",
        pattern: "vendor/",
      },
    ],
  });
  const argumentsWithExclusion = {
    ...SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
    reference: referenceWithExclusion,
  };
  const advertised = (await harness.client.listTools()).tools.find(
    ({ name }) => name === "compare_source_to_bundle",
  );
  if (advertised === undefined) throw new Error("Comparison tool is missing");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  expect(ajv.validateSchema(advertised.inputSchema)).toBe(true);
  const validate = ajv.compile(advertised.inputSchema);
  expect(validate(argumentsWithExclusion)).toBe(true);
  const missingPattern = {
    ...argumentsWithExclusion,
    reference: {
      ...referenceWithExclusion,
      exclusions: [{ path: "vendor/removed.ts", reason: "project-ignored" }],
    },
  };
  expect(validate(missingPattern)).toBe(false);
  const rejectedExclusion = await harness.client.callTool({
    name: "compare_source_to_bundle",
    arguments: missingPattern,
  });
  expect(rejectedExclusion.isError).toBe(true);
  const sourceComparedWithExclusion = await harness.client.callTool({
    name: "compare_source_to_bundle",
    arguments: argumentsWithExclusion,
  });
  expect(sourceComparedWithExclusion.isError).not.toBe(true);
  expect(sourceComparedWithExclusion.structuredContent).toMatchObject({
    normalized_result: {
      reference: {
        root_sha256: referenceWithExclusion.root_sha256,
        inventory_state: "partial",
      },
    },
  });
  expect(harness.session.exportEvidenceBundle().records.length).toBeGreaterThan(
    2,
  );
}

const processComparisonBundle = (counterexample = false) => {
  const environment = {
    id: "mcp-specification-derivation-test",
    platform: "linux",
    architecture: "x86_64",
    isolation: "container" as const,
  };
  const capture = (digit: string) => {
    const scenario = {
      executable: `/tmp/mcp-specification-${digit}`,
      arguments: ["1.05", "10"],
      executable_sha256: "0".repeat(64),
    };
    const result = {
      ...EMPTY_PROCESS_CAPTURE_EXAMPLE,
      manifest: {
        ...EMPTY_PROCESS_CAPTURE_EXAMPLE.manifest,
        scenario,
        full_scenario_sha256: digestProcessCommitment(scenario),
      },
    };
    return createEvidence(
      {
        path: `/tmp/mcp-specification-${digit}`,
        sha256: digit.repeat(64),
        format: "file",
      },
      { id: "fixture", name: "Fixture capture", version: "1" },
      {
        predicateType: "rea.process-capture",
        operation: "capture_process_scenario",
        parameters: {},
        result: jsonValueSchema.parse(JSON.parse(JSON.stringify(result))),
        confidence: "observed",
        authority: "controlled-replay",
        environment,
      },
    );
  };
  const left = capture("c");
  const right = capture("d");
  const comparison = createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-comparison",
    operation: "compare_process_captures",
    parameters: {
      left_evidence_id: left.evidence_id,
      right_evidence_id: right.evidence_id,
    },
    result: jsonValueSchema.parse(
      JSON.parse(
        JSON.stringify(
          processCaptureComparisonSchema.parse({
            status: counterexample ? "changed" : "unchanged",
            terminal: counterexample ? "changed" : "unchanged",
            interaction: "unchanged",
            exit: "unchanged",
            filesystem: "unchanged",
            process: "unchanged",
            first_divergence: counterexample
              ? {
                  status: "found",
                  dimension: "terminal",
                  index: 0,
                  left_at_ms: 0,
                  right_at_ms: 0,
                  left: "10.50",
                  right: "11.00",
                }
              : { status: "none" },
            limitations: [],
          }),
        ),
      ),
    ),
    confidence: "derived",
    authority: "analyst-inference",
    evidenceLinks: [left.evidence_id, right.evidence_id],
  });
  return {
    comparison,
    evidence_bundle: createEvidenceBundle([left, right, comparison]),
  };
};

async function assertRejectedEvidenceReferences(
  client: Client,
  session: BinarySession,
): Promise<void> {
  const wrongOperation = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    { operation: "inventory_artifact", parameters: {}, result: {} },
  );
  const wrongPredicate = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      predicateType: "fixture.application/v1",
      operation: "analyze_javascript_application",
      parameters: {},
      result: {},
    },
  );
  expect(session.recordEvidence(wrongOperation).ok).toBe(true);
  expect(session.recordEvidence(wrongPredicate).ok).toBe(true);
  for (const record of [wrongOperation, wrongPredicate]) {
    const rejected = await client.callTool({
      name: "trace_application_feature",
      arguments: {
        ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
        application: record,
      },
    });
    expect(parseMcpToolError(rejected)).toMatchObject({
      // A recorded Evidence with the wrong operation or predicate is an
      // invalid caller input, not a provider failure.
      error: {
        code: "invalid_request",
        category: "invalid_input",
        retryable: true,
      },
    });
  }
}

async function assertRejectedInlineEvidence(client: Client): Promise<void> {
  const duplicateNative = await client.callTool({
    name: "trace_application_feature",
    arguments: {
      ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      native_observations: [
        JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application,
        JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application,
      ],
    },
  });
  expect(duplicateNative.isError).toBe(true);

  const spoofed = await client.callTool({
    name: "trace_application_feature",
    arguments: {
      ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      application: {
        ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application,
        provider: { id: "spoofed", name: "spoofed", version: "1" },
      },
    },
  });
  expect(spoofed.isError).toBe(true);
}

describe("application workflow MCP parity", () => {
  it("traces and compares authenticated graph Evidence in the session", async () => {
    const harness = await createApplicationMcpHarness();
    try {
      await runInlineWorkflowScenarios(harness);
      await assertRejectedEvidenceReferences(harness.client, harness.session);
      await assertRejectedInlineEvidence(harness.client);
    } finally {
      await harness.close();
    }
  });

  it("drafts a specification from supplied comparison Evidence and verifies it in-session", async () => {
    const harness = await createApplicationMcpHarness();
    try {
      const { comparison, evidence_bundle } = processComparisonBundle();
      const drafted = await harness.client.callTool({
        name: "derive_reconstruction_specification",
        arguments: {
          name: "MCP finite process comparison",
          evidence_bundle,
          comparisons: [
            {
              comparison_evidence_id: comparison.evidence_id,
              dimensions: ["terminal", "overall"],
            },
          ],
        },
      });
      expect(drafted.isError).not.toBe(true);
      const draftedEvidence = drafted.structuredContent as {
        readonly normalized_result: {
          readonly specification: unknown;
          readonly source_evidence_ids: readonly string[];
        };
      };
      expect(draftedEvidence.normalized_result.specification).toMatchObject({
        name: "MCP finite process comparison",
        claims: [
          { kind: "behavioral", dimension: "overall" },
          { kind: "behavioral", dimension: "terminal" },
        ],
      });

      const verified = await harness.client.callTool({
        name: "verify_reconstruction",
        arguments: {
          specification: draftedEvidence.normalized_result.specification,
        },
      });
      expect(verified.isError).not.toBe(true);
      expect(verified.structuredContent).toMatchObject({
        normalized_result: {
          status: "pass",
          summary: { total: 2, passed: 2 },
        },
      });
    } finally {
      await harness.close();
    }
  });

  it("returns counterexample-guided argument variations through the session verifier", async () => {
    const harness = await createApplicationMcpHarness();
    try {
      const { comparison, evidence_bundle } = processComparisonBundle(true);
      const drafted = await harness.client.callTool({
        name: "derive_reconstruction_specification",
        arguments: {
          name: "MCP terminal counterexample",
          evidence_bundle,
          comparisons: [
            {
              comparison_evidence_id: comparison.evidence_id,
              dimensions: ["terminal"],
            },
          ],
        },
      });
      expect(drafted.isError).not.toBe(true);
      const draft = drafted.structuredContent as {
        readonly normalized_result: { readonly specification: unknown };
      };
      const verified = await harness.client.callTool({
        name: "verify_reconstruction",
        arguments: { specification: draft.normalized_result.specification },
      });

      expect(verified.isError).not.toBe(true);
      expect(verified.structuredContent).toMatchObject({
        normalized_result: {
          status: "fail",
          recommended_probes: [
            {
              operation: "capture_process_scenario",
              argument_variations: [
                {
                  argument_index: 0,
                  observed_value: "1.05",
                  candidate_values: ["1.04", "1.06"],
                },
                {
                  argument_index: 1,
                  observed_value: "10",
                  candidate_values: ["9", "11"],
                },
              ],
              evidence_links: expect.arrayContaining([comparison.evidence_id]),
            },
          ],
        },
      });
    } finally {
      await harness.close();
    }
  });
});
