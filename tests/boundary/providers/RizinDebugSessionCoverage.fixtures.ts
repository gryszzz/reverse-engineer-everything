import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { RizinDebugSessionManager } from "../../../src/rizin/RizinDebugSessionManager.js";
import {
  createRizinTestManager,
  rizinTestInferiorTty,
} from "./RizinTestInferiorTty.js";
import { stopOwnedDebuggerProcess } from "../../../src/process/ownedDebuggerSession.js";
import type {
  ProviderProcessHandle,
  SpawnedOwnedProviderProcess,
} from "../../../src/process/ProviderProcess.js";

interface InjectedProcessControl {
  output(chunk: Buffer | string): void;
  stdinError(): void;
  closeStdin(): void;
  exitLeader(signal?: NodeJS.Signals): void;
  closeOutput(): void;
  exit(signal?: NodeJS.Signals): void;
}

type InjectedSpawnProcess = NonNullable<
  NonNullable<
    ConstructorParameters<typeof RizinDebugSessionManager>[1]
  >["spawnProcess"]
>;

export const incompleteStop: typeof stopOwnedDebuggerProcess = async (
  session,
  name,
) => {
  await stopOwnedDebuggerProcess(session, name);
  return { status: "incomplete", reason: "injected stop uncertainty" };
};

export const abortOnCheck = (targetCheck: number): AbortSignal => {
  let checks = 0;
  let aborted = false;
  type Listener = Parameters<AbortSignal["addEventListener"]>[1];
  const listeners = new Set<Listener>();
  return {
    get aborted() {
      checks += 1;
      if (checks >= targetCheck) aborted = true;
      return aborted;
    },
    addEventListener: (
      _type: Parameters<AbortSignal["addEventListener"]>[0],
      listener: Listener,
    ) => {
      if (listener !== null) listeners.add(listener);
    },
    removeEventListener: (
      _type: Parameters<AbortSignal["removeEventListener"]>[0],
      listener: Parameters<AbortSignal["removeEventListener"]>[1],
    ) => {
      if (listener !== null) listeners.delete(listener);
    },
    dispatchEvent: () => true,
    onabort: null,
    reason: undefined,
    throwIfAborted: () => undefined,
  } as AbortSignal;
};

export const createInjectedProcess = (
  options: {
    readonly stdin?:
      | "normal"
      | "null"
      | "destroyed"
      | "throws"
      | "throws-opaque"
      | "write-error";
    readonly onWrite?: (text: string, control: InjectedProcessControl) => void;
    readonly startup?: (control: InjectedProcessControl) => void;
    readonly beforeSpawnReturns?: () => void;
    readonly spawnError?: unknown;
  } = {},
): {
  readonly spawnProcess: InjectedSpawnProcess;
  readonly control: InjectedProcessControl;
} => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  const processHandle = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stdin: Writable | null;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  processHandle.pid = process.pid;
  processHandle.stdout = stdout;
  processHandle.stderr = stderr;
  processHandle.exitCode = exitCode;
  processHandle.signalCode = signalCode;

  const control: InjectedProcessControl = {
    output: (chunk) => stdout.emit("data", Buffer.from(chunk)),
    stdinError: () => stdin?.emit("error", new Error("injected stdin error")),
    closeStdin: () => stdin?.destroy(),
    exitLeader: (signal = "SIGTERM") => {
      exitCode = null;
      signalCode = signal;
      processHandle.exitCode = exitCode;
      processHandle.signalCode = signalCode;
      processHandle.emit("exit", exitCode, signalCode);
    },
    closeOutput: () => {
      stdout.destroy();
      stderr.destroy();
      processHandle.emit("close", exitCode, signalCode);
    },
    exit: (signal = "SIGTERM") => {
      control.exitLeader(signal);
      control.closeOutput();
    },
  };
  const stdin =
    options.stdin === "null"
      ? null
      : new Writable({
          write(chunk, _encoding, callback) {
            options.onWrite?.(Buffer.from(chunk).toString("utf8"), control);
            callback(
              options.stdin === "write-error"
                ? new Error("injected write callback failure")
                : undefined,
            );
          },
        });
  if (stdin !== null) {
    if (options.stdin === "destroyed")
      Object.defineProperty(stdin, "destroyed", { value: true });
    if (options.stdin === "throws" || options.stdin === "throws-opaque")
      stdin.write = (() => {
        if (options.stdin === "throws-opaque")
          throw "injected opaque write failure";
        throw new Error("injected synchronous write failure");
      }) as typeof stdin.write;
    processHandle.stdin = stdin;
  } else processHandle.stdin = null;
  processHandle.kill = (signal = "SIGTERM") => {
    if (exitCode !== null || signalCode !== null) return false;
    control.exit(typeof signal === "string" ? signal : "SIGTERM");
    return true;
  };

  const spawnProcess: InjectedSpawnProcess = async (spawnOptions) => {
    options.beforeSpawnReturns?.();
    if (options.spawnError !== undefined) throw options.spawnError;
    setImmediate(() => {
      if (options.startup !== undefined) options.startup(control);
      else control.output(Buffer.from([0]));
    });
    return {
      process: processHandle as unknown as ProviderProcessHandle,
      ownership: {
        runId: spawnOptions.runId,
        leaderPid: process.pid,
        processGroupId: process.pid,
        expectedParentPid: process.pid,
      },
    } satisfies SpawnedOwnedProviderProcess;
  };
  return { spawnProcess, control };
};

export const createRizinCoverageHarness = () => {
  let directory: string | undefined;
  const managers: RizinDebugSessionManager[] = [];
  const track = (manager: RizinDebugSessionManager): void => {
    managers.push(manager);
  };
  const makeProvider = async (
    body: string,
    shebang = "#!/usr/bin/env node",
  ): Promise<string> => {
    directory = await mkdtemp(join(tmpdir(), "rea-rizin-coverage-"));
    const provider = join(directory, "fake-rizin.mjs");
    await writeFile(provider, `${shebang}\n${body}\n`);
    await chmod(provider, 0o700);
    return provider;
  };
  const start = async (
    provider: string,
    options: ConstructorParameters<typeof RizinDebugSessionManager>[1] = {},
  ): Promise<{ manager: RizinDebugSessionManager; sessionId: string }> => {
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: provider },
      options,
    );
    track(manager);
    const result = await manager.start({
      path: "/tmp/coverage-target",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!result.ok) throw result.error;
    return { manager, sessionId: result.value.session_id };
  };
  const startInjected = async (
    spawnProcess: InjectedSpawnProcess,
    options: ConstructorParameters<typeof RizinDebugSessionManager>[1] = {},
  ) => {
    const manager = createRizinTestManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      { ...options, spawnProcess },
    );
    track(manager);
    const started = await manager.start({
      path: "/tmp/injected",
      inferior_tty: await rizinTestInferiorTty(),
    });
    return { manager, started };
  };
  const cleanup = async (): Promise<void> => {
    await Promise.all(
      managers
        .splice(0)
        .map((manager) => manager.closeAll().catch(() => undefined)),
    );
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
    directory = undefined;
  };
  const missingProviderPath = (): string => join(directory!, "does-not-exist");
  return {
    cleanup,
    makeProvider,
    missingProviderPath,
    start,
    startInjected,
    track,
  };
};
