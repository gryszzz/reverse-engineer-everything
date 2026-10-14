import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { open, readFile, readlink, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isatty } from "node:tty";
import { resolve } from "node:path";

import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import type {
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  closeOwnedDebuggerSessions,
  stopOwnedDebuggerProcess,
  verifyOwnedInferiorsEnded,
  type OwnedInferiorIdentity,
  type OwnedDebuggerDetachResult,
} from "../process/ownedDebuggerSession.js";

const MAX_SESSIONS = 8;
const MAX_PENDING_COMMANDS = 16;
const FRAME_TIMEOUT_MS = 120_000;
const CLEANUP_COMMAND_TIMEOUT_MS = 1_000;
const STARTUP_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 4096;
const MIN_QUEUED_FRAME_CHARGE_BYTES = 64;
const MAX_COMMAND_FRAMES = 4096;
const MAX_RECENT_FRAME_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export const RIZIN_DEBUGGER_PROVIDER_IDENTITY = {
  id: "rizin.debugger",
  name: "Rizin debugger",
  version: null,
} as const;

interface RizinLaunchProvenance {
  readonly caller_selected_path: string;
  readonly resolved_path: string;
}

const RIZIN_LAUNCH_PROVENANCE_LIMITATION =
  "Launch provenance records the original and resolved startup paths; it does not establish the current target after unrestricted debugger commands.";

interface RizinCommandEvidenceInput {
  readonly sessionId: string;
  readonly command: string;
  readonly result: RizinDebugCommandResult;
  readonly inferiorTty: string;
  readonly launchProvenance: RizinLaunchProvenance;
  readonly limitations: readonly string[];
}

const createRizinCommandEvidence = ({
  sessionId,
  command,
  result,
  inferiorTty,
  launchProvenance,
  limitations,
}: RizinCommandEvidenceInput): Evidence =>
  createEvidence(undefined, RIZIN_DEBUGGER_PROVIDER_IDENTITY, {
    predicateType: "rea.debugger.command-observation",
    operation: "rizin_debug_command",
    parameters: {
      session_id: sessionId,
      command,
      inferior_tty: inferiorTty,
      launch_provenance: { ...launchProvenance },
    },
    result: { ...result },
    rawResult: { ...result },
    subjectUnavailableReason:
      "The current debugger target identity is not established by the Rizin session identifier.",
    limitations: [
      ...limitations,
      ...(result.output_invalid_utf8
        ? [
            "Collected command frames contained invalid UTF-8 bytes; decoded text may contain replacement characters.",
          ]
        : []),
      RIZIN_LAUNCH_PROVENANCE_LIMITATION,
    ],
  });

export class RizinCommandTimeoutError extends Error {
  constructor(
    readonly partialOutput: string,
    readonly outputInvalidUtf8 = false,
  ) {
    super("Timed out waiting for Rizin's command-completion marker");
  }
}

export const isRizinCommandDeadlineExpired = (remainingMs: number): boolean =>
  remainingMs <= 0;

export const createRizinCommandTimeoutError = (
  partialFrames: readonly string[],
  outputInvalidUtf8 = false,
): RizinCommandTimeoutError =>
  new RizinCommandTimeoutError(partialFrames.join("\n"), outputInvalidUtf8);

interface RizinCommandTimeoutEvidenceInput {
  readonly sessionId: string;
  readonly command: string;
  readonly result: RizinDebugCommandResult;
  readonly inferiorTty: string;
  readonly cleanupFailure: string | undefined;
  readonly launchProvenance: RizinLaunchProvenance;
}

export const createRizinCommandTimeoutEvidence = ({
  sessionId,
  command,
  result,
  inferiorTty,
  cleanupFailure,
  launchProvenance,
}: RizinCommandTimeoutEvidenceInput): Evidence =>
  createRizinCommandEvidence({
    sessionId,
    command,
    result,
    inferiorTty,
    launchProvenance,
    limitations: [
      "The command timed out before its completion marker; retained output is partial and completion is unknown.",
      ...(result.output_invalid_utf8
        ? [
            "Collected command frame bytes did not form valid UTF-8; displayed output contains replacement characters.",
          ]
        : []),
      ...(cleanupFailure === undefined
        ? [
            "The owned debugger session was stopped because output correlation could no longer be guaranteed.",
          ]
        : [
            `The owned debugger session remains retained because cleanup could not be verified: ${cleanupFailure}`,
          ]),
      "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
    ],
  });

interface RizinDebugSession {
  readonly id: string;
  readonly launched: SpawnedOwnedProviderProcess;
  readonly supervisor: ProviderProcessSupervisor;
  readonly frames: Array<{
    readonly frame: RizinFrame;
    readonly queueChargeBytes: number;
  }>;
  readonly frameWaiters: Array<{
    readonly resolve: (frame: RizinFrame) => void;
    readonly reject: (cause: Error) => void;
  }>;
  readonly backend: string | null;
  readonly launchProvenance: RizinLaunchProvenance;
  readonly inferiorTty: string;
  readonly inferiorTtyDevice: number;
  readonly inferiorTtyInode: number;
  readonly knownInferiorIdentities: Map<string, OwnedInferiorIdentity>;
  inferiorInventoryComplete: boolean;
  inferiorStateUnknown: () => boolean;
  verifyInferiorsEndedAfterExit: () => Promise<boolean>;
  readonly detachInferior: () => Promise<OwnedDebuggerDetachResult>;
  cleanupCommandTurnHeld: boolean;
  stopAttempt: ReturnType<typeof stopOwnedDebuggerProcess> | undefined;
  readonly cleanupFailures: Set<AnalysisError>;
  pendingCommandCount: number;
  invalidUtf8Observed: boolean;
  closing: boolean;
  readonly history: string[];
  queuedFrameBytes: number;
  historyTruncated: boolean;
  frameChunks: Buffer[];
  bufferedFrameBytes: number;
  ready: boolean;
  exited: boolean;
  commandTail: Promise<void>;
  protocolError: string | undefined;
  commandCaptureActive: boolean;
  discardingOversizedFrame: boolean;
}

interface RizinFrame {
  readonly text: string;
  readonly truncated: boolean;
  readonly invalidUtf8: boolean;
}

class RizinProcessExitError extends Error {
  constructor(
    readonly partialOutput: string,
    readonly outputInvalidUtf8 = false,
  ) {
    super("Rizin process exited before completing the active command");
  }
}

class RizinCommandCancelledError extends AnalysisCancelledError {
  constructor(
    readonly partialOutput: string,
    readonly outputInvalidUtf8: boolean,
    cause: unknown,
  ) {
    super("rizin_debug_command", {
      cause,
      capturedOutput: {
        stdout: partialOutput,
        stderr: "",
        truncated: false,
      },
    });
  }
}

class RizinFrameTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the next Rizin NUL frame");
  }
}

/** Owns persistent Rizin debugger processes independently from BinarySession. */
export class RizinDebugSessionManager {
  readonly #sessions = new Map<string, RizinDebugSession>();
  #activeStarts = 0;
  #sessionReservations = 0;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  #closingAll = false;
  readonly #startDrainWaiters: Array<() => void> = [];
  readonly #command: string;
  readonly #frameTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  readonly #maxCommandOutputBytes: number;
  readonly #platform: NodeJS.Platform;
  readonly #stopProcess: typeof stopOwnedDebuggerProcess;
  readonly #spawnProcess: typeof spawnOwnedProviderProcess;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
    options: {
      readonly frameTimeoutMs?: number;
      /** @internal Test seam; production callers should use the 30 s default. */
      readonly startupTimeoutMs?: number;
      /** @internal Test seam; production callers should use the 16 MiB default. */
      readonly maxCommandOutputBytes?: number;
      readonly platform?: NodeJS.Platform;
      readonly stopProcess?: typeof stopOwnedDebuggerProcess;
      readonly spawnProcess?: typeof spawnOwnedProviderProcess;
    } = {},
  ) {
    this.#environment = { ...environment };
    this.#command = environment.REA_RIZIN_COMMAND ?? "rizin";
    this.#frameTimeoutMs = options.frameTimeoutMs ?? FRAME_TIMEOUT_MS;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.#maxCommandOutputBytes =
      options.maxCommandOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;
    this.#platform = options.platform ?? process.platform;
    this.#stopProcess = options.stopProcess ?? stopOwnedDebuggerProcess;
    this.#spawnProcess = options.spawnProcess ?? spawnOwnedProviderProcess;
  }

  async start(
    input: {
      readonly path: string;
      readonly inferior_tty: string;
      readonly backend?: string;
    },
    signal?: AbortSignal,
  ): Promise<
    Result<
      { readonly session_id: string; readonly backend: string | null },
      AnalysisError
    >
  > {
    if (this.#closingAll)
      return err(new AnalysisInputError("start_rizin_debug_session"));
    const occupied = this.#sessions.size + this.#sessionReservations;
    if (occupied >= MAX_SESSIONS)
      return err(
        new AnalysisResourceConstraintError(
          "start_rizin_debug_session",
          "memory",
          "Rizin session capacity reached.",
          { max_sessions: MAX_SESSIONS, active_or_reserved_sessions: occupied },
        ),
      );
    this.#activeStarts += 1;
    this.#sessionReservations += 1;
    let reserved = true;
    const releaseReservation = () => {
      if (!reserved) return;
      reserved = false;
      this.#sessionReservations -= 1;
    };
    try {
      return await this.#start(input, signal, releaseReservation);
    } finally {
      releaseReservation();
      this.#activeStarts -= 1;
      if (this.#activeStarts === 0)
        for (const resolve of this.#startDrainWaiters.splice(0)) resolve();
    }
  }

  async #start(
    input: {
      readonly path: string;
      readonly inferior_tty: string;
      readonly backend?: string;
    },
    signal: AbortSignal | undefined,
    releaseReservation: () => void,
  ): Promise<
    Result<
      { readonly session_id: string; readonly backend: string | null },
      AnalysisError
    >
  > {
    if (signal?.aborted)
      return err(new AnalysisCancelledError("start_rizin_debug_session"));
    if (this.#platform !== "linux")
      return err(
        new AnalysisCapabilityUnavailableError(
          "rizin",
          "start_rizin_debug_session",
          "Persistent Rizin debugger sessions require Linux /proc descriptor readback to verify inferior detachment and output routing.",
        ),
      );
    if (input.inferior_tty === undefined || input.inferior_tty.length === 0)
      return err(new AnalysisInputError("start_rizin_debug_session"));
    let ttyPath: string;
    let ttyDevice: number;
    let ttyInode: number;
    try {
      ttyPath = await realpath(input.inferior_tty);
      const ttyHandle = await open(
        ttyPath,
        fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK,
      );
      try {
        const ttyStat = await ttyHandle.stat();
        if (
          !isatty(ttyHandle.fd) ||
          (ttyStat.mode & fsConstants.S_IFMT) !== fsConstants.S_IFCHR
        )
          throw new Error("The selected inferior_tty is not a character TTY.");
        ttyDevice = ttyStat.dev;
        ttyInode = ttyStat.ino;
      } finally {
        await ttyHandle.close();
      }
    } catch (cause) {
      return err(
        new AnalysisInputError("start_rizin_debug_session", { cause }),
      );
    }
    // TTY identity validation is asynchronous. Cancellation may arrive while
    // realpath/open/stat are pending, and must prevent the debugger spawn.
    if (signal?.aborted)
      return err(new AnalysisCancelledError("start_rizin_debug_session"));
    const id = randomUUID();
    const resolvedPath = resolve(input.path);
    const launchProvenance: RizinLaunchProvenance = {
      caller_selected_path: input.path,
      resolved_path: resolvedPath,
    };
    const arguments_ = [
      "-N",
      "-0",
      "-d",
      "-R",
      `stdout=${ttyPath}`,
      "-R",
      `stderr=${ttyPath}`,
      "-e",
      "dbg.exitkills=false",
      ...(input.backend === undefined ? [] : ["-D", input.backend]),
      resolvedPath,
    ];
    let launched: SpawnedOwnedProviderProcess;
    try {
      launched = await this.#spawnProcess({
        command: this.#command,
        arguments: arguments_,
        hostEnvironment: this.#environment,
        runId: id,
        stdin: "pipe",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      if (signal?.aborted)
        return err(
          new AnalysisCancelledError("start_rizin_debug_session", { cause }),
        );
      return err(
        new AnalysisCapabilityUnavailableError(
          "rizin",
          "start_rizin_debug_session",
          cause instanceof Error
            ? cause.message
            : "Unable to start Rizin debugger",
        ),
      );
    }
    const session: RizinDebugSession = {
      id,
      launched,
      launchProvenance,
      backend: input.backend ?? null,
      inferiorTty: ttyPath,
      inferiorTtyDevice: ttyDevice,
      inferiorTtyInode: ttyInode,
      knownInferiorIdentities: new Map(),
      inferiorInventoryComplete: false,
      inferiorStateUnknown: () => !session.inferiorInventoryComplete,
      verifyInferiorsEndedAfterExit: async () => {
        if (!session.inferiorInventoryComplete) return false;
        const ended = await verifyOwnedInferiorsEnded(
          session.knownInferiorIdentities.values(),
        );
        if (ended) session.knownInferiorIdentities.clear();
        return ended;
      },
      detachInferior: () =>
        session.cleanupCommandTurnHeld
          ? this.#detachInferiorUnlocked(session)
          : this.#detachInferior(session),
      cleanupCommandTurnHeld: false,
      stopAttempt: undefined,
      cleanupFailures: new Set(),
      pendingCommandCount: 0,
      invalidUtf8Observed: false,
      closing: false,
      supervisor: new ProviderProcessSupervisor(
        { process: launched.process, ownsProcessLifetime: false },
        {
          captureStdout: false,
          maxDiagnosticBytes: MAX_DIAGNOSTIC_BYTES,
        },
      ),
      frames: [],
      frameWaiters: [],
      history: [],
      queuedFrameBytes: 0,
      historyTruncated: false,
      frameChunks: [],
      bufferedFrameBytes: 0,
      ready: false,
      exited: false,
      commandTail: Promise.resolve(),
      protocolError: undefined,
      commandCaptureActive: false,
      discardingOversizedFrame: false,
    };
    this.#sessions.set(id, session);
    releaseReservation();
    launched.process.stdout?.on("data", (chunk: Buffer | string) =>
      this.#receive(session, Buffer.from(chunk)),
    );
    launched.process.stdin?.on("error", (cause: Error) =>
      this.#failProtocol(
        session,
        `Rizin stdin stream failed: ${cause.message}`,
      ),
    );
    launched.process.stdin?.once("close", () => {
      if (!session.exited && session.protocolError === undefined)
        this.#failProtocol(session, "Rizin stdin stream closed unexpectedly.");
    });
    launched.process.once("exit", () => {
      session.exited = true;
      for (const waiter of session.frameWaiters)
        waiter.reject(new RizinProcessExitError(""));
      session.frameWaiters.length = 0;
    });
    try {
      await waitForFrame(session, this.#startupTimeoutMs, signal);
      // Let process and stream lifecycle notifications queued alongside the
      // initial frame run before publishing the session as ready.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted)
        throw new AnalysisCancelledError("start_rizin_debug_session");
      if (session.exited)
        throw new RizinProcessExitError("Rizin exited during startup.");
      if (session.protocolError !== undefined)
        throw new Error(session.protocolError);
      session.ready = true;
      return ok({ session_id: id, backend: input.backend ?? null });
    } catch (cause) {
      const stopped = await this.#stopDebuggerOnly(session);
      const capturedOutput = this.#startupCapturedOutput(session);
      if (stopped.status !== "incomplete") this.#sessions.delete(id);
      if (stopped.status === "incomplete")
        return err(
          this.#retainCleanupFailure(
            session,
            "start_rizin_debug_session",
            stopped.reason,
            { cause, capturedOutput },
          ),
        );
      if (signal?.aborted || cause instanceof AnalysisCancelledError)
        return err(
          new AnalysisCancelledError("start_rizin_debug_session", {
            cause,
            capturedOutput,
          }),
        );
      if (session.protocolError !== undefined)
        return err(
          new AnalysisCapabilityUnavailableError(
            "rizin",
            "start_rizin_debug_session",
            session.protocolError,
            { cause, capturedOutput },
          ),
        );
      if (cause instanceof RizinProcessExitError) {
        return err(
          new AnalysisCapabilityUnavailableError(
            "rizin",
            "start_rizin_debug_session",
            cause.message,
            {
              cause,
              capturedOutput,
            },
          ),
        );
      }
      return err(
        new AnalysisTimeoutError(
          "start_rizin_debug_session",
          this.#startupTimeoutMs,
          { cause, capturedOutput },
        ),
      );
    }
  }

  async execute(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<
    Result<
      { readonly result: RizinDebugCommandResult; readonly evidence: Evidence },
      AnalysisError
    >
  > {
    const session = this.#sessions.get(sessionId);
    if (
      session === undefined ||
      !session.ready ||
      session.exited ||
      session.protocolError !== undefined ||
      session.closing ||
      this.#closingAll
    )
      return err(new AnalysisInputError("rizin_debug_command"));
    if (signal?.aborted)
      return err(new AnalysisCancelledError("rizin_debug_command"));
    if (session.pendingCommandCount >= MAX_PENDING_COMMANDS)
      return err(
        new AnalysisResourceConstraintError(
          "rizin_debug_command",
          "transport",
          "Rizin command queue capacity reached.",
          {
            max_pending_commands: MAX_PENDING_COMMANDS,
            active_or_queued_commands: session.pendingCommandCount,
          },
        ),
      );
    session.pendingCommandCount += 1;
    let release: (() => void) | undefined;
    let acquired = false;
    let commandSent = false;
    const previous = session.commandTail;
    session.commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForTurn(previous, signal);
      acquired = true;
      if (signal?.aborted)
        return err(new AnalysisCancelledError("rizin_debug_command"));
      if (
        !session.ready ||
        session.exited ||
        session.closing ||
        this.#closingAll ||
        session.protocolError !== undefined
      )
        return err(new AnalysisInputError("rizin_debug_command"));
      if (session.frames.length > 0) {
        const message =
          "Unsolicited Rizin frames arrived before a command; command output can no longer be safely correlated.";
        this.#failProtocol(session, message);
        return err(
          await this.#stopAfterProtocolFailure(session, undefined, true),
        );
      }
      const marker = `__REA_COMMAND_COMPLETE_${randomUUID().replaceAll("-", "")}__`;
      // Arbitrary debugger commands can create or replace inferiors. Discard
      // the prior inventory before any command bytes reach the provider.
      session.inferiorInventoryComplete = false;
      session.knownInferiorIdentities.clear();
      commandSent = true;
      const stdin = session.launched.process.stdin;
      if (
        stdin === null ||
        stdin === undefined ||
        stdin.destroyed ||
        !stdin.writable
      ) {
        this.#failProtocol(session, "Rizin stdin stream is closed.");
      } else {
        try {
          stdin.write(
            `${command}\n!echo ${marker}\n`,
            "utf8",
            (cause?: Error | null) => {
              if (cause)
                this.#failProtocol(
                  session,
                  `Rizin stdin write failed: ${cause.message}`,
                );
            },
          );
        } catch (cause) {
          this.#failProtocol(
            session,
            `Rizin stdin write failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
          );
        }
      }
      if (session.protocolError !== undefined)
        throw new Error(session.protocolError);
      session.commandCaptureActive = true;
      const captured = await waitForCommandFrames(
        session,
        marker,
        this.#frameTimeoutMs,
        signal,
        this.#maxCommandOutputBytes,
      );
      if (signal?.aborted)
        throw new AnalysisCancelledError("rizin_debug_command");
      let cleanupFailure: string | undefined;
      if (captured.outputTruncated) {
        // Stryker disable next-line BooleanLiteral -- `waitForCommandFrames` sets `protocolError` before reporting truncation; both detach wrappers therefore fail closed before a queued command can be awaited, so the held-tail flag cannot change this public path.
        const stopped = await this.#stopDebuggerOnly(session, true);
        if (stopped.status === "incomplete") cleanupFailure = stopped.reason;
      }
      const result = {
        command,
        output: captured.output,
        output_scope: "command_and_interleaved_session_output" as const,
        output_truncated: captured.outputTruncated,
        completion_status: captured.outputTruncated
          ? ("unknown" as const)
          : ("complete" as const),
        backend: session.backend,
        ...(captured.outputInvalidUtf8
          ? { output_invalid_utf8: true as const }
          : {}),
      };
      const evidence = createRizinCommandEvidence({
        sessionId,
        command,
        result,
        inferiorTty: session.inferiorTty,
        launchProvenance: session.launchProvenance,
        limitations: [
          "Rizin commands and debugger effects depend on the loaded IO plugin and target.",
          "Output contains all NUL frames through an explicit command-completion marker; backend output interleaved before that marker cannot be distinguished from command output.",
          ...(captured.outputTruncated
            ? [
                `The Rizin command exceeded the output or frame limit. Retained output is partial and command completion is unknown.${cleanupFailure === undefined ? " The owned debugger session was stopped." : ` The owned debugger session remains retained because cleanup could not be verified: ${cleanupFailure}`}`,
              ]
            : []),
          "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
        ],
      });
      if (cleanupFailure !== undefined)
        return err(
          this.#retainCleanupFailure(
            session,
            "rizin_debug_command",
            cleanupFailure,
            {
              partialObservation: evidence,
            },
          ),
        );
      return ok({ result, evidence });
    } catch (cause) {
      if (signal?.aborted || cause instanceof AnalysisCancelledError) {
        if (!commandSent)
          return err(
            new AnalysisCancelledError("rizin_debug_command", { cause }),
          );
        const partialOutput =
          cause instanceof RizinCommandCancelledError
            ? cause.partialOutput
            : undefined;
        const commandInvalidUtf8 =
          cause instanceof RizinCommandCancelledError &&
          cause.outputInvalidUtf8;
        const partialEvidence =
          partialOutput === undefined
            ? undefined
            : createRizinCommandEvidence({
                sessionId,
                command,
                result: {
                  command,
                  output: partialOutput,
                  output_scope: "command_and_interleaved_session_output",
                  output_truncated: false,
                  completion_status: "unknown",
                  backend: session.backend,
                  ...(commandInvalidUtf8
                    ? { output_invalid_utf8: true as const }
                    : {}),
                },
                inferiorTty: session.inferiorTty,
                launchProvenance: session.launchProvenance,
                limitations: [
                  "The Rizin command was cancelled; collected frame output is partial and command completion is unknown.",
                  "The owned debugger session was stopped because command output can no longer be correlated safely.",
                  "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
                ],
              });
        session.protocolError =
          "A Rizin command was cancelled; the owned session was stopped because command output can no longer be correlated safely.";
        const stopped = await this.#stopDebuggerOnly(session, true);
        if (stopped.status === "incomplete")
          return err(
            this.#retainCleanupFailure(
              session,
              "rizin_debug_command",
              stopped.reason,
              {
                cause: new AnalysisCancelledError("rizin_debug_command", {
                  cause,
                  ...(cause instanceof RizinCommandCancelledError
                    ? { capturedOutput: cause.capturedOutput }
                    : {}),
                }),
                ...(partialEvidence === undefined
                  ? {}
                  : { partialObservation: partialEvidence }),
              },
            ),
          );
        return err(
          new AnalysisCancelledError("rizin_debug_command", {
            cause,
            ...(cause instanceof RizinCommandCancelledError
              ? { capturedOutput: cause.capturedOutput }
              : {}),
            ...(partialEvidence === undefined
              ? {}
              : { partialObservation: partialEvidence }),
          }),
        );
      }
      if (session.protocolError !== undefined)
        return err(await this.#stopAfterProtocolFailure(session, cause, true));
      if (cause instanceof RizinCommandTimeoutError) {
        session.protocolError =
          "Rizin command timed out before its completion marker; output correlation is no longer safe.";
        const stopped = await this.#stopDebuggerOnly(session, true);
        const result: RizinDebugCommandResult = {
          command,
          output: cause.partialOutput,
          output_scope: "command_and_interleaved_session_output",
          output_truncated: true,
          completion_status: "unknown",
          backend: session.backend,
          ...(cause.outputInvalidUtf8
            ? { output_invalid_utf8: true as const }
            : {}),
        };
        const evidence = createRizinCommandTimeoutEvidence({
          sessionId,
          command,
          result,
          inferiorTty: session.inferiorTty,
          cleanupFailure:
            stopped.status === "incomplete" ? stopped.reason : undefined,
          launchProvenance: session.launchProvenance,
        });
        if (stopped.status === "incomplete")
          return err(
            this.#retainCleanupFailure(
              session,
              "rizin_debug_command",
              stopped.reason,
              {
                cause,
                partialObservation: evidence,
              },
            ),
          );
        return ok({ result, evidence });
      }
      if (cause instanceof RizinProcessExitError) {
        const result: RizinDebugCommandResult = {
          command,
          output: cause.partialOutput,
          output_scope: "command_and_interleaved_session_output",
          output_truncated: false,
          completion_status: "unknown",
          backend: session.backend,
          ...(cause.outputInvalidUtf8
            ? { output_invalid_utf8: true as const }
            : {}),
        };
        const evidence = createRizinCommandEvidence({
          sessionId,
          command,
          result,
          inferiorTty: session.inferiorTty,
          launchProvenance: session.launchProvenance,
          limitations: [
            "Rizin exited before the command-completion marker; retained frame output is partial and command completion is unknown.",
            "The command is unrestricted and may access local files, the shell, network, or mutate the target.",
          ],
        });
        const stopped = await this.#stopDebuggerOnly(session, true);
        if (stopped.status === "incomplete")
          return err(
            this.#retainCleanupFailure(
              session,
              "rizin_debug_command",
              stopped.reason,
              { cause, partialObservation: evidence },
            ),
          );
        return ok({ result, evidence });
      }
      session.protocolError =
        "Rizin did not return the current command-completion marker; the session was stopped to prevent late output from being attributed to a later command.";
      const stopped = await this.#stopDebuggerOnly(session, true);
      if (stopped.status === "incomplete")
        return err(
          this.#retainCleanupFailure(
            session,
            "rizin_debug_command",
            stopped.reason,
            { cause },
          ),
        );
      return err(
        new AnalysisTimeoutError("rizin_debug_command", this.#frameTimeoutMs, {
          cause,
        }),
      );
    } finally {
      if (acquired) {
        session.commandCaptureActive = false;
        session.pendingCommandCount -= 1;
        release?.();
      } else
        void previous.then(() => {
          session.pendingCommandCount -= 1;
          release?.();
        });
    }
  }

  status(sessionId: string):
    | {
        readonly session_id: string;
        readonly state: "ready" | "closed";
        readonly inferior_tty: string;
        readonly recent_output: readonly string[];
        readonly recent_output_truncated: boolean;
        readonly diagnostics_truncated: boolean;
        readonly output_invalid_utf8: boolean;
      }
    | undefined {
    const session = this.#sessions.get(sessionId);
    return session === undefined
      ? undefined
      : {
          session_id: session.id,
          state:
            session.exited ||
            session.protocolError !== undefined ||
            session.closing ||
            !session.ready
              ? "closed"
              : "ready",
          inferior_tty: session.inferiorTty,
          recent_output: [...session.history],
          recent_output_truncated: session.historyTruncated,
          diagnostics_truncated:
            session.supervisor.snapshot().diagnosticTruncated === true,
          output_invalid_utf8: session.invalidUtf8Observed,
        };
  }

  async close(
    sessionId: string,
  ): Promise<Result<{ readonly target_state: "unknown" }, AnalysisError>> {
    if (this.#closingAll)
      return err(new AnalysisInputError("close_rizin_debug_session"));
    const session = this.#sessions.get(sessionId);
    if (session === undefined)
      return err(new AnalysisInputError("close_rizin_debug_session"));
    session.closing = true;
    const stopped = await this.#stopDebuggerOnly(session);
    if (stopped.status === "incomplete")
      return err(
        this.#retainCleanupFailure(
          session,
          "close_rizin_debug_session",
          stopped.reason,
        ),
      );
    this.#sessions.delete(sessionId);
    return ok({ target_state: "unknown" });
  }

  async retryCleanupFailures(): Promise<Result<null, AnalysisError>> {
    for (const session of this.#sessions.values()) {
      if (session.cleanupFailures.size === 0) continue;
      const stopped = await this.#stopDebuggerOnly(session);
      if (stopped.status === "incomplete")
        return err(
          [...session.cleanupFailures].at(-1) ??
            this.#retainCleanupFailure(
              session,
              "close_rizin_debug_session",
              stopped.reason,
            ),
        );
      this.#sessions.delete(session.id);
    }
    return ok(null);
  }

  async closeAll(): Promise<void> {
    this.#closingAll = true;
    if (this.#activeStarts > 0)
      await new Promise<void>((resolve) =>
        this.#startDrainWaiters.push(resolve),
      );
    for (const session of this.#sessions.values()) session.closing = true;
    return closeOwnedDebuggerSessions(
      this.#sessions,
      (session) => this.#stopDebuggerOnly(session),
      "Rizin",
    );
  }

  #receive(session: RizinDebugSession, chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const boundary = chunk.indexOf(0, offset);
      const end = boundary < 0 ? chunk.length : boundary;
      const nextOffset = boundary + 1;
      if (boundary >= 0 && nextOffset <= offset) {
        this.#failProtocol(
          session,
          "Rizin frame parser failed to advance past a NUL delimiter.",
        );
        return;
      }
      const piece = chunk.subarray(offset, end);
      if (session.discardingOversizedFrame) {
        if (boundary < 0) return;
        session.discardingOversizedFrame = false;
        this.#deliverBufferedFrame(session, true);
        offset = nextOffset;
        continue;
      }
      if (session.bufferedFrameBytes + piece.length > MAX_FRAME_BYTES) {
        const message =
          "Rizin emitted an NUL frame exceeding the 16 MiB protocol limit.";
        if (!session.commandCaptureActive) {
          this.#failProtocol(session, message);
          return;
        }
        session.protocolError = message;
        session.historyTruncated = true;
        const remainingBytes = MAX_FRAME_BYTES - session.bufferedFrameBytes;
        if (remainingBytes > 0) {
          session.frameChunks.push(
            Buffer.from(piece.subarray(0, remainingBytes)),
          );
          session.bufferedFrameBytes += remainingBytes;
        }
        if (boundary < 0) {
          session.discardingOversizedFrame = true;
          return;
        }
        this.#deliverBufferedFrame(session, true);
        offset = nextOffset;
        continue;
      }
      if (piece.length > 0) {
        session.frameChunks.push(Buffer.from(piece));
        session.bufferedFrameBytes += piece.length;
      }
      if (boundary < 0) return;
      this.#deliverBufferedFrame(session, false);
      offset = nextOffset;
    }
  }

  #deliverBufferedFrame(session: RizinDebugSession, truncated: boolean): void {
    const frameBytes = Buffer.concat(
      session.frameChunks,
      session.bufferedFrameBytes,
    );
    session.frameChunks = [];
    session.bufferedFrameBytes = 0;
    const invalidUtf8 = !isUtf8(frameBytes);
    session.invalidUtf8Observed ||= invalidUtf8;
    this.#deliverFrame(
      session,
      { text: frameBytes.toString("utf8"), truncated, invalidUtf8 },
      frameBytes.length,
    );
  }

  #startupCapturedOutput(session: RizinDebugSession) {
    const output = session.supervisor.snapshot();
    const partialFrame =
      session.bufferedFrameBytes === 0
        ? ""
        : Buffer.concat(
            session.frameChunks,
            session.bufferedFrameBytes,
          ).toString("utf8");
    const protocolOutput = [...session.history, partialFrame]
      .filter((frame) => frame.length > 0)
      .join("\n");
    const protocolBytes = Buffer.from(protocolOutput, "utf8");
    let stdoutBytes = Math.min(protocolBytes.length, MAX_DIAGNOSTIC_BYTES);
    while (
      stdoutBytes > 0 &&
      stdoutBytes < protocolBytes.length &&
      (protocolBytes[stdoutBytes]! & 0xc0) === 0x80
    )
      stdoutBytes -= 1;
    return {
      stdout: protocolBytes.subarray(0, stdoutBytes).toString("utf8"),
      stderr: output.stderr.text,
      truncated:
        session.historyTruncated ||
        protocolBytes.length > stdoutBytes ||
        output.diagnosticTruncated === true ||
        output.stdout.observedBytes > output.stdout.bytes ||
        output.stderr.observedBytes > output.stderr.bytes,
    };
  }

  #deliverFrame(
    session: RizinDebugSession,
    frame: RizinFrame,
    frameBytes: number,
  ): void {
    const historyFrame =
      frameBytes > MAX_RECENT_FRAME_BYTES || frame.truncated
        ? `${frame.text.slice(0, MAX_RECENT_FRAME_BYTES)}[recent frame truncated]`
        : frame.text;
    if (frameBytes > MAX_RECENT_FRAME_BYTES || frame.truncated)
      session.historyTruncated = true;
    session.history.push(historyFrame);
    if (session.history.length > 64) {
      session.history.splice(0, session.history.length - 64);
      session.historyTruncated = true;
    }
    const waiter = session.frameWaiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(frame);
      return;
    }
    const queueChargeBytes = Math.max(
      frameBytes,
      MIN_QUEUED_FRAME_CHARGE_BYTES,
    );
    if (
      session.frames.length >= MAX_QUEUED_FRAMES ||
      session.queuedFrameBytes + queueChargeBytes > MAX_QUEUED_FRAME_BYTES
    ) {
      this.#failProtocol(
        session,
        "Rizin produced unsolicited frames exceeding the bounded queue limit.",
      );
      return;
    }
    session.frames.push({ frame, queueChargeBytes });
    session.queuedFrameBytes += queueChargeBytes;
  }

  #failProtocol(session: RizinDebugSession, message: string): void {
    session.protocolError = message;
    session.frameChunks = [];
    session.bufferedFrameBytes = 0;
    for (const waiter of session.frameWaiters)
      waiter.reject(new Error(message));
    session.frameWaiters.length = 0;
  }

  #stopDebuggerOnly(session: RizinDebugSession, commandTurnHeld = false) {
    session.closing = true;
    if (session.stopAttempt !== undefined) return session.stopAttempt;
    session.cleanupCommandTurnHeld = commandTurnHeld;
    session.stopAttempt = Promise.resolve()
      .then(() =>
        this.#stopProcess(session, "Rizin debugger", {
          platform: this.#platform,
        }),
      )
      .then((stopped) => {
        if (stopped.status !== "incomplete") {
          for (const failure of session.cleanupFailures)
            failure.resolveCleanup();
          session.cleanupFailures.clear();
        }
        return stopped;
      })
      .finally(() => {
        session.stopAttempt = undefined;
      });
    return session.stopAttempt;
  }

  async #detachInferior(
    session: RizinDebugSession,
  ): Promise<
    | { readonly status: "no-inferior" }
    | { readonly status: "detached"; readonly outputSink: "durable" }
  > {
    if (session.exited || session.protocolError !== undefined)
      throw new Error(
        "Rizin protocol state is ambiguous; inferior detach is unverified.",
      );
    const previous = session.commandTail;
    let release!: () => void;
    session.commandTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await this.#detachInferiorUnlocked(session);
    } finally {
      release();
    }
  }

  async #detachInferiorUnlocked(
    session: RizinDebugSession,
  ): Promise<
    | { readonly status: "no-inferior" }
    | { readonly status: "detached"; readonly outputSink: "durable" }
  > {
    if (session.exited || session.protocolError !== undefined)
      throw new Error(
        "Rizin protocol state is ambiguous; inferior detach is unverified.",
      );
    {
      session.inferiorInventoryComplete = false;
      session.knownInferiorIdentities.clear();
      const initial = parseRizinPtraceRows(
        await this.#runInternalCommand(session, "olj"),
      );
      const inferior = initial;
      if (inferior.length === 0) {
        session.knownInferiorIdentities.clear();
        session.inferiorInventoryComplete = true;
        return { status: "no-inferior" };
      }
      session.knownInferiorIdentities.clear();
      for (const [, pid] of inferior) {
        if (session.knownInferiorIdentities.has(pid)) continue;
        const startTime = await readProcStartTime(pid);
        session.knownInferiorIdentities.set(pid, {
          pid,
          startTime,
        });
      }
      session.inferiorInventoryComplete = true;
      if (inferior.length !== 1)
        throw new Error(
          "Rizin reported multiple or ambiguous ptrace inferiors.",
        );
      const [fd, pid] = inferior[0]!;
      const processStartTime = await readProcStartTime(pid);
      await this.#verifyInferiorOutputConfiguration(session, pid);
      await this.#runInternalCommand(session, `o- ${fd}`);
      const after = parseRizinPtraceRows(
        await this.#runInternalCommand(session, "olj"),
      );
      if (
        after.some(
          ([activeFd, activePid]) => activeFd === fd || activePid === pid,
        ) ||
        after.length !== 0
      )
        throw new Error(
          "Rizin did not confirm that the selected inferior FD was detached.",
        );
      assertRizinProcessStartTimeStable(
        processStartTime,
        await readProcStartTime(pid),
      );
      await this.#verifyInferiorOutputConfiguration(session, pid);
      return { status: "detached", outputSink: "durable" };
    }
  }

  async #verifyInferiorOutputConfiguration(
    session: RizinDebugSession,
    pid: string,
  ): Promise<void> {
    const exitKills = (
      await this.#runInternalCommand(session, "e dbg.exitkills")
    ).trim();
    if (exitKills !== "false")
      throw new Error("Rizin dbg.exitkills readback did not confirm false.");
    for (const descriptor of ["1", "2"]) {
      const descriptorPath = `/proc/${pid}/fd/${descriptor}`;
      const destination = await readlink(descriptorPath);
      const destinationStat = await stat(descriptorPath);
      if (
        destinationStat.dev !== session.inferiorTtyDevice ||
        destinationStat.ino !== session.inferiorTtyInode ||
        (destinationStat.mode & fsConstants.S_IFMT) !== fsConstants.S_IFCHR ||
        (await realpath(destination)) !== session.inferiorTty
      )
        throw new Error(
          `Inferior descriptor ${descriptor} is not routed to the selected TTY.`,
        );
    }
  }

  async #runInternalCommand(
    session: RizinDebugSession,
    command: string,
  ): Promise<string> {
    const marker = `__REA_CLEANUP_COMPLETE_${randomUUID().replaceAll("-", "")}__`;
    const stdin = session.launched.process.stdin;
    if (
      stdin === null ||
      stdin === undefined ||
      stdin.destroyed ||
      !stdin.writable
    )
      throw new Error("Rizin stdin is unavailable during cleanup.");
    stdin.write(`${command}\n!echo ${marker}\n`);
    const captured = await waitForCommandFrames(
      session,
      marker,
      CLEANUP_COMMAND_TIMEOUT_MS,
      undefined,
      this.#maxCommandOutputBytes,
    );
    if (captured.outputTruncated)
      throw new Error("Rizin cleanup readback was truncated.");
    return captured.output;
  }

  #retainCleanupFailure(
    session: RizinDebugSession,
    operation: string,
    reason: string,
    options: AnalysisErrorOptions = {},
  ): AnalysisError {
    const failure = new AnalysisCapabilityUnavailableError(
      "rizin",
      operation,
      `The owned Rizin process could not be confirmed stopped: ${reason}`,
      { ...options, cleanup: { reason, resources: [session.id] } },
    );
    session.cleanupFailures.add(failure);
    return failure;
  }

  async #stopAfterProtocolFailure(
    session: RizinDebugSession,
    cause: unknown,
    commandTurnHeld = false,
  ): Promise<AnalysisError> {
    const stopped = await this.#stopDebuggerOnly(session, commandTurnHeld);
    return stopped.status === "incomplete"
      ? this.#retainCleanupFailure(
          session,
          "rizin_debug_command",
          stopped.reason,
          { cause },
        )
      : new AnalysisCapabilityUnavailableError(
          "rizin",
          "rizin_debug_command",
          session.protocolError!,
          { cause },
        );
  }
}

export interface RizinDebugCommandResult {
  readonly command: string;
  readonly output: string;
  readonly output_scope: "command_and_interleaved_session_output";
  readonly output_truncated: boolean;
  readonly output_invalid_utf8?: true;
  readonly completion_status: "complete" | "unknown";
  readonly backend: string | null;
}

const parseRizinPtraceRows = (output: string): Array<[string, string]> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    throw new Error("Rizin returned malformed JSON for `olj`.", { cause });
  }
  if (!Array.isArray(parsed))
    throw new Error("Rizin `olj` response is not an array.");
  const rows: Array<[string, string]> = [];
  for (const row of parsed) {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof (row as { fd?: unknown }).fd !== "number" ||
      !Number.isSafeInteger((row as { fd: number }).fd) ||
      (row as { fd: number }).fd < 0 ||
      typeof (row as { raised?: unknown }).raised !== "boolean" ||
      typeof (row as { uri?: unknown }).uri !== "string"
    )
      throw new Error(
        "Rizin `olj` response contains a malformed descriptor row.",
      );
    const uri = (row as { uri: string }).uri;
    const match = /^ptrace:\/\/(\d+)$/u.exec(uri);
    if (match !== null) {
      if ((row as { raised: boolean }).raised !== true)
        throw new Error("Rizin `olj` ptrace descriptor is not active.");
      rows.push([String((row as { fd: number }).fd), match[1]!]);
    } else if (uri.startsWith("ptrace://"))
      throw new Error("Rizin `olj` returned a malformed ptrace URI.");
  }
  return rows;
};

/** @internal Pure parser kept separately testable from live `/proc` access. */
export const parseRizinProcStartTime = (statContents: string): string => {
  const commandEnd = statContents.lastIndexOf(")");
  if (commandEnd < 0)
    throw new Error("Inferior process identity is malformed.");
  const fieldsAfterCommand = statContents
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const startTime = fieldsAfterCommand[19];
  if (startTime === undefined || !/^\d+$/u.test(startTime))
    throw new Error("Inferior process start time could not be verified.");
  return startTime;
};

/** @internal Reject a PID that changed identity during inferior detach. */
export const assertRizinProcessStartTimeStable = (
  before: string,
  after: string,
): void => {
  if (after !== before)
    throw new Error(
      "The inferior PID disappeared or was reused during detach verification.",
    );
};

const readProcStartTime = async (pid: string): Promise<string> =>
  parseRizinProcStartTime(await readFile(`/proc/${pid}/stat`, "utf8"));

const waitForCommandFrames = async (
  session: RizinDebugSession,
  marker: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxCommandOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
): Promise<{
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly outputInvalidUtf8: boolean;
}> => {
  const deadline = Date.now() + timeoutMs;
  const output: string[] = [];
  let outputInvalidUtf8 = false;
  const commandTimeoutError = (): RizinCommandTimeoutError =>
    createRizinCommandTimeoutError(output, outputInvalidUtf8);
  let outputBytes = 0;
  let frameCount = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (isRizinCommandDeadlineExpired(remaining)) throw commandTimeoutError();
    let received: RizinFrame;
    try {
      received = await waitForFrame(
        session,
        remaining,
        signal,
        commandTimeoutError,
      );
    } catch (cause) {
      if (cause instanceof AnalysisCancelledError)
        throw new RizinCommandCancelledError(
          output.join("\n"),
          outputInvalidUtf8,
          cause,
        );
      if (cause instanceof RizinProcessExitError)
        throw new RizinProcessExitError(output.join("\n"), outputInvalidUtf8);
      throw cause;
    }
    outputInvalidUtf8 ||= received.invalidUtf8;
    frameCount += 1;
    if (frameCount > MAX_COMMAND_FRAMES) {
      const message =
        "Rizin emitted more than 4096 frames for one command; the session was stopped because output correlation is ambiguous.";
      session.protocolError = message;
      return {
        output: output.join("\n"),
        outputTruncated: true,
        outputInvalidUtf8,
      };
    }
    if (received.truncated) {
      const separatorBytes = output.length > 0 ? 1 : 0;
      output.push(
        truncateUtf8(
          received.text,
          maxCommandOutputBytes - outputBytes - separatorBytes,
        ),
      );
      return {
        output: output.join("\n"),
        outputTruncated: true,
        outputInvalidUtf8,
      };
    }
    const frame = received.text;
    const markerIndex = frame.indexOf(marker);
    if (markerIndex >= 0) {
      const beforeMarker = frame.slice(0, markerIndex).trimEnd();
      if (beforeMarker.length > 0) {
        const beforeMarkerBytes = Buffer.byteLength(beforeMarker, "utf8");
        const separatorBytes = output.length > 0 ? 1 : 0;
        if (
          outputBytes + separatorBytes + beforeMarkerBytes >
          maxCommandOutputBytes
        ) {
          const message =
            "Rizin command output exceeded the 16 MiB command limit.";
          session.protocolError = message;
          const retained = truncateUtf8(
            beforeMarker,
            maxCommandOutputBytes - outputBytes - separatorBytes,
          );
          if (retained.length > 0) output.push(retained);
          return {
            output: output.join("\n"),
            outputTruncated: true,
            outputInvalidUtf8,
          };
        }
        outputBytes += separatorBytes + beforeMarkerBytes;
        output.push(beforeMarker);
      }
      return {
        output: output.join("\n"),
        outputTruncated: false,
        outputInvalidUtf8,
      };
    }
    const frameBytes = Buffer.byteLength(frame, "utf8");
    const separatorBytes = output.length > 0 ? 1 : 0;
    if (outputBytes + separatorBytes + frameBytes > maxCommandOutputBytes) {
      const message = "Rizin command output exceeded the 16 MiB command limit.";
      session.protocolError = message;
      output.push(
        truncateUtf8(
          frame,
          maxCommandOutputBytes - outputBytes - separatorBytes,
        ),
      );
      return {
        output: output.join("\n"),
        outputTruncated: true,
        outputInvalidUtf8,
      };
    }
    outputBytes += separatorBytes + frameBytes;
    output.push(frame);
  }
};

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  if (maximumBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8").subarray(0, maximumBytes);
  return bytes.toString("utf8").replace(/\uFFFD$/u, "");
};

const waitForFrame = (
  session: RizinDebugSession,
  timeoutMs: number,
  signal?: AbortSignal,
  timeoutError?: () => Error,
): Promise<RizinFrame> => {
  if (signal?.aborted)
    return Promise.reject(new AnalysisCancelledError("rizin_debug_command"));
  const queued = session.frames.shift();
  if (queued !== undefined) {
    session.queuedFrameBytes -= queued.queueChargeBytes;
    return Promise.resolve(queued.frame);
  }
  if (session.exited) return Promise.reject(new RizinProcessExitError(""));
  return new Promise((resolve, reject) => {
    // Settlement removes all three trigger paths before resolving or rejecting.
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const index = session.frameWaiters.indexOf(waiter);
      if (index >= 0) session.frameWaiters.splice(index, 1);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new AnalysisCancelledError("rizin_debug_command"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(timeoutError?.() ?? new RizinFrameTimeoutError());
    }, timeoutMs);
    const waiter = {
      resolve: (frame: RizinFrame): void => {
        cleanup();
        resolve(frame);
      },
      reject: (cause: Error): void => {
        cleanup();
        reject(cause);
      },
    };
    session.frameWaiters.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
};

const waitForTurn = (
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal === undefined) return previous;
  if (signal.aborted)
    return Promise.reject(new AnalysisCancelledError("rizin_debug_command"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new AnalysisCancelledError("rizin_debug_command"));
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
};
