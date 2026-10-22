import assert from "node:assert/strict";
import { test } from "node:test";
import { ownedTraceScenario, projectProcessCapture } from "./trace.mjs";

test("the owned trace scenario is the lab cli and does not take a caller path", () => {
  const scenario = ownedTraceScenario();
  assert.equal(scenario.arguments.at(-1), "bridge");
  assert.match(scenario.arguments[0], /rel-first-lab\/cli\.mjs$/u);
  assert.deepEqual(scenario.filesystem_observation_paths, [
    scenario.working_directory,
  ]);
  assert.equal(scenario.executable, process.execPath);
});

test("network and IPC stay not-recorded and static paths only correlate by name", () => {
  const view = projectProcessCapture(
    {
      evidence_id: "ev_trace",
      operation: "capture_process_scenario",
      normalized_result: {
        frames: [{}, {}],
        filesystem_effects: [
          { path: "/lab/search.mjs", status: "unchanged" },
          { path: "/lab/other.txt", status: "created" },
        ],
        residual_unknowns: [
          {
            scope: "network",
            reason: "Network observation was not requested.",
          },
        ],
      },
    },
    ["search.mjs"],
  );
  assert.equal(view.separate_from_static_evidence, true);
  assert.equal(view.network.status, "not-recorded");
  assert.match(view.network.reason, /not requested/);
  assert.equal(view.ipc.status, "not-recorded");
  assert.equal(view.filesystem.status, "checkpoint-effects");
  assert.equal(view.correlated.length, 1);
  assert.match(view.correlated[0].note, /does not show that the module ran/);
  assert.equal(view.terminal.frames, 2);
});

test("a capture without filesystem effects does not invent file events", () => {
  const view = projectProcessCapture({
    evidence_id: "ev_empty",
    normalized_result: {},
  });
  assert.equal(view.filesystem.status, "unknown");
  assert.deepEqual(view.correlated, []);
  assert.equal(view.network.status, "not-recorded");
});
