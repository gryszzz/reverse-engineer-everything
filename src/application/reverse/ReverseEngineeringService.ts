import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat as statPath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { resolve } from "node:path";

import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import type {
  AnalysisCleanupObservation,
  AnalysisError,
} from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  objdumpInputSchema,
  rizinInputSchema,
} from "../../domain/reverseEngineering.js";
import type {
  ReverseEngineeringCommandPort,
  ReverseEngineeringProviderCommand,
} from "./ReverseEngineeringCommandPort.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../../process/ExecFileOutput.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";

export type ReverseEngineeringOperation =
  | "inspect_with_objdump"
  | "execute_rizin_command";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_COMBINED_OUTPUT_BYTES = 16 * 1024 * 1024;
// Eight concurrent captures bound retained provider output to 128 MiB.
const MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS = 8;

export interface ReverseEngineeringServiceOptions {
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly commands: ReverseEngineeringCommandPort;
  readonly run?: ReverseEngineeringCommandRunner;
  readonly runOwned?: typeof runOwnedCommand;
  readonly digest?: typeof digestFile;
  readonly stat?: (path: string) => Promise<Stats>;
}

interface ReverseEngineeringCommandRunner {
  (
    command: string,
    arguments_: readonly string[],
    options?: Parameters<typeof execFileOutput>[2],
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutInvalidUtf8?: boolean;
    readonly stderrInvalidUtf8?: boolean;
    readonly stdoutBytes?: number;
    readonly stderrBytes?: number;
  }>;
}

export type ReverseEngineeringServiceRuntimeOptions = Omit<
  ReverseEngineeringServiceOptions,
  "commands" | "environment"
>;

/** Shared application workflow for caller-selected local analysis commands. */
export class ReverseEngineeringService {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #commands: ReverseEngineeringCommandPort;
  readonly #run: ReverseEngineeringCommandRunner;
  readonly #digest: typeof digestFile;
  readonly #stat: (path: string) => Promise<Stats>;
  readonly #pendingCleanup = new Map<
    ProviderProcessSupervisor,
    {
      readonly observation: AnalysisCleanupObservation;
      readonly failures: Set<AnalysisError>;
      readonly retryFailure?: AnalysisError;
    }
  >();
  readonly #activeOperations = new Map<
    AbortController,
    Promise<Result<Evidence, AnalysisError>>
  >();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: ReverseEngineeringServiceOptions) {
    this.#environment = { ...(options.environment ?? process.env) };
    this.#commands = options.commands;
    this.#run =
      options.run ??
      runOwnedCommandOutput(
        options.runOwned ?? runOwnedCommand,
        (owner, cleanup) =>
          this.#pendingCleanup.set(owner, {
            observation: cleanup,
            failures: this.#pendingCleanup.get(owner)?.failures ?? new Set(),
          }),
      );
    this.#digest = options.digest ?? digestFile;
    this.#stat = options.stat ?? statPath;
  }

  /** Ask retained process owners to settle cleanup before admitting more work. */
  async retryCleanup(
    operation = "reverse_engineering_cleanup",
  ): Promise<Result<null, AnalysisError>> {
    let failure: AnalysisError | undefined;
    for (const [owner, retained] of this.#pendingCleanup) {
      let stopped: Awaited<ReturnType<ProviderProcessSupervisor["stop"]>>;
      try {
        stopped = await owner.stop();
      } catch (cause) {
        stopped = {
          status: "incomplete",
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      }
      if (stopped.status === "incomplete") {
        const observation = {
          reason: stopped.reason,
          resources: retained.observation.resources,
        };
        let retryFailure = retained.retryFailure;
        if (retryFailure === undefined) {
          retryFailure = new AnalysisOutputError(
            operation,
            "A previous provider process still requires cleanup.",
            { cleanup: observation },
          );
          retained.failures.add(retryFailure);
        }
        this.#pendingCleanup.set(owner, {
          observation,
          failures: retained.failures,
          retryFailure,
        });
        if (failure === undefined) failure = retryFailure;
      } else {
        for (const previous of retained.failures) previous.resolveCleanup();
        this.#pendingCleanup.delete(owner);
      }
    }
    return failure === undefined ? ok(null) : err(failure);
  }

  /** Retry cleanup for provider process groups retained after an incomplete stop. */
  close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#closeActiveOperationsAndCleanup().catch(
      (cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      },
    );
    return this.#closePromise;
  }

  async #closeActiveOperationsAndCleanup(): Promise<void> {
    const active = [...this.#activeOperations.entries()];
    for (const [controller] of active) controller.abort();
    await Promise.allSettled(active.map(([, operation]) => operation));

    const cleanup = await this.retryCleanup();
    if (!cleanup.ok) throw cleanup.error;
  }

  inspectWithObjdump(
    rawInput: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsed = objdumpInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return Promise.resolve(
        err(new AnalysisInputError("inspect_with_objdump")),
      );
    const input = parsed.data;
    const command = this.#commands.objdump(input);
    return this.#observe(
      "inspect_with_objdump",
      command,
      input.operation === "architectures" ? undefined : input.path,
      input,
      options.signal,
    );
  }

  executeRizinCommand(
    rawInput: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsed = rizinInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return Promise.resolve(
        err(new AnalysisInputError("execute_rizin_command")),
      );
    const input = parsed.data;
    const command = this.#commands.rizin(input);
    return this.#observe(
      "execute_rizin_command",
      command,
      input.path,
      input,
      options.signal,
    );
  }

  #observe(
    operation: ReverseEngineeringOperation,
    profile: ReverseEngineeringProviderCommand,
    path: string | undefined,
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (signal?.aborted)
      return Promise.resolve(err(new AnalysisCancelledError(operation)));
    if (this.#closing)
      return Promise.resolve(
        err(
          new AnalysisOutputError(
            operation,
            "Reverse-engineering service is closed.",
          ),
        ),
      );
    if (
      this.#activeOperations.size >=
      MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS
    )
      return Promise.resolve(
        err(
          new AnalysisResourceConstraintError(
            operation,
            "transport",
            "Concurrent reverse-engineering operation capacity reached.",
            {
              max_concurrent_operations:
                MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS,
              active_operations: this.#activeOperations.size,
            },
          ),
        ),
      );
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(signal?.reason);
    if (signal instanceof AbortSignal) {
      if (signal.aborted) relayAbort();
      else signal.addEventListener("abort", relayAbort, { once: true });
    }
    const operationSignal =
      signal === undefined || signal instanceof AbortSignal
        ? controller.signal
        : signal;
    const running = this.#observeProvider(
      operation,
      profile,
      path,
      parameters,
      operationSignal,
    );
    const tracked = running.finally(() => {
      signal?.removeEventListener("abort", relayAbort);
      this.#activeOperations.delete(controller);
    });
    this.#activeOperations.set(controller, tracked);
    return tracked;
  }

  async #observeProvider(
    operation: ReverseEngineeringOperation,
    profile: ReverseEngineeringProviderCommand,
    path: string | undefined,
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<Evidence, AnalysisError>> {
    const { executable: command, arguments: args } = profile;
    if (signal?.aborted) return err(new AnalysisCancelledError(operation));
    const cleanup = await this.retryCleanup(operation);
    if (!cleanup.ok) return cleanup;
    const absolutePath = path === undefined ? undefined : resolve(path);
    let digest: string | undefined;
    try {
      if (absolutePath !== undefined)
        digest = await this.#digest(absolutePath, signal, this.#stat);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (signal?.aborted)
        return err(new AnalysisCancelledError(operation, { cause }));
      if (code === "EACCES" || code === "EPERM") {
        const deniedPath = absolutePath === undefined ? command : absolutePath;
        return err(
          new AnalysisAccessDeniedError(operation, deniedPath, code, {
            cause,
          }),
        );
      }
      if (code === "ETIMEDOUT")
        return err(
          new AnalysisTimeoutError(operation, DEFAULT_TIMEOUT_MS, { cause }),
        );
      return err(new AnalysisInputError(operation, { cause }));
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exitCode: number | string | null = 0;
    let signalName: string | null = null;
    let outputTruncated = false;
    let stdoutInvalidUtf8 = false;
    let stderrInvalidUtf8 = false;
    let cleanupIncomplete = false;
    let cleanupOnlyFailure = false;
    let completionStatus: "complete" | "unknown" = "complete";
    let failure: AnalysisError | undefined;
    let cleanupOwner: ProviderProcessSupervisor | undefined;
    let earlyFailure: AnalysisError | undefined;
    try {
      const output = await this.#run(command, args, {
        env: {
          ...this.#environment,
          ...profile.environmentOverrides,
        },
        signal,
        timeout: DEFAULT_TIMEOUT_MS,
        stopSignal: "SIGTERM",
        maxBuffer: MAX_COMBINED_OUTPUT_BYTES,
      });
      stdout = output.stdout;
      stderr = output.stderr;
      stdoutBytes = output.stdoutBytes ?? Buffer.byteLength(stdout);
      stderrBytes = output.stderrBytes ?? Buffer.byteLength(stderr);
      stdoutInvalidUtf8 = output.stdoutInvalidUtf8 === true;
      stderrInvalidUtf8 = output.stderrInvalidUtf8 === true;
    } catch (cause) {
      cleanupOwner =
        cause instanceof OwnedOutputFailure ? cause.cleanupOwner : undefined;
      if (
        cause instanceof OwnedOutputFailure &&
        cause.capabilityError !== undefined
      )
        earlyFailure = new AnalysisCapabilityUnavailableError(
          cause.capabilityError.providerId,
          cause.capabilityError.operation,
          cause.capabilityError.reason,
          {
            cause: cause.capabilityError,
            ...(cause.capabilityError.diagnostics === undefined
              ? {}
              : { diagnostics: cause.capabilityError.diagnostics }),
            ...(cause.capabilityError.capturedOutput === undefined
              ? {}
              : { capturedOutput: cause.capabilityError.capturedOutput }),
            ...(cause.capabilityError.partialObservation === undefined
              ? {}
              : {
                  partialObservation: cause.capabilityError.partialObservation,
                }),
            ...(cause.capabilityError.userMessage === undefined
              ? {}
              : { userMessage: cause.capabilityError.userMessage }),
            retryable: cause.capabilityError.retryable,
            ...ownedCleanupOptions(cause),
          },
        );
      const capture = execFileOutputFailure(cause);
      const code =
        capture?.code ?? (cause as NodeJS.ErrnoException).code ?? undefined;
      if (earlyFailure === undefined && code === "E2BIG")
        earlyFailure = new AnalysisResourceConstraintError(
          operation,
          "transport",
          "The host rejected the provider command because its argument list exceeds the process launch limit.",
          {
            argument_bytes: args.reduce(
              (bytes, argument, index) =>
                bytes + Buffer.byteLength(argument) + (index === 0 ? 0 : 1),
              0,
            ),
          },
          { cause, ...ownedCleanupOptions(cause) },
        );
      if (
        earlyFailure === undefined &&
        (capture === undefined ||
          code === "ENOENT" ||
          code === "ERR_PROVIDER_LAUNCH")
      ) {
        if (signal?.aborted || code === "ABORT_ERR")
          earlyFailure = new AnalysisCancelledError(operation, {
            cause,
            ...ownedCleanupOptions(cause),
          });
        else if (code === "ETIMEDOUT")
          earlyFailure = new AnalysisTimeoutError(
            operation,
            DEFAULT_TIMEOUT_MS,
            {
              cause,
              ...ownedCleanupOptions(cause),
            },
          );
        else if (code === "EACCES" || code === "EPERM")
          earlyFailure = new AnalysisAccessDeniedError(
            operation,
            command,
            code,
            {
              cause,
              ...ownedCleanupOptions(cause),
            },
          );
        else
          earlyFailure = new AnalysisCapabilityUnavailableError(
            operation === "inspect_with_objdump" ? "objdump" : "rizin",
            operation,
            `Unable to run configured command (${String(code ?? "unknown error")})`,
            { cause, ...ownedCleanupOptions(cause) },
          );
      }
      if (earlyFailure === undefined && capture !== undefined) {
        stdout = capture.stdout;
        stderr = capture.stderr;
        stdoutBytes = capture.stdoutBytes ?? Buffer.byteLength(stdout);
        stderrBytes = capture.stderrBytes ?? Buffer.byteLength(stderr);
        exitCode = capture.code;
        signalName = capture.signal;
        outputTruncated = capture.outputTruncated;
        if (capture.collectionFailure) {
          exitCode = null;
          completionStatus = "unknown";
        }
        const capturedOutput = {
          stdout,
          stderr,
          truncated: outputTruncated,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          exit_code:
            !capture.collectionFailure && typeof capture.code === "number"
              ? capture.code
              : null,
          signal: capture.signal,
        };
        if (signal?.aborted || code === "ABORT_ERR")
          failure = new AnalysisCancelledError(operation, {
            cause,
            capturedOutput,
            ...ownedCleanupOptions(cause),
          });
        else if (code === "ETIMEDOUT")
          failure = new AnalysisTimeoutError(operation, DEFAULT_TIMEOUT_MS, {
            cause,
            capturedOutput,
            ...ownedCleanupOptions(cause),
          });
        else if (code === "EACCES" || code === "EPERM")
          failure = new AnalysisAccessDeniedError(operation, command, code, {
            cause,
            capturedOutput,
            ...ownedCleanupOptions(cause),
          });
        if (
          cause instanceof OwnedOutputFailure &&
          cause.cleanup !== undefined
        ) {
          cleanupIncomplete = true;
          if (failure === undefined) {
            cleanupOnlyFailure =
              !capture.collectionFailure &&
              !capture.outputTruncated &&
              !capture.killed &&
              capture.signal === null &&
              typeof capture.code === "number" &&
              !signal?.aborted;
            failure = new AnalysisOutputError(
              operation,
              "Provider process cleanup remains incomplete.",
              {
                cause,
                capturedOutput,
                cleanup: cause.cleanup,
                cleanupOnly: cleanupOnlyFailure,
              },
            );
          }
        }
        if (
          failure === undefined &&
          cause instanceof OwnedOutputFailure &&
          cause.collectionFailure
        )
          failure = new AnalysisOutputError(
            operation,
            "Provider output collection failed.",
            { cause, capturedOutput },
          );
        if (
          capture.killed ||
          capture.signal !== null ||
          typeof capture.code !== "number"
        ) {
          exitCode = null;
          completionStatus = "unknown";
        }
        if (cause instanceof OwnedOutputFailure) {
          stdoutInvalidUtf8 = cause.stdoutInvalidUtf8;
          stderrInvalidUtf8 = cause.stderrInvalidUtf8;
        }
      }
    }
    if (earlyFailure !== undefined)
      return err(this.#registerCleanupFailure(earlyFailure, cleanupOwner));
    if (failure !== undefined && cleanupOwner !== undefined)
      failure = this.#registerCleanupFailure(failure, cleanupOwner);
    let digestAfter: string | null = null;
    if (absolutePath === undefined) {
      digestAfter = null;
    } else if (cleanupIncomplete) {
      if (!cleanupOnlyFailure) completionStatus = "unknown";
    } else {
      try {
        digestAfter = await this.#digest(absolutePath, signal, this.#stat);
      } catch {
        // Preserve the provider's collected observations if the artifact vanished or became unreadable.
      }
    }
    if (signal?.aborted && failure === undefined) {
      failure = new AnalysisCancelledError(operation, {
        capturedOutput: {
          stdout,
          stderr,
          truncated: outputTruncated,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          exit_code: typeof exitCode === "number" ? exitCode : null,
          signal: signalName,
        },
      });
      exitCode = null;
      completionStatus = "unknown";
    }
    const artifactChanged =
      absolutePath === undefined
        ? null
        : digestAfter === null || digest === undefined
          ? null
          : digestAfter !== digest;
    const result = {
      stdout,
      stderr,
      exit_code: exitCode,
      signal: signalName,
      output_truncated: outputTruncated,
      completion_status: completionStatus,
      artifact_sha256_after: absolutePath === undefined ? null : digestAfter,
      artifact_changed: absolutePath === undefined ? null : artifactChanged,
    };
    const limitations = [
      ...(absolutePath === undefined
        ? [
            "The objdump version is not reported; the output lists BFD targets advertised by the installed tool and does not establish support for the selected artifact.",
          ]
        : [
            "The executable version and supported formats are reported as unknown because no reliable version probe was performed.",
          ]),
      "A non-zero process exit is preserved as an observed command result.",
      ...(operation === "inspect_with_objdump" &&
      parameters.follow_debug_links === true
        ? [
            "DWARF output may include local debug-link files whose identities are not bound to Evidence.",
          ]
        : []),
      ...(operation === "execute_rizin_command"
        ? [
            "Rizin commands and retained plugins may read files or access network resources outside the selected artifact; those external inputs are not bound to Evidence.",
          ]
        : []),
      ...(stdoutInvalidUtf8 || stderrInvalidUtf8
        ? [
            `Captured ${[
              ...(stdoutInvalidUtf8 ? ["stdout"] : []),
              ...(stderrInvalidUtf8 ? ["stderr"] : []),
            ].join(
              " and ",
            )} bytes contain invalid or incomplete UTF-8; replacement characters in the text capture do not preserve the original bytes.`,
          ]
        : []),
      ...(outputTruncated
        ? [
            "The provider command ended before completion could be confirmed; captured output is partial.",
          ]
        : []),
      ...(signalName === null
        ? []
        : [
            `The provider process terminated by signal ${signalName}; captured output may be partial and command completion is unknown.`,
          ]),
      ...(failure === undefined ||
      (failure instanceof AnalysisOutputError && failure.cleanupOnly)
        ? []
        : [
            `Command completion is unknown because the operation failed with ${failure._tag}: ${failure.message}`,
          ]),
      ...(absolutePath === undefined
        ? [
            "This output lists BFD targets advertised by the installed objdump and is independent of the selected artifact.",
          ]
        : [
            "When both are available, pre-run and post-run digests detect artifact changes across the provider call but cannot prove the exact bytes consumed during the call.",
          ]),
      ...(artifactChanged === true
        ? [
            "The provider command may have changed the artifact while analysis was running; pre-run and post-run digests are both reported.",
          ]
        : []),
      ...(absolutePath !== undefined && digestAfter === null
        ? [
            cleanupIncomplete
              ? "The post-run artifact digest was not captured because owned provider cleanup was incomplete at observation time; artifact changes during the command remain unquantified."
              : signal?.aborted
                ? "The post-run artifact digest is unknown because cancellation interrupted the digest."
                : "The post-run artifact digest is unknown because the artifact could not be read after the provider call.",
          ]
        : []),
    ];
    const evidence = createEvidence(
      absolutePath === undefined || digest === undefined
        ? undefined
        : { path: absolutePath, sha256: digest, format: "unknown" },
      profile.identity,
      {
        predicateType: "rea.reverse-engineering.command-observation",
        operation,
        parameters: {
          ...(absolutePath === undefined
            ? { operation: "architectures" }
            : parameters),
          provider_executable: command,
          command_arguments: [...args],
        },
        rawResult: result,
        result,
        limitations,
        ...(absolutePath === undefined
          ? {}
          : {
              locations: [
                { kind: "artifact-path" as const, path: absolutePath },
              ],
            }),
      },
    );
    return failure === undefined
      ? ok(evidence)
      : err(failure.retainPartialObservation(evidence));
  }

  #registerCleanupFailure(
    failure: AnalysisError,
    cleanupOwner: ProviderProcessSupervisor | undefined,
  ): AnalysisError {
    if (cleanupOwner !== undefined && failure.cleanupIncomplete)
      this.#pendingCleanup.get(cleanupOwner)?.failures.add(failure);
    return failure;
  }
}

interface OwnedOutputFailureOptions {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | string | null;
  readonly signal: string | null;
  readonly outputTruncated: boolean;
  readonly stdoutInvalidUtf8: boolean;
  readonly stderrInvalidUtf8: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly capabilityError?: AnalysisCapabilityUnavailableError;
  readonly collectionFailure?: boolean;
  readonly cleanup?: AnalysisCleanupObservation;
  readonly cleanupOwner?: ProviderProcessSupervisor;
  readonly cause?: unknown;
}

class OwnedOutputFailure extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | string | null;
  readonly signal: string | null;
  readonly outputTruncated: boolean;
  readonly stdoutInvalidUtf8: boolean;
  readonly stderrInvalidUtf8: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly capabilityError: AnalysisCapabilityUnavailableError | undefined;
  readonly collectionFailure: boolean;
  readonly cleanup: AnalysisCleanupObservation | undefined;
  readonly cleanupOwner: ProviderProcessSupervisor | undefined;

  constructor(options: OwnedOutputFailureOptions) {
    super("Owned provider command did not produce a complete result.", {
      cause: options.cause,
    });
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.code = options.code;
    this.signal = options.signal;
    this.outputTruncated = options.outputTruncated;
    this.stdoutInvalidUtf8 = options.stdoutInvalidUtf8;
    this.stderrInvalidUtf8 = options.stderrInvalidUtf8;
    this.stdoutBytes = options.stdoutBytes;
    this.stderrBytes = options.stderrBytes;
    this.capabilityError = options.capabilityError;
    this.collectionFailure = options.collectionFailure ?? false;
    this.cleanup = options.cleanup;
    this.cleanupOwner = options.cleanupOwner;
  }
}

const runOwnedCommandOutput =
  (
    runOwned: typeof runOwnedCommand,
    onCleanupOwner: (
      owner: ProviderProcessSupervisor,
      cleanup: AnalysisCleanupObservation,
    ) => void,
  ): ReverseEngineeringCommandRunner =>
  async (command, args, options = {}) => {
    const spawnEnv = { ...options.env };
    try {
      const snapshot = await runOwned(
        {
          command,
          arguments: [...args],
          runId: randomUUID(),
          expectedCommand: null,
          env: spawnEnv,
          hostEnvironment: {},
          sweepTokenOwnedProcesses: true,
        },
        {
          timeoutMs: DEFAULT_TIMEOUT_MS,
          diagnosticBytes: MAX_COMBINED_OUTPUT_BYTES,
          acceptNonZeroExit: true,
        },
        { signal: options.signal },
      );
      if (snapshot.signal !== null && snapshot.signal !== undefined)
        throw new OwnedOutputFailure({
          stdout: snapshot.stdout.text,
          stderr: snapshot.stderr.text,
          code: snapshot.exitCode ?? null,
          signal: snapshot.signal,
          outputTruncated: snapshot.diagnosticTruncated === true,
          stdoutInvalidUtf8: snapshot.stdout.invalidUtf8 === true,
          stderrInvalidUtf8: snapshot.stderr.invalidUtf8 === true,
          stdoutBytes: snapshot.stdout.bytes,
          stderrBytes: snapshot.stderr.bytes,
        });
      if (snapshot.exitCode !== 0)
        throw new OwnedOutputFailure({
          stdout: snapshot.stdout.text,
          stderr: snapshot.stderr.text,
          code: snapshot.exitCode ?? null,
          signal: null,
          outputTruncated: snapshot.diagnosticTruncated === true,
          stdoutInvalidUtf8: snapshot.stdout.invalidUtf8 === true,
          stderrInvalidUtf8: snapshot.stderr.invalidUtf8 === true,
          stdoutBytes: snapshot.stdout.bytes,
          stderrBytes: snapshot.stderr.bytes,
        });
      return {
        stdout: snapshot.stdout.text,
        stderr: snapshot.stderr.text,
        stdoutInvalidUtf8: snapshot.stdout.invalidUtf8 === true,
        stderrInvalidUtf8: snapshot.stderr.invalidUtf8 === true,
        stdoutBytes: snapshot.stdout.bytes,
        stderrBytes: snapshot.stderr.bytes,
      };
    } catch (cause) {
      if (!(cause instanceof OwnedCommandFailure)) throw cause;
      if (cause.cleanupOwner !== undefined && cause.cleanupFailure !== null)
        onCleanupOwner(cause.cleanupOwner, {
          reason: cause.cleanupFailure,
          resources: cause.resources,
        });
      const snapshot = cause.snapshot;
      const launchErrorCode =
        cause.cause instanceof Error
          ? Reflect.get(cause.cause, "code")
          : undefined;
      const code =
        cause.reason === "cancelled"
          ? "ABORT_ERR"
          : cause.reason === "timeout"
            ? "ETIMEDOUT"
            : cause.reason === "output-limit"
              ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              : launchErrorCode === "E2BIG"
                ? "E2BIG"
                : snapshot === null
                  ? "ERR_PROVIDER_LAUNCH"
                  : (snapshot.exitCode ?? null);
      throw new OwnedOutputFailure({
        stdout: snapshot?.stdout.text ?? "",
        stderr: snapshot?.stderr.text ?? "",
        code,
        signal: snapshot?.signal ?? null,
        outputTruncated: snapshot?.diagnosticTruncated === true,
        stdoutInvalidUtf8: snapshot?.stdout.invalidUtf8 === true,
        stderrInvalidUtf8: snapshot?.stderr.invalidUtf8 === true,
        stdoutBytes: snapshot?.stdout.bytes ?? 0,
        stderrBytes: snapshot?.stderr.bytes ?? 0,
        ...(cause.cause instanceof AnalysisCapabilityUnavailableError
          ? { capabilityError: cause.cause }
          : {}),
        ...(cause.collectionFailure ? { collectionFailure: true } : {}),
        ...(cause.cleanupFailure === null
          ? {}
          : {
              cleanup: {
                reason: cause.cleanupFailure,
                resources: cause.resources,
              },
            }),
        ...(cause.cleanupOwner === undefined
          ? {}
          : { cleanupOwner: cause.cleanupOwner }),
        cause,
      });
    }
  };

const ownedCleanupOptions = (
  cause: unknown,
): { readonly cleanup?: AnalysisCleanupObservation } =>
  cause instanceof OwnedOutputFailure && cause.cleanup !== undefined
    ? { cleanup: cause.cleanup }
    : {};

const digestFile = async (
  path: string,
  signal?: AbortSignal,
  stat: (path: string) => Promise<Stats> = statPath,
): Promise<string> => {
  const info = await statWithDeadline(path, signal, stat);
  if (!info.isFile())
    throw Object.assign(new Error("Artifact digest requires a regular file"), {
      code: "EINVAL",
    });
  return new Promise<string>((resolveDigest, rejectDigest) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    const timer = setTimeout(
      () =>
        stream.destroy(
          Object.assign(new Error("Artifact digest timed out"), {
            code: "ETIMEDOUT",
          }),
        ),
      DEFAULT_TIMEOUT_MS,
    );
    const abort = (): void => {
      stream.destroy(new AnalysisCancelledError("artifact_digest"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    if (signal?.aborted) {
      cleanup();
      stream.destroy();
      rejectDigest(new AnalysisCancelledError("artifact_digest"));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("error", (cause: Error) => {
      cleanup();
      rejectDigest(cause);
    });
    stream.once("end", () => {
      cleanup();
      resolveDigest(hash.digest("hex"));
    });
  });
};

const statWithDeadline = (
  path: string,
  signal: AbortSignal | undefined,
  stat: (path: string) => Promise<Stats>,
): Promise<Stats> => {
  if (signal?.aborted)
    return Promise.reject(new AnalysisCancelledError("artifact_digest"));
  return new Promise<Stats>((resolveStat, rejectStat) => {
    let settled = false;
    const finish = (cause?: unknown, value?: Stats): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (cause !== undefined) rejectStat(cause);
      else resolveStat(value!);
    };
    const abort = (): void =>
      finish(new AnalysisCancelledError("artifact_digest"));
    const timer = setTimeout(
      () =>
        finish(
          Object.assign(new Error("Artifact stat timed out"), {
            code: "ETIMEDOUT",
          }),
        ),
      DEFAULT_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    // Promise handlers stay attached after timeout/cancellation so a delayed
    // stat rejection is observed and cannot become an unhandled rejection.
    try {
      void stat(path).then(
        (info) => finish(undefined, info),
        (cause: unknown) => finish(cause),
      );
    } catch (cause) {
      finish(cause);
    }
  });
};
