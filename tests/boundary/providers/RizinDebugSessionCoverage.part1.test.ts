import { afterEach, expect, it, vi } from "vitest";
import { RizinDebugSessionManager } from "../../../src/rizin/RizinDebugSessionManager.js";
import {
  createRizinTestManager,
  stopFakeNoInferior,
  rizinTestInferiorTty,
} from "./RizinTestInferiorTty.js";
import { rizinCommand } from "../../../src/rizin/RizinCommand.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import {
  createRizinCoverageHarness,
  createInjectedProcess,
  abortOnCheck,
  incompleteStop,
} from "./RizinDebugSessionCoverage.fixtures.js";

const {
  cleanup,
  makeProvider,
  missingProviderPath,
  start,
  startInjected,
  track,
} = createRizinCoverageHarness();
afterEach(cleanup);

it.skipIf(process.platform === "win32")(
  "builds the one-shot command with the caller's path and command",
  () => {
    expect(rizinCommand({ path: "./sample file", command: "izz" })).toEqual([
      "-N",
      "-q",
      "-c",
      "izz",
      expect.stringMatching(/sample file/u),
    ]);
  },
);

it.skipIf(process.platform === "win32")(
  "rejects unsupported, pre-cancelled, and failed startup requests",
  async () => {
    const windows = createRizinTestManager({}, { platform: "win32" });
    expect(
      (
        await windows.start({
          path: "/tmp/a",
          inferior_tty: "unused-before-platform-admission",
        })
      ).ok,
    ).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    expect(
      (
        await windows.start(
          { path: "/tmp/a", inferior_tty: await rizinTestInferiorTty() },
          aborted.signal,
        )
      ).ok,
    ).toBe(false);

    const failed = await makeProvider("process.exit(9);");
    const manager = createRizinTestManager({
      REA_RIZIN_COMMAND: failed,
    });
    track(manager);
    const result = await manager.start({
      path: "/tmp/a",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(result.ok).toBe(false);

    const missing = createRizinTestManager({
      REA_RIZIN_COMMAND: missingProviderPath(),
    });
    track(missing);
    const spawnFailure = await missing.start({
      path: "/tmp/a",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(spawnFailure.ok).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "returns a startup timeout when Rizin exits before its initial frame",
  async () => {
    const provider = await makeProvider("process.exit(0);");
    const manager = createRizinTestManager({
      REA_RIZIN_COMMAND: provider,
    });
    track(manager);
    const result = await manager.start({
      path: "/tmp/early-exit",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(result.ok).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "times out startup through the frame wait when Rizin never emits a frame",
  async () => {
    let resolveSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve;
    });
    const injected = createInjectedProcess({
      startup: () => undefined,
      beforeSpawnReturns: resolveSpawned,
    });
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      {
        spawnProcess: injected.spawnProcess,
        stopProcess: async () => ({ status: "stopped" }),
      },
    );
    track(manager);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const starting = manager.start({
        path: "/tmp/no-startup-frame",
        inferior_tty: await rizinTestInferiorTty(),
      });
      await spawned;
      await vi.advanceTimersByTimeAsync(30_001);
      const result = await starting;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "does not spawn Rizin when cancellation arrives during TTY validation",
  async () => {
    let spawned = false;
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      {
        spawnProcess: async () => {
          spawned = true;
          throw new Error("must not spawn after cancellation");
        },
      },
    );
    const result = await manager.start(
      {
        path: "/tmp/cancel-before-spawn",
        inferior_tty: await rizinTestInferiorTty(),
      },
      abortOnCheck(2),
    );
    expect(result.ok).toBe(false);
    expect(spawned).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "rejects a non-TTY path before spawning Rizin",
  async () => {
    let spawned = false;
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      {
        spawnProcess: async () => {
          spawned = true;
          throw new Error("must not spawn with an invalid TTY");
        },
      },
    );
    const result = await manager.start({
      path: "/tmp/not-a-tty-target",
      inferior_tty: "/dev/null",
    });
    expect(result.ok).toBe(false);
    expect(spawned).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "closeAll drains concurrent startups and blocks later admission",
  async () => {
    let spawnCount = 0;
    let resolveSpawnCalls!: () => void;
    const bothSpawnsCalled = new Promise<void>((resolve) => {
      resolveSpawnCalls = resolve;
    });
    let releaseSpawns!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawns = resolve;
    });
    const injected = createInjectedProcess();
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      {
        spawnProcess: async (options) => {
          spawnCount += 1;
          if (spawnCount === 2) resolveSpawnCalls();
          await spawnGate;
          return injected.spawnProcess(options);
        },
        stopProcess: async () => ({ status: "stopped" }),
      },
    );
    const tty = await rizinTestInferiorTty();
    const starts = [
      manager.start({ path: "/tmp/start-one", inferior_tty: tty }),
      manager.start({ path: "/tmp/start-two", inferior_tty: tty }),
    ];
    await bothSpawnsCalled;
    let closeAllResolved = false;
    const closing = manager.closeAll().then(() => {
      closeAllResolved = true;
    });
    await Promise.resolve();
    expect(closeAllResolved).toBe(false);
    releaseSpawns();
    const started = await Promise.all(starts);
    expect(started.every((result) => result.ok)).toBe(true);
    await closing;
    expect(
      manager.status(started[0]!.ok ? started[0]!.value.session_id : "missing"),
    ).toBeUndefined();
    expect(
      (await manager.start({ path: "/tmp/after-close-all", inferior_tty: tty }))
        .ok,
    ).toBe(false);
    expect((await manager.close("missing")).ok).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "rejects an oversized initial frame instead of marking the session ready",
  async () => {
    const provider = await makeProvider(
      'process.stdout.write("x".repeat(16 * 1024 * 1024 + 1) + "\\0"); process.stdin.resume();',
    );
    const manager = createRizinTestManager({
      REA_RIZIN_COMMAND: provider,
    });
    track(manager);

    const result = await manager.start({
      path: "/tmp/oversized-startup",
      inferior_tty: await rizinTestInferiorTty(),
    });

    expect(result.ok).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "cancels startup while waiting for the initial NUL frame",
  async () => {
    let resolveSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve;
    });
    const provider = await makeProvider(
      'setTimeout(() => process.stdout.write("\\0"), 500); process.stdin.resume();',
    );
    const manager = createRizinTestManager(
      {
        REA_RIZIN_COMMAND: provider,
      },
      {
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          resolveSpawned();
          return launched;
        },
      },
    );
    track(manager);
    const abort = new AbortController();
    const starting = manager.start(
      { path: "/tmp/cancel-start", inferior_tty: await rizinTestInferiorTty() },
      abort.signal,
    );
    await spawned;
    abort.abort();
    expect((await starting).ok).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "preserves startup cleanup uncertainty after cancellation",
  async () => {
    let resolveSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve;
    });
    const provider = await makeProvider(
      "process.stdin.resume(); setInterval(() => {}, 1000);",
    );
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: provider },
      {
        stopProcess: incompleteStop,
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          resolveSpawned();
          return launched;
        },
      },
    );
    track(manager);
    const abort = new AbortController();
    const starting = manager.start(
      { path: "/tmp/cancel-start", inferior_tty: await rizinTestInferiorTty() },
      abort.signal,
    );
    await spawned;
    abort.abort();
    const result = await starting;
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain("injected stop uncertainty");
  },
);

it.skipIf(process.platform === "win32")(
  "rejects commands for missing and pre-cancelled sessions",
  async () => {
    const provider = await makeProvider(
      'process.stdout.write("\\0"); process.stdin.resume();',
    );
    const { manager, sessionId } = await start(provider);
    expect((await manager.execute("missing", "dr")).ok).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    expect((await manager.execute(sessionId, "dr", aborted.signal)).ok).toBe(
      false,
    );
    expect(manager.status(sessionId)?.state).toBe("ready");
    expect((await manager.close("missing")).ok).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "retains close failures and resolves their owner after cleanup retry",
  async () => {
    const provider = await makeProvider(
      'process.stdout.write("\\0"); process.stdin.resume();',
    );
    let stopCalls = 0;
    const { manager, sessionId } = await start(provider, {
      stopProcess: async (session, name, options) => {
        stopCalls += 1;
        if (stopCalls === 1) {
          session.launched.process.kill("SIGTERM");
          return {
            status: "incomplete",
            reason: "first stop result is uncertain",
          };
        }
        await session.supervisor.waitForExit(1000);
        return stopFakeNoInferior(session, name, options);
      },
    });
    const closed = await manager.close(sessionId);
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.error.cleanupIncomplete).toBe(true);
      expect(closed.error.cleanup?.resources).toEqual([sessionId]);
      const retainedFailure = closed.error;
      expect(await manager.retryCleanupFailures()).toEqual({
        ok: true,
        value: null,
      });
      expect(retainedFailure.cleanupIncomplete).toBe(false);
    }
    expect(stopCalls).toBe(2);
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform === "win32")(
  "retains a Rizin close owner until inherited output writers close",
  async () => {
    const injected = createInjectedProcess();
    const { manager, started } = await startInjected(injected.spawnProcess);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sessionId = started.value.session_id;
    injected.control.exitLeader();

    const firstClose = await manager.close(sessionId);
    expect(firstClose.ok).toBe(false);
    if (!firstClose.ok) {
      expect(firstClose.error.cleanupIncomplete).toBe(true);
      expect(firstClose.error.message).toMatch(/inherited output streams/i);
    }
    expect(manager.status(sessionId)).toBeDefined();

    injected.control.closeOutput();
    const retried = await manager.retryCleanupFailures();

    expect(retried).toEqual({ ok: true, value: null });
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform === "win32")(
  "closes a session after unsolicited frames make command correlation unsafe",
  async () => {
    const provider = await makeProvider(
      'process.stdout.write("\\0"); setTimeout(() => process.stdout.write("unexpected\\0"), 20); process.stdin.resume();',
    );
    const { manager, sessionId } = await start(provider);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await manager.execute(sessionId, "dr");
    expect(result.ok).toBe(false);
    expect(manager.status(sessionId)?.state).toBe("closed");
    expect((await manager.close(sessionId)).ok).toBe(true);
  },
);
