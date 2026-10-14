import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { createElectronActiveEvidence } from "../../../../src/application/javascript/ElectronActiveEvidence.js";
import { reconcileJavaScriptRuntimeEvidence } from "../../../../src/application/javascript/JavaScriptRuntimeReconciliationService.js";
import { createEvidence } from "../../../../src/domain/evidence.js";
import {
  parseRuntimeReconciliationInput,
  reconcileJavaScriptRuntime,
} from "../../../../src/domain/javascript/javascriptRuntimeReconciliation.js";
import { reconcileJavaScriptRuntimeInputSchema } from "../../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { electronActiveObservationInputSchema } from "../../../../src/domain/javascript/electronActiveObservation.js";
import { createElectronActiveObservationFixtureResult } from "../../../../src/domain/javascript/electronActiveObservation.fixture.js";

import {
  SOURCE,
  applicationFixture,
  analyzeFixture,
  electronRuntimeEvidence,
} from "../../../fixtures/javascriptRuntimeReconciliation.js";

const reconcileInput = (input: unknown) =>
  reconcileJavaScriptRuntime(
    parseRuntimeReconciliationInput(
      reconcileJavaScriptRuntimeInputSchema.parse(input),
    ),
  );

it("preserves source-capture input paths for runtime Evidence", async () => {
  const root = await applicationFixture();
  const application = await analyzeFixture(root);
  const runtime = electronRuntimeEvidence(root, SOURCE);
  const invalidRuntime = createEvidence(undefined, runtime.provider, {
    predicateType: runtime.predicate_type,
    operation: runtime.operation,
    parameters: { ...runtime.parameters, include_script_sources: false },
    result: runtime.normalized_result,
    confidence: runtime.confidence,
    authority: runtime.authority,
  });

  const result = reconcileJavaScriptRuntimeEvidence({
    static_layers: [{ role: "application", analysis: application }],
    runtime_observations: [invalidRuntime],
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      issues: [
        {
          path: [
            "runtime_observations",
            0,
            "parameters",
            "include_script_sources",
          ],
          reason: "invalid_value",
          message:
            "Runtime Evidence contains source without source-capture selection",
        },
      ],
    },
  });
});

it("reconciles runtime scripts inside dot-prefixed child directories", async () => {
  const root = await applicationFixture();
  await mkdir(join(root, "..cache"));
  await writeFile(join(root, "..cache", "app.js"), SOURCE);
  const result = reconcileInput({
    static_layers: [
      { role: "application", analysis: await analyzeFixture(root) },
    ],
    runtime_observations: [
      electronRuntimeEvidence(root, SOURCE, {
        scriptFile: "..cache/app.js",
        includeWorker: false,
      }),
    ],
  });
  expect(result.reconciliations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entity_kind: "script",
        status: "matched",
        basis: "content-and-location",
      }),
    ]),
  );
});

it("matches renderer, frame, script bytes, and worker without claiming execution", async () => {
  const fixture = await applicationFixture();
  const staticEvidence = await analyzeFixture(fixture);
  const runtimeEvidence = electronRuntimeEvidence(fixture, SOURCE);

  const result = reconcileInput({
    static_layers: [{ role: "application", analysis: staticEvidence }],
    runtime_observations: [runtimeEvidence],
  });

  expect(() =>
    javascriptRuntimeReconciliationResultSchema.parse(result),
  ).not.toThrow();
  expect(result.source_map_authority).toMatchObject({
    used_for_primary_matching: false,
    static_layer_count: 1,
    runtime_script_declarations: 0,
  });
  expect(result.summary).toMatchObject({
    runtime_targets: 1,
    runtime_frames: 1,
    runtime_scripts: 1,
    runtime_workers: 1,
    matched: 2,
    ambiguous: 2,
    unmatched: 0,
  });
  expect(result.reconciliations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entity_kind: "script",
        status: "matched",
        basis: "content-and-location",
      }),
      expect.objectContaining({
        entity_kind: "worker",
        status: "matched",
        basis: "artifact-path",
      }),
      expect.objectContaining({
        entity_kind: "target",
        status: "ambiguous",
        reason: "ambiguous-static-candidates",
      }),
    ]),
  );
  const matched = result.reconciliations.find(
    ({ status }) => status === "matched",
  );
  if (matched === undefined)
    throw new TypeError("Expected one matched runtime reconciliation");
  expect(
    javascriptRuntimeReconciliationResultSchema.safeParse({
      ...result,
      reconciliations: [{ ...matched, static_node_id: null }],
    }).success,
  ).toBe(false);
  expect(result.static_load_states).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "javascript-asset",
        status: "loaded",
      }),
    ]),
  );
  expect(result.limitations.join(" ")).toMatch(
    /not reported as executed|not code reachability/u,
  );
  expect(
    result.graph.edges
      .filter(({ relation }) => relation === "observed_as")
      .every(
        ({ evidence }) =>
          evidence.authority === "cross-layer-reconciliation" &&
          evidence.state === "inferred",
      ),
  ).toBe(true);
  const worker = result.reconciliations.find(
    ({ entity_kind: kind }) => kind === "worker",
  );
  const frame = result.reconciliations.find(
    ({ entity_kind: kind }) => kind === "frame",
  );
  expect(result.graph.edges).toContainEqual(
    expect.objectContaining({
      source_node_id: frame?.runtime_node_id,
      target_node_id: worker?.runtime_node_id,
      relation: "contains",
    }),
  );
});

it("keeps static load states unknown when one scoped capture omits scripts", async () => {
  const fixture = await applicationFixture();
  const staticEvidence = await analyzeFixture(fixture);
  const result = reconcileInput({
    static_layers: [{ role: "application", analysis: staticEvidence }],
    runtime_observations: [
      electronRuntimeEvidence(fixture, SOURCE, {
        includeWorker: false,
        targetId: "target-complete",
      }),
      electronRuntimeEvidence(fixture, SOURCE, {
        includeWorker: false,
        scriptsUnavailable: true,
        targetId: "target-incomplete",
      }),
    ],
  });

  expect(
    result.runtime_captures.map(
      ({ scripts_complete_within_scope }) => scripts_complete_within_scope,
    ),
  ).toEqual(expect.arrayContaining([false, true]));
  expect(result.summary.static_not_observed).toBe(0);
  expect(result.static_load_states).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: "unknown",
        reason: "static-or-runtime-coverage-incomplete",
      }),
    ]),
  );
});

it("reports a captured digest disagreement instead of accepting a path match", async () => {
  const fixture = await applicationFixture();
  const staticEvidence = await analyzeFixture(fixture);
  const runtimeEvidence = electronRuntimeEvidence(
    fixture,
    "export const observed = 'different';\n",
  );

  const result = reconcileInput({
    static_layers: [{ role: "application", analysis: staticEvidence }],
    runtime_observations: [runtimeEvidence],
  });
  const script = result.reconciliations.find(
    ({ entity_kind: kind }) => kind === "script",
  );

  expect(script).toMatchObject({
    status: "unmatched",
    reason: "captured-content-disagrees-with-static-location",
  });
  expect(script?.candidate_static_nodes).toHaveLength(1);
});

it("reconciles active Electron as a partial target-only runtime capture", async () => {
  const fixture = await applicationFixture();
  const staticEvidence = await analyzeFixture(fixture);
  const applicationPath = join(fixture, "main.js");
  const input = {
    ...electronActiveObservationInputSchema.parse({
      executable_path: process.execPath,
      application_path: applicationPath,
      application_root: fixture,
      actions: [],
    }),
    application_root: fixture,
  };
  const runtimeEvidence = createElectronActiveEvidence(
    input,
    createElectronActiveObservationFixtureResult(applicationPath),
    {
      id: "rea-playwright-electron-active",
      name: "REA Playwright active Electron observation provider",
      version: "1",
    },
  );

  const result = reconcileInput({
    static_layers: [{ role: "application", analysis: staticEvidence }],
    runtime_observations: [runtimeEvidence],
  });

  expect(result.runtime_captures).toMatchObject([
    {
      kind: "electron-active",
      scripts: 0,
      frames: 0,
      workers: 0,
      scripts_complete_within_scope: false,
    },
  ]);
  expect(result.coverage.status).toBe("partial");
  expect(result.limitations.join(" ")).toMatch(
    /incomplete|not reported as executed/u,
  );
});

it("commits complete Electron actions independently from selected arguments", async () => {
  const fixture = await applicationFixture();
  const applicationPath = join(fixture, "main.js");
  const makeInput = (secret: string, selector: string) => ({
    ...electronActiveObservationInputSchema.parse({
      executable_path: process.execPath,
      application_path: applicationPath,
      application_root: fixture,
      args: ["--token", secret],
      actions: [
        { step_id: "click", kind: "click", selector },
        { step_id: "settle", kind: "wait", duration_ms: 37 },
        {
          step_id: "open",
          kind: "deep-link",
          delivery: "second-instance",
          url: "rea-fixture://open/item?token=selected",
        },
      ],
    }),
    application_root: fixture,
  });
  const provider = {
    id: "rea-playwright-electron-active",
    name: "REA Playwright active Electron observation provider",
    version: "1",
  };
  const first = createElectronActiveEvidence(
    makeInput("first-secret", "#first-secret"),
    createElectronActiveObservationFixtureResult(applicationPath),
    provider,
  );
  const second = createElectronActiveEvidence(
    makeInput("first-secret", "#second-secret"),
    createElectronActiveObservationFixtureResult(applicationPath),
    provider,
  );

  expect(first.parameters.scenario_sha256).not.toBe(
    second.parameters.scenario_sha256,
  );
  expect(JSON.stringify(first)).toContain("first-secret");
  expect(first.parameters.actions).toEqual([
    {
      step_id: "click",
      kind: "click",
      selector: "#first-secret",
      window_index: 0,
    },
    { step_id: "settle", kind: "wait", duration_ms: 37 },
    {
      step_id: "open",
      kind: "deep-link",
      delivery: "second-instance",
      url: "rea-fixture://open/item?token=selected",
    },
  ]);
  expect(first.parameters.args).toEqual(["--token", "first-secret"]);
});

it("imports an operator-provided cache layer through an explicit file mapping", async () => {
  const application = await applicationFixture();
  const cache = await createTestTempDirectory("rea-runtime-cache-static-");
  const runtimeCache = await createTestTempDirectory("rea-runtime-cache-live-");
  const cacheSource = SOURCE;
  await mkdir(join(cache, "mapped"));
  await Promise.all([
    writeFile(join(cache, "mapped", "chunk.js"), cacheSource),
    writeFile(join(cache, "outside.js"), "export const outside = true;\n"),
    writeFile(join(runtimeCache, "chunk.js"), cacheSource),
    writeFile(join(runtimeCache, "index.html"), "<script></script>"),
  ]);
  const applicationEvidence = await analyzeFixture(application);
  const cacheEvidence = await analyzeFixture(cache);
  const runtimeEvidence = electronRuntimeEvidence(runtimeCache, cacheSource, {
    scriptFile: "chunk.js",
    includeWorker: false,
  });

  const result = reconcileInput({
    static_layers: [
      { role: "application", analysis: applicationEvidence },
      {
        role: "cache",
        analysis: cacheEvidence,
        runtime_mappings: [
          {
            kind: "file-root",
            root: runtimeCache,
            artifact_prefix: "mapped",
          },
        ],
      },
    ],
    runtime_observations: [runtimeEvidence],
  });
  const script = result.reconciliations.find(
    ({ entity_kind: kind }) => kind === "script",
  );
  const cacheLayer = result.static_layers.find(({ role }) => role === "cache");

  expect(script).toMatchObject({
    status: "matched",
    basis: "content-and-location",
    static_layer_id: cacheLayer?.layer_id,
  });
  const outside = result.graph.nodes.find(
    (node) =>
      node.kind === "javascript-asset" &&
      node.observations.some(
        ({ properties }) => properties.path === "outside.js",
      ),
  );
  expect(
    result.static_load_states.find(
      ({ static_node_id: nodeId }) => nodeId === outside?.node_id,
    ),
  ).toMatchObject({
    status: "unknown",
    reason: "layer-outside-runtime-scope",
  });
  const sharedFile = result.graph.nodes.find(
    ({ observations }) =>
      observations.some(({ properties }) => properties.path === "app.js") &&
      observations.some(
        ({ properties }) => properties.path === "mapped/chunk.js",
      ),
  );
  expect(
    sharedFile?.observations.map(({ properties }) => properties.path),
  ).toEqual(expect.arrayContaining(["app.js", "mapped/chunk.js"]));
});
