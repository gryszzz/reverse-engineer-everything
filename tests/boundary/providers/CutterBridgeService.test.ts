import { expect, it, vi } from "vitest";

import { CutterBridgeService } from "../../../src/cutter/CutterBridgeService.js";

const cutterInput = {
  session_id: "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a",
  expected_generation: 7,
  command: "pd 4",
};

it("retains uncertain command completion as Evidence without encouraging a retry", async () => {
  const service = new CutterBridgeService({
    listSessions: async () => ({
      sessions: [],
      bridge_directory: "/private/bridge",
      discovery_status: "no_live_bridge_found",
      bridge_directory_security: "private_verified",
    }),
    execute: async () => ({
      requestId: "4b18ce4d-bf31-456e-ae31-e8c547b2f9db",
      output: null,
      currentFile: "/fixtures/sample.bin",
      documentGeneration: 7,
      identityStatus: "partial",
      cutterVersion: "Cutter fixture version",
      executionState: "unknown",
      error: "transport-response-missing",
      message: "The command may have completed; do not retry automatically",
      outputTruncated: false,
    }),
  });

  const result = await service.execute({
    session_id: "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a",
    expected_generation: 7,
    command: "Ps /tmp/project.rzdb",
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisOutputError",
      cleanupIncomplete: true,
      partialObservation: {
        normalized_result: {
          command: "Ps /tmp/project.rzdb",
          output: null,
          execution_state: "unknown",
          error: "transport-response-missing",
          message: expect.stringContaining("do not retry automatically"),
          document_generation: 7,
          cutter_version: "Cutter fixture version",
        },
        limitations: expect.arrayContaining([
          "Command completion or its output could not be confirmed; do not retry automatically because the command may have produced partial or persistent effects.",
        ]),
        provider: { version: "Cutter fixture version" },
      },
    },
  });
});

it("clears a poisoned command only after its exact UI-dispatcher receipt", async () => {
  const requestId = "4b18ce4d-bf31-456e-ae31-e8c547b2f9db";
  const wrongId = "8ca93d11-107d-41ed-8b40-31dd53cd26a6";
  let receipt: string | undefined;
  let uiPending = true;
  let dispatches = 0;
  const confirmCommandCompletion = vi.fn(
    async (_session: string, id: string) =>
      receipt === id && !uiPending
        ? { ok: true as const, value: true }
        : { ok: true as const, value: false },
  );
  const service = new CutterBridgeService({
    listSessions: async () => ({
      sessions: [],
      bridge_directory: "/private/bridge",
      discovery_status: "no_live_bridge_found",
      bridge_directory_security: "private_verified",
    }),
    confirmCommandCompletion,
    execute: async () => {
      dispatches += 1;
      return {
        requestId,
        output: null,
        currentFile: "/fixtures/sample.bin",
        documentGeneration: 7,
        identityStatus: "partial",
        cutterVersion: "Cutter fixture version",
        executionState: dispatches === 1 ? "unknown" : "complete",
        error: dispatches === 1 ? "ui-thread-request-timeout" : null,
        message: null,
        outputTruncated: false,
      };
    },
  });

  const first = await service.execute(cutterInput);
  expect(first).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });

  for (const unconfirmed of [
    undefined,
    "ede4bbfd-6348-46aa-963b-0de0e78ccbdc",
    wrongId,
  ]) {
    receipt = unconfirmed;
    const blocked = await service.execute(cutterInput);
    expect(blocked).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    expect(dispatches).toBe(1);
  }
  receipt = requestId;
  const pending = await service.execute(cutterInput);
  expect(pending).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(dispatches).toBe(1);
  expect(confirmCommandCompletion).toHaveBeenLastCalledWith(
    cutterInput.session_id,
    requestId,
    undefined,
  );

  receipt = requestId;
  uiPending = false;
  const recovered = await service.execute(cutterInput);
  expect(recovered.ok).toBe(true);
  expect(dispatches).toBe(2);
});

it("recovers canceled command A after B and does not retain poisoned B", async () => {
  const requestA = "4b18ce4d-bf31-456e-ae31-e8c547b2f9db";
  const completionTokenA = "0000000000000007";
  const requestB = "8ca93d11-107d-41ed-8b40-31dd53cd26a6";
  const receipts = new Set<string>();
  let dispatches = 0;
  const confirmCommandCompletion = vi.fn(
    async (_session: string, id: string) =>
      receipts.delete(id)
        ? { ok: true as const, value: true }
        : { ok: true as const, value: false },
  );
  const execute = async () => {
    dispatches += 1;
    if (dispatches === 1) {
      receipts.add(requestA);
      return {
        requestId: requestA,
        output: null,
        currentFile: "/fixtures/sample.bin",
        documentGeneration: 7,
        identityStatus: "partial" as const,
        cutterVersion: null,
        executionState: "unknown" as const,
        error: "transport-response-missing",
        message: "cancelled after dispatch",
        outputTruncated: false,
        completionToken: completionTokenA,
      };
    }
    if (dispatches === 2)
      return {
        requestId: requestB,
        output: "B complete",
        currentFile: "/fixtures/sample.bin",
        documentGeneration: 7,
        identityStatus: "partial" as const,
        cutterVersion: null,
        executionState: "complete" as const,
        error: null,
        message: null,
        outputTruncated: false,
      };
    if (dispatches === 3)
      return {
        requestId: requestB,
        output: null,
        currentFile: "/fixtures/sample.bin",
        documentGeneration: 7,
        identityStatus: "partial" as const,
        cutterVersion: null,
        executionState: "not_started" as const,
        error: "session-poisoned-after-ui-timeout",
        message: null,
        outputTruncated: false,
      };
    return {
      requestId: "c31130c6-fc6c-46ad-949e-586724d8fd84",
      output: "recovered",
      currentFile: "/fixtures/sample.bin",
      documentGeneration: 7,
      identityStatus: "partial" as const,
      cutterVersion: null,
      executionState: "complete" as const,
      error: null,
      message: null,
      outputTruncated: false,
    };
  };
  const client = {
    listSessions: async () => ({
      sessions: [],
      bridge_directory: "/private/bridge",
      discovery_status: "no_live_bridge_found" as const,
      bridge_directory_security: "private_verified" as const,
    }),
    confirmCommandCompletion,
    execute,
  };
  const callerA = new CutterBridgeService(client);
  const callerB = new CutterBridgeService(client);

  const cancelledA = await callerA.execute(cutterInput);
  expect(cancelledA).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(await callerB.execute(cutterInput)).toMatchObject({ ok: true });
  expect(receipts.has(requestA)).toBe(true);

  const poisonedB = await callerA.execute(cutterInput);
  expect(poisonedB).toMatchObject({
    ok: true,
    value: { normalized_result: { execution_state: "not_started" } },
  });
  expect(confirmCommandCompletion).toHaveBeenCalledTimes(1);
  expect(confirmCommandCompletion).toHaveBeenCalledWith(
    cutterInput.session_id,
    requestA,
    completionTokenA,
  );

  expect(await callerA.execute(cutterInput)).toMatchObject({ ok: true });
  expect(confirmCommandCompletion).toHaveBeenCalledTimes(1);
  expect(dispatches).toBe(4);
});

it("rejects malformed Cutter commands and pre-aborted calls", async () => {
  const service = new CutterBridgeService({
    listSessions: async () => ({
      sessions: [],
      bridge_directory: "/private/bridge",
      discovery_status: "no_live_bridge_found",
      bridge_directory_security: "private_verified",
    }),
    execute: async () => {
      throw new Error("must not dispatch");
    },
  });

  const malformed = await service.execute({ ...cutterInput, command: "" });
  expect(malformed).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await service.execute(cutterInput, {
    signal: controller.signal,
  });
  expect(cancelled).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
});

it.each([
  [new Error("session generation changed"), "AnalysisInputError"],
  [new Error("bridge disconnected"), "AnalysisCapabilityUnavailableError"],
  ["plain failure", "AnalysisCapabilityUnavailableError"],
])("maps a Cutter bridge failure to %s", async (failure, tag) => {
  const service = new CutterBridgeService({
    listSessions: async () => ({
      sessions: [],
      bridge_directory: "/private/bridge",
      discovery_status: "no_live_bridge_found",
      bridge_directory_security: "private_verified",
    }),
    execute: async () => {
      throw failure;
    },
  });

  const result = await service.execute(cutterInput);
  expect(result).toMatchObject({ ok: false, error: { _tag: tag } });
});

it("preserves cancellation unless the bridge reports an ambiguous completion", async () => {
  const createService = (message: string, controller: AbortController) =>
    new CutterBridgeService({
      listSessions: async () => ({
        sessions: [],
        bridge_directory: "/private/bridge",
        discovery_status: "no_live_bridge_found",
        bridge_directory_security: "private_verified",
      }),
      execute: async () => {
        controller.abort();
        throw new Error(message);
      },
    });
  const cancelledController = new AbortController();

  const cancelled = await createService(
    "transport cancelled",
    cancelledController,
  ).execute(cutterInput, { signal: cancelledController.signal });
  expect(cancelled).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });

  const uncertainController = new AbortController();
  const uncertain = await createService(
    "command may have completed",
    uncertainController,
  ).execute(cutterInput, { signal: uncertainController.signal });
  expect(uncertain).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
});

it("shares one cleanup attempt when commands retry the same receipt together", async () => {
  const requestId = "4b18ce4d-bf31-456e-ae31-e8c547b2f9db";
  let receiptPresent = false;
  let releaseConfirm: (() => void) | undefined;
  let confirms = 0;
  const confirmCommandCompletion = vi.fn(async () => {
    confirms += 1;
    if (!receiptPresent) return { ok: true as const, value: false };
    if (confirms === 1) {
      await new Promise<void>((resolve) => {
        releaseConfirm = resolve;
      });
    }
    if (!receiptPresent) return { ok: true as const, value: false };
    receiptPresent = false;
    return { ok: true as const, value: true };
  });
  let dispatches = 0;
  const service = new CutterBridgeService({
    listSessions: async () => ({
      sessions: [],
      bridge_directory: "/private/bridge",
      discovery_status: "no_live_bridge_found",
      bridge_directory_security: "private_verified",
    }),
    confirmCommandCompletion,
    execute: async () => {
      dispatches += 1;
      if (dispatches === 1) {
        receiptPresent = true;
        return {
          requestId,
          output: null,
          currentFile: "/fixtures/sample.bin",
          documentGeneration: 7,
          identityStatus: "partial" as const,
          cutterVersion: null,
          executionState: "unknown" as const,
          error: "transport-response-missing",
          message: "cancelled after dispatch",
          outputTruncated: false,
        };
      }
      return {
        requestId: "8ca93d11-107d-41ed-8b40-31dd53cd26a6",
        output: "complete",
        currentFile: "/fixtures/sample.bin",
        documentGeneration: 7,
        identityStatus: "partial" as const,
        cutterVersion: null,
        executionState: "complete" as const,
        error: null,
        message: null,
        outputTruncated: false,
      };
    },
  });

  const blocked = await service.execute(cutterInput);
  expect(blocked).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });

  const concurrent = [
    service.execute(cutterInput),
    service.execute(cutterInput),
  ];
  if (releaseConfirm === undefined) throw new Error("cleanup did not start");
  releaseConfirm();
  const recovered = await Promise.all(concurrent);
  expect(recovered.every((result) => result.ok)).toBe(true);
  expect(confirms).toBe(1);
  expect(dispatches).toBe(3);
});
