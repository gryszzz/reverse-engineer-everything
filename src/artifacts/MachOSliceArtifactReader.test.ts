import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { CPU, fatImage, machoImage } from "./apple/MachoImage.fixture.js";
import { MachOSliceArtifactReader } from "./MachOSliceArtifactReader.js";
import { err, ok } from "../domain/result.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import type { NativeCommandRunner } from "../native/CommandRunner.js";
import { NativeCommandFailure } from "../native/CommandRunner.js";

const cleanupOwner = (runId: string): ProviderProcessSupervisor => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => true,
  });
  return new ProviderProcessSupervisor({
    process: child,
    ownsProcessLifetime: true,
    ownership: {
      runId,
      leaderPid: 45_000,
      processGroupId: 45_000,
      expectedParentPid: process.pid,
    },
    cleanup: async () => ({ cleaned: false, reason: "still running" }),
  });
};

describe("Mach-O cleanup exceptions", () => {
  it("retains an undefined cleanup rejection as an explicit failure", async () => {
    const reader = new MachOSliceArtifactReader(
      "/unused/macho",
      {},
      {
        run: async () => {
          throw new Error("Unexpected command");
        },
        retryCleanup: async () => {
          throw undefined;
        },
      },
    );
    await expect(reader.close()).rejects.toMatchObject({
      cleanup: {
        reason: "undefined",
        resources: ["native-command-process-cleanup"],
      },
    });
  });
});

describe("Mach-O command cleanup lifecycle", () => {
  it("waits for active lipo capture before cleanup and preserves its failure", async () => {
    const root = await createTestTempDirectory("rea-slices-close-race-");
    const binary = join(root, "input");
    await writeFile(binary, Buffer.from("fixture"));
    let finishCommand!: (
      result: Awaited<ReturnType<NativeCommandRunner["run"]>>,
    ) => void;
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    const command = new Promise<
      Awaited<ReturnType<NativeCommandRunner["run"]>>
    >((resolve) => {
      finishCommand = resolve;
    });
    let cleanupRetries = 0;
    const runner: NativeCommandRunner = {
      run: () => {
        commandStarted();
        return command;
      },
      retryCleanup: async () => {
        cleanupRetries += 1;
        if (cleanupRetries > 1) return [];
        return [
          {
            owner: cleanupOwner("run:first"),
            reason: "first process group remains live",
            resources: ["run:first", "process-group:1234"],
          },
          {
            owner: cleanupOwner("run:second"),
            reason: "second process group remains live",
            resources: ["run:second", "process-group:5678"],
          },
        ];
      },
    };
    const reader = new MachOSliceArtifactReader(binary, {}, runner);
    const iteration = reader.entries();
    const firstEntry = iteration[Symbol.asyncIterator]().next();
    await started;
    const closing = reader.close();
    await Promise.resolve();
    expect(cleanupRetries).toBe(0);
    finishCommand(
      err(
        new NativeCommandFailure(
          "lipo",
          "timeout",
          null,
          undefined,
          {
            stdout: "partial lipo output",
            stderr: "partial lipo diagnostic",
            stdoutBytes: 19,
            stderrBytes: 23,
            exitCode: null,
            signal: null,
            truncated: false,
          },
          "capture process group remains unverified",
          ["capture-group:9999"],
        ),
      ),
    );

    await expect(firstEntry).rejects.toMatchObject({
      reason: "unavailable",
      cause: expect.objectContaining({
        cleanupFailure: "capture process group remains unverified",
      }),
      cleanup: {
        reason: "capture process group remains unverified",
        resources: ["capture-group:9999"],
      },
    });
    await expect(closing).rejects.toMatchObject({
      cleanup: {
        reason:
          "run:first, process-group:1234: first process group remains live; run:second, process-group:5678: second process group remains live",
        resources: [
          "run:first",
          "process-group:1234",
          "run:second",
          "process-group:5678",
        ],
      },
    });
    await reader.close();
    expect(cleanupRetries).toBe(2);
  });
});

describe("MachOSliceArtifactReader", () => {
  it("keeps a borrowed source usable after a cancelled slice read", async () => {
    const root = await createTestTempDirectory("rea-slices-cancelled-");
    const binary = join(root, "fat");
    const x86 = machoImage({ cpu: CPU.x86_64 });
    const arm = Buffer.concat([
      Buffer.from(machoImage({ cpu: CPU.arm64 })),
      Buffer.alloc(160_000, 0x5a),
    ]);
    await writeFile(
      binary,
      fatImage([
        { cpu: CPU.x86_64, bytes: x86 },
        { cpu: CPU.arm64, bytes: arm },
      ]),
    );
    const handle = await openRegularFile(binary, { symlinks: "reject" });
    const source = { handle, initial: await handle.stat() };
    const runner: NativeCommandRunner = {
      run: () =>
        Promise.resolve(
          ok({
            tool: "lipo",
            executable: "/usr/bin/lipo",
            executableSha256: "1".repeat(64),
            toolVersion: null,
            versionReason: "fixture",
            arguments: ["-detailed_info", binary],
            stdout: `architecture x86_64\n cputype 16777223\n cpusubtype 3\n offset 4096\n size ${String(x86.length)}\n align 2^12 (4096)\narchitecture arm64\n cputype 16777228\n cpusubtype 0\n offset 8192\n size ${String(arm.length)}\n align 2^12 (4096)\n`,
            stderr: "",
            stdoutBytes: 1,
            stderrBytes: 0,
            exitCode: 0,
            signal: null,
          }),
        ),
    };
    const reader = new MachOSliceArtifactReader(binary, {}, runner, source);
    onTestFinished(async () => {
      await reader.close();
      await handle.close();
    });

    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const armEntry = entries.find((entry) => entry.path === "slices/arm64");
    if (armEntry === undefined) throw new Error("Expected an arm64 slice");

    const controller = new AbortController();
    const cancelledRead = await reader.open(armEntry, controller.signal);
    const iterator = cancelledRead[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    expect(firstChunk.value).toHaveLength(64 * 1024);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({
      reason: "cancelled",
    });

    const verifiedEntries = [];
    for await (const entry of reader.entries()) verifiedEntries.push(entry);
    const verifiedArmEntry = verifiedEntries.find(
      (entry) => entry.path === "slices/arm64",
    );
    if (verifiedArmEntry === undefined)
      throw new Error("Expected arm64 after re-verifying the borrowed source");
    const verifiedChunks: Buffer[] = [];
    const verifiedRead = await reader.open(verifiedArmEntry);
    for await (const chunk of verifiedRead)
      verifiedChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(verifiedChunks)).toEqual(arm);
  });
});
