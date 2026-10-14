import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ReverseEngineeringService } from "../../src/application/reverse/ReverseEngineeringService.js";
import { REVERSE_ENGINEERING_TOOL_CONTRACTS } from "../../src/contracts/reverseEngineeringToolContracts.js";
import { execFileOutput } from "../../src/process/ExecFileOutput.js";

type ExecFileOutputOptions = NonNullable<Parameters<typeof execFileOutput>[2]>;

it("documents the shared combined capture limit for both command tools", () => {
  for (const contract of REVERSE_ENGINEERING_TOOL_CONTRACTS)
    expect(contract.description).toContain("shared 16 MiB combined limit");
});

it("uses provider profiles supplied through the application port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-port-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const run = vi.fn(
    async (
      _command: string,
      _args: readonly string[],
      _options?: ExecFileOutputOptions,
    ) => ({ stdout: "injected", stderr: "" }),
  );
  const service = new ReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: "ambient-objdump" },
    commands: {
      objdump: () => ({
        executable: "injected-objdump",
        arguments: ["--injected", path],
        identity: {
          id: "test.objdump",
          name: "Injected objdump",
          version: null,
        },
        environmentOverrides: { INJECTED_PROFILE: "yes" },
      }),
      rizin: () => ({
        executable: "injected-rizin",
        arguments: ["--injected", path],
        identity: { id: "test.rizin", name: "Injected Rizin", version: null },
      }),
    },
    run,
  });

  try {
    const result = await service.inspectWithObjdump({
      path,
      operation: "file_headers",
    });
    expect(result.ok).toBe(true);
    const call = run.mock.calls[0];
    expect(call?.[0]).toBe("injected-objdump");
    expect(call?.[1]).toEqual(["--injected", path]);
    expect(call?.[2]?.env?.INJECTED_PROFILE).toBe("yes");
    if (result.ok) expect(result.value.provider.id).toBe("test.objdump");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not reintroduce ambient variables absent from the captured provider environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-env-"));
  const path = join(directory, "fixture.bin");
  const variable = "REA_TEST_LATE_PROVIDER_ENV";
  const previous = process.env[variable];
  await writeFile(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  process.env[variable] = "late-ambient-value";
  const run = vi.fn(
    async (
      _command: string,
      _args: readonly string[],
      _options?: ExecFileOutputOptions,
    ) => ({ stdout: "captured", stderr: "" }),
  );
  const service = new ReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: "captured-objdump" },
    commands: {
      objdump: () => ({
        executable: "captured-objdump",
        arguments: [path],
        identity: {
          id: "test.objdump",
          name: "Captured objdump",
          version: null,
        },
        environmentOverrides: { PROFILE_VALUE: "explicit" },
      }),
      rizin: () => ({
        executable: "captured-rizin",
        arguments: [path],
        identity: { id: "test.rizin", name: "Captured Rizin", version: null },
      }),
    },
    run,
  });

  try {
    await service.inspectWithObjdump({ path, operation: "file_headers" });
    expect(run.mock.calls[0]?.[2]?.env).toEqual({
      REA_OBJDUMP_COMMAND: "captured-objdump",
      PROFILE_VALUE: "explicit",
    });
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
