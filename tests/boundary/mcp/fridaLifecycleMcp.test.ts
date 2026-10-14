import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type {
  Device,
  DeviceManager,
  FridaMessage,
  Script,
  Session,
} from "frida";
import { expect, it, onTestFinished } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { evidenceBundleSchema } from "../../../src/domain/evidenceBundle.js";
import { FridaInstrumentationManager } from "../../../src/frida/FridaInstrumentationManager.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const gate = () => {
  let markEntered = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async wait() {
      markEntered();
      await released;
    },
  };
};

const nativeFixture = () => {
  const created: string[] = [];
  const loaded: string[] = [];
  const unloaded: string[] = [];
  const scripts: Script[] = [];
  const scriptsAtResume: string[][] = [];
  const controls = {
    attach: async () => {},
    create: async () => {},
    load: async () => {},
    afterLoad: () => {},
    discover: async () => {},
    unloadFailures: 0,
    detachFailures: 0,
    detachCalls: 0,
    resumes: 0,
    remoteRemovals: 0,
    removalFailures: 0,
  };
  let detached = false;
  const nativeSession: Session = {
    pid: 512,
    detached: { connect() {}, disconnect() {} },
    isDetached: () => detached,
    async detach() {
      controls.detachCalls += 1;
      if (controls.detachFailures > 0) {
        controls.detachFailures -= 1;
        throw new Error("transient detach failure");
      }
      detached = true;
    },
    async createScript(source) {
      created.push(source);
      await controls.create();
      let destroyed = false;
      let listener:
        | ((message: FridaMessage, data: Buffer | null) => void)
        | undefined;
      const script: Script = {
        get isDestroyed() {
          return destroyed;
        },
        message: {
          connect(handler) {
            listener = handler;
          },
          disconnect() {
            listener = undefined;
          },
        },
        async load() {
          await controls.load();
          loaded.push(source);
          listener?.({ type: "send", payload: source }, null);
          controls.afterLoad();
        },
        async unload() {
          unloaded.push(source);
          if (controls.unloadFailures > 0) {
            controls.unloadFailures -= 1;
            throw new Error("transient unload failure");
          }
          destroyed = true;
        },
      };
      scripts.push(script);
      return script;
    },
  };
  const device: Device = {
    id: "local",
    name: "Local fixture",
    type: "local",
    async enumerateProcesses() {
      await controls.discover();
      return [{ pid: 512, name: "fixture" }];
    },
    async getProcessByPid() {
      return { pid: 512, name: "fixture" };
    },
    async spawn() {
      return 512;
    },
    async resume() {
      scriptsAtResume.push(
        created.filter((_, index) => scripts[index]?.isDestroyed === false),
      );
      controls.resumes += 1;
    },
    async attach() {
      await controls.attach();
      return nativeSession;
    },
  };
  const deviceManager: DeviceManager = {
    async enumerateDevices() {
      return [device];
    },
    async getDeviceById() {
      return device;
    },
    async addRemoteDevice() {
      return device;
    },
    async removeRemoteDevice() {
      controls.remoteRemovals += 1;
      if (controls.removalFailures > 0) {
        controls.removalFailures -= 1;
        throw new Error("transient remote removal failure");
      }
    },
  };
  return {
    controls,
    created,
    loaded,
    unloaded,
    scripts,
    scriptsAtResume,
    deviceManager,
  };
};

const connectedFixture = async () => {
  const native = nativeFixture();
  const manager = new FridaInstrumentationManager({
    deviceManager: native.deviceManager,
  });
  const session = createTestBinarySession(() => {
    throw new Error("Binary provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { fridaInstrumentation: manager },
  );
  const client = new Client({ name: "frida-lifecycle", version: "1" });
  onTestFinished(async () => {
    native.controls.detachFailures = 0;
    native.controls.removalFailures = 0;
    await client.close();
    await server.close();
    await manager.closeAll();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const start = async () => {
    const result = await client.callTool({
      name: "start_frida_session",
      arguments: {
        mode: "spawn",
        program: "/fixture",
        device_id: "local",
      },
    });
    return toolContract("start_frida_session").outputSchema.parse(
      result.structuredContent,
    ).session_id;
  };
  const load = (sessionId: string, source: string, signal?: AbortSignal) =>
    client.callTool(
      {
        name: "load_frida_script",
        arguments: { session_id: sessionId, source_kind: "inline", source },
      },
      signal === undefined ? undefined : { signal },
    );
  return { ...native, manager, session, server, client, start, load };
};

const scriptLoadFixture = async (stage: "create" | "load" = "load") => {
  const fixture = await connectedFixture();
  const id = await fixture.start();
  const original = await fixture.load(id, "original");
  const held = gate();
  onTestFinished(held.release);
  fixture.controls[stage] = held.wait;
  return { fixture, id, original, held };
};

const pendingShutdown = async (server: { close(): Promise<void> }) => {
  let closed = false;
  const closing = server
    .close()
    .then(
      () => undefined,
      (cause: unknown) => cause,
    )
    .finally(() => {
      closed = true;
    });
  await setImmediate();
  expect(closed).toBe(false);
  return { closing };
};

const retryCancelledScriptUnload = async (
  fixture: Awaited<ReturnType<typeof connectedFixture>>,
  sessionId: string,
  scriptId = fixture.manager.status(sessionId)?.scripts[1]?.scriptId,
) => {
  if (scriptId === undefined)
    throw new Error("Cancelled script was not retained");
  const retry = await fixture.client.callTool({
    name: "unload_frida_script",
    arguments: {
      session_id: sessionId,
      script_id: scriptId,
    },
  });
  expect(retry.isError).not.toBe(true);
};

const retainedScriptObservation = async (
  fixture: Awaited<ReturnType<typeof connectedFixture>>,
  sessionId: string,
  source: string,
) => {
  const response = await fixture.client.callTool({
    name: "get_evidence_bundle",
    arguments: {},
  });
  const bundle = evidenceBundleSchema.parse(
    toolContract("get_evidence_bundle").outputSchema.parse(
      response.structuredContent,
    ).result,
  );
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const records = bundle.records.filter((record) => {
    const result = record.normalized_result;
    return (
      record.operation === "load_frida_script" &&
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      result.source_sha256 === sourceSha256
    );
  });
  expect(records).toHaveLength(1);
  expect(records[0]?.parameters).toEqual({ session_id: sessionId });
  const observation = records[0]?.normalized_result;
  if (
    observation === undefined ||
    observation === null ||
    typeof observation !== "object" ||
    Array.isArray(observation)
  )
    throw new Error("Missing retained script observation");
  expect(observation).toMatchObject({
    script_id: expect.any(String),
    source_kind: "inline",
    source_path: null,
    source_sha256: sourceSha256,
    messages_truncated: false,
  });
  return observation;
};

it.each(["load", "resume", "unload"] as const)(
  "finishes an earlier MCP %s request before closing its Frida session",
  async (operation) => {
    const fixture = await connectedFixture();
    const id = await fixture.start();
    const original = await fixture.load(id, "original");
    const scriptId = toolContract("load_frida_script").outputSchema.parse(
      original.structuredContent,
    ).normalized_result.script_id;
    const pending = fixture.client.callTool({
      name: {
        load: "load_frida_script",
        resume: "resume_frida_session",
        unload: "unload_frida_script",
      }[operation],
      arguments: {
        session_id: id,
        ...(operation === "load"
          ? { source_kind: "inline", source: "last-script" }
          : {}),
        ...(operation === "unload" ? { script_id: scriptId } : {}),
      },
    });
    const closing = fixture.client.callTool({
      name: "close_frida_session",
      arguments: { session_id: id },
    });
    expect((await pending).isError).not.toBe(true);
    expect((await closing).isError).not.toBe(true);
    expect(fixture.loaded).toEqual(
      operation === "load" ? ["original", "last-script"] : ["original"],
    );
    expect(fixture.unloaded).toEqual(fixture.loaded);
    expect(fixture.controls.detachCalls).toBe(1);
    expect(fixture.controls.resumes).toBe(1);
    expect(fixture.manager.status(id)).toBeUndefined();
  },
);

it.each(["load", "resume", "unload"] as const)(
  "does not dispatch a cancelled queued Frida %s through MCP",
  async (operation) => {
    const { fixture, id, original, held } = await scriptLoadFixture();
    const scriptId = toolContract("load_frida_script").outputSchema.parse(
      original.structuredContent,
    ).normalized_result.script_id;
    const first = fixture.load(id, "blocking");
    await held.entered;
    const controller = new AbortController();
    const cancelled =
      operation === "load"
        ? fixture.load(id, "cancelled", controller.signal)
        : fixture.client.callTool(
            {
              name:
                operation === "resume"
                  ? "resume_frida_session"
                  : "unload_frida_script",
              arguments: {
                session_id: id,
                ...(operation === "unload" ? { script_id: scriptId } : {}),
              },
            },
            { signal: controller.signal },
          );
    const rejected = expect(cancelled).rejects.toThrow(
      "cancel queued operation",
    );
    await fixture.client.ping();
    controller.abort(new Error("cancel queued operation"));
    await fixture.client.ping();
    await rejected;
    held.release();
    await first;
    await fixture.load(id, "barrier");
    expect(fixture.created).toEqual(["original", "blocking", "barrier"]);
    expect(fixture.unloaded).toEqual([]);
    expect(fixture.controls.resumes).toBe(0);
    expect(fixture.manager.status(id)?.scripts).toHaveLength(3);
  },
);

it.each(["create", "load"] as const)(
  "releases only the new script when MCP cancellation arrives during native %s",
  async (stage) => {
    const { fixture, id, held } = await scriptLoadFixture(stage);
    const controller = new AbortController();
    const cancelled = fixture.load(id, "cancelled-native", controller.signal);
    const rejected = expect(cancelled).rejects.toThrow(
      "cancel native operation",
    );
    await held.entered;
    controller.abort(new Error("cancel native operation"));
    await fixture.client.ping();
    await rejected;
    held.release();
    await fixture.load(id, "barrier");
    await fixture.client.ping();
    expect(fixture.unloaded).toEqual(["cancelled-native"]);
    expect(fixture.loaded).toEqual(
      stage === "create"
        ? ["original", "barrier"]
        : ["original", "cancelled-native", "barrier"],
    );
    expect(fixture.controls.detachCalls).toBe(0);
    expect(fixture.controls.resumes).toBe(0);
    expect(fixture.manager.status(id)?.scripts).toHaveLength(2);
    const observation = await retainedScriptObservation(
      fixture,
      id,
      "cancelled-native",
    );
    expect(observation).toMatchObject({
      messages:
        stage === "create"
          ? []
          : [expect.objectContaining({ payload: "cancelled-native" })],
      script_cleanup: "released",
      cleanup_error: null,
    });
  },
);

it("awaits an admitted attach on server shutdown and retries failed native cleanup", async () => {
  const fixture = await connectedFixture();
  const held = gate();
  onTestFinished(held.release);
  fixture.controls.attach = held.wait;
  fixture.controls.detachFailures = 1;
  const starting = fixture.client
    .callTool({
      name: "start_frida_session",
      arguments: {
        mode: "attach",
        pid: 512,
        device_id: "local",
      },
    })
    .catch(() => undefined);
  await held.entered;
  const { closing } = await pendingShutdown(fixture.server);
  expect(fixture.controls.detachCalls).toBe(0);
  held.release();
  expect(await closing).toBeInstanceOf(AggregateError);
  await starting;
  expect(fixture.controls.detachCalls).toBe(1);
  await fixture.server.close();
  expect(fixture.controls.detachCalls).toBe(2);
  await fixture.server.close();
  expect(fixture.controls.detachCalls).toBe(2);
  const afterClose = await fixture.manager.startSession({
    mode: "attach",
    pid: 512,
  });
  expect(afterClose).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
});

it("drains remote discovery before shutdown and retains failed connection cleanup", async () => {
  const fixture = await connectedFixture();
  const held = gate();
  onTestFinished(held.release);
  fixture.controls.discover = held.wait;
  fixture.controls.removalFailures = 2;
  const discovering = fixture.client
    .callTool({
      name: "list_frida_processes",
      arguments: {
        remote: { address: "127.0.0.1:27042" },
      },
    })
    .catch(() => undefined);
  await held.entered;
  const { closing } = await pendingShutdown(fixture.server);
  held.release();
  expect(await closing).toBeInstanceOf(AggregateError);
  await discovering;
  expect(fixture.controls.remoteRemovals).toBe(2);
  await fixture.server.close();
  expect(fixture.controls.remoteRemovals).toBe(3);
});

it.each(["create", "load"] as const)(
  "retains the identity of a cancelled native %s for an explicit MCP unload retry",
  async (stage) => {
    const { fixture, id, held } = await scriptLoadFixture(stage);
    fixture.controls.unloadFailures = 1;
    const controller = new AbortController();
    const cancelled = fixture.load(id, "cancelled-native", controller.signal);
    const rejected = expect(cancelled).rejects.toThrow(
      "cancel retained script",
    );
    await held.entered;
    controller.abort(new Error("cancel retained script"));
    await fixture.client.ping();
    await rejected;
    held.release();
    await fixture.load(id, "barrier");
    await fixture.client.ping();
    expect(fixture.manager.status(id)?.scripts).toHaveLength(3);
    const observation = await retainedScriptObservation(
      fixture,
      id,
      "cancelled-native",
    );
    expect(observation).toMatchObject({
      messages:
        stage === "create"
          ? []
          : [expect.objectContaining({ payload: "cancelled-native" })],
      script_cleanup: "incomplete_or_unknown",
      cleanup_error: expect.stringContaining("transient unload failure"),
    });
    const scriptId = observation.script_id;
    if (typeof scriptId !== "string")
      throw new Error("Missing cancelled script identity");
    expect(fixture.manager.status(id)?.scripts[1]?.scriptId).toBe(scriptId);
    const resuming = await fixture.client.callTool({
      name: "resume_frida_session",
      arguments: { session_id: id },
    });
    expect(resuming.isError).toBe(true);
    expect(fixture.controls.resumes).toBe(0);
    await retryCancelledScriptUnload(fixture, id, scriptId);
    expect(fixture.unloaded).toEqual(["cancelled-native", "cancelled-native"]);
    expect(fixture.loaded).toEqual(
      stage === "create"
        ? ["original", "barrier"]
        : ["original", "cancelled-native", "barrier"],
    );
    expect(fixture.manager.status(id)?.scripts).toHaveLength(2);
    expect(fixture.controls.detachCalls).toBe(0);
  },
);

it.each([0, 1])(
  "settles cancelled native-load cleanup before a queued resume (unload failures: %i)",
  async (unloadFailures) => {
    const { fixture, id, held } = await scriptLoadFixture();
    fixture.controls.unloadFailures = unloadFailures;
    const controller = new AbortController();
    const loading = fixture.load(id, "cancelled-native", controller.signal);
    const rejected = expect(loading).rejects.toThrow(
      "cancel before queued resume",
    );
    await held.entered;
    const resume = () =>
      fixture.client.callTool({
        name: "resume_frida_session",
        arguments: { session_id: id },
      });
    const resuming = resume();
    await fixture.client.ping();
    controller.abort(new Error("cancel before queued resume"));
    await fixture.client.ping();
    await rejected;
    held.release();
    const resumed = await resuming;
    await fixture.client.ping();
    expect(fixture.unloaded).toEqual(["cancelled-native"]);
    expect(fixture.scriptsAtResume).toEqual(
      unloadFailures === 0 ? [["original"]] : [],
    );
    expect(fixture.controls.detachCalls).toBe(0);
    expect(fixture.session.exportEvidenceBundle().records).toContainEqual(
      expect.objectContaining({
        operation: "load_frida_script",
        normalized_result: expect.objectContaining({
          messages: [expect.objectContaining({ payload: "cancelled-native" })],
          script_cleanup:
            unloadFailures === 0 ? "released" : "incomplete_or_unknown",
        }),
      }),
    );
    if (unloadFailures === 0) {
      expect(resumed.isError).not.toBe(true);
      expect(fixture.manager.status(id)?.scripts).toHaveLength(1);
      return;
    }
    expect(resumed.isError).toBe(true);
    expect(fixture.manager.status(id)?.state).toBe("paused");
    expect((await resume()).isError).toBe(true);
    await retryCancelledScriptUnload(fixture, id);
    expect((await resume()).isError).not.toBe(true);
    expect(fixture.scriptsAtResume).toEqual([["original"]]);
  },
);

it.each([0, 1, 2, 3, 4, 8])(
  "keeps MCP load Evidence consistent with queued resume across settlement timing %i",
  async (microtasks) => {
    const { fixture, id, held } = await scriptLoadFixture();
    const controller = new AbortController();
    fixture.controls.afterLoad = () => {
      let remaining = microtasks;
      const abort = () => {
        if (remaining-- > 0) queueMicrotask(abort);
        else controller.abort(new Error("cancel around load completion"));
      };
      abort();
    };
    const loading = fixture.load(id, "settling-native", controller.signal);
    const observed = loading.catch(() => undefined);
    await held.entered;
    const resuming = fixture.client.callTool({
      name: "resume_frida_session",
      arguments: { session_id: id },
    });
    await fixture.client.ping();
    held.release();
    await observed;
    expect((await resuming).isError).not.toBe(true);
    fixture.controls.afterLoad = () => {};
    await fixture.load(id, "barrier");
    await fixture.client.ping();
    const records = fixture.session
      .exportEvidenceBundle()
      .records.filter(
        (record) =>
          record.operation === "load_frida_script" &&
          JSON.stringify(record.normalized_result).includes("settling-native"),
      );
    expect(records).toHaveLength(1);
    const recorded = records[0]?.normalized_result;
    if (
      recorded === null ||
      typeof recorded !== "object" ||
      Array.isArray(recorded)
    )
      throw new Error("Missing script load Evidence");
    if (recorded.script_cleanup === "released") {
      expect(fixture.scriptsAtResume).toEqual([["original"]]);
      expect(fixture.unloaded).toEqual(["settling-native"]);
    } else {
      expect(recorded.script_cleanup).toBeUndefined();
      expect(fixture.scriptsAtResume).toEqual([
        ["original", "settling-native"],
      ]);
      expect(fixture.unloaded).toEqual([]);
    }
  },
);
