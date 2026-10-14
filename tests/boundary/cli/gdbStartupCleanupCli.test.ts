import pino from "pino";
import { expect, it, vi } from "vitest";

import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";
import { registerReverseEngineeringCommands } from "../../../src/cli/reverseEngineeringCommands.js";
import { CLI_COMMANDS } from "../../../src/cliCommandNames.js";
import type { CliInstance } from "../../../src/cli/types.js";
import type { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";

const registerGdbCommand = (
  createManager: () => GdbSessionManager,
): {
  run(input: {
    args: { command: string };
    options: { inferiorTty: string };
  }): Promise<unknown>;
} => {
  const commands = new Map<
    string,
    {
      run(input: {
        args: { command: string };
        options: { inferiorTty: string };
      }): Promise<unknown>;
    }
  >();
  const cli = {
    command: (
      name: string,
      definition: {
        run(input: {
          args: { command: string };
          options: { inferiorTty: string };
        }): Promise<unknown>;
      },
    ) => {
      commands.set(name, definition);
      return cli;
    },
  } as unknown as CliInstance;
  registerReverseEngineeringCommands(cli, pino({ enabled: false }), {}, () =>
    createManager(),
  );
  const command = commands.get(CLI_COMMANDS.debugWithGdb);
  if (command === undefined)
    throw new Error("GDB CLI command was not registered");
  return command;
};

it.each([
  "source /tmp/gdbinit",
  "python print('x')",
  "def custom-command",
  "run > /tmp/out",
  "set inferior-t /dev/null",
  "with inferior-t /dev/null -- run",
])("rejects one-shot command %s before starting GDB", async (inputCommand) => {
  const manager = {
    start: vi.fn(),
    closeAll: vi.fn(),
  } as unknown as GdbSessionManager;
  const command = registerGdbCommand(() => manager);
  const result = await command.run({
    args: { command: inputCommand },
    options: { inferiorTty: "/dev/pts/42" },
  });
  expect(result).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        expect.objectContaining({
          message: expect.stringContaining("persistent GDB session workflow"),
        }),
      ],
    },
  });
  expect(manager.start).not.toHaveBeenCalled();
  expect(manager.closeAll).not.toHaveBeenCalled();
});

it("retries retained GDB cleanup when CLI session startup fails", async () => {
  const closeAll = vi.fn(async () => undefined);
  const manager = {
    start: vi.fn(async () =>
      err(new AnalysisOutputError("start_gdb_session", "startup failed")),
    ),
    closeAll,
  } as unknown as GdbSessionManager;
  const originalExitCode = process.exitCode;
  const command = registerGdbCommand(() => manager);

  try {
    const result = await command.run({
      args: { command: "info files" },
      options: { inferiorTty: "/dev/pts/42" },
    });
    expect(result).toMatchObject({ code: "unreadable_output" });
    expect(manager.start).toHaveBeenCalledOnce();
    expect(manager.start).toHaveBeenCalledWith(expect.anything(), {
      inferiorTty: "/dev/pts/42",
    });
    expect(closeAll).toHaveBeenCalledOnce();
  } finally {
    process.exitCode = originalExitCode;
  }
});

it("marks the CLI failed when retained GDB cleanup remains incomplete", async () => {
  const manager = {
    start: vi.fn(async () =>
      err(new AnalysisOutputError("start_gdb_session", "startup failed")),
    ),
    closeAll: vi.fn(async () => {
      throw new Error("process still owned");
    }),
  } as unknown as GdbSessionManager;
  const originalExitCode = process.exitCode;
  const command = registerGdbCommand(() => manager);

  try {
    const result = await command.run({
      args: { command: "info files" },
      options: { inferiorTty: "/dev/pts/42" },
    });
    expect(result).toMatchObject({ code: "unreadable_output" });
    expect(manager.closeAll).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = originalExitCode;
  }
});
