import type { FileHandle } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { MachOSliceArtifactReader } from "../../../src/artifacts/MachOSliceArtifactReader.js";
import { ZipArtifactReader } from "../../../src/artifacts/ZipArtifactReader.js";
import { ok } from "../../../src/domain/result.js";
import type { NativeCommandRunner } from "../../../src/native/CommandRunner.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const injected = vi.hoisted(() => ({
  opened: undefined as
    | ((path: unknown, handle: FileHandle) => void)
    | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      injected.opened?.(args[0], handle);
      return handle;
    },
  };
});

const runner: NativeCommandRunner = {
  run: async () =>
    ok({
      tool: "lipo",
      executable: "/usr/bin/lipo",
      executableSha256: "1".repeat(64),
      toolVersion: null,
      versionReason: "fixture",
      arguments: [],
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      exitCode: 0,
      signal: null,
    }),
};

const readers = [
  ["ZIP", (path: string) => new ZipArtifactReader(path, "zip")],
  [
    "Mach-O slice",
    (path: string) => new MachOSliceArtifactReader(path, {}, runner),
  ],
] as const;

it.each(readers)(
  "retains %s reader admission and stat owners",
  async (_, createReader) => {
    const root = await createTestTempDirectory("rea-owned-reader-cleanup-");
    const path = join(root, "source");
    await writeFile(path, "fixture source");

    for (const stage of ["admission", "post-open-stat"] as const) {
      const statFailure = Object.assign(
        new Error(`primary ${stage} stat failure`),
        { code: "EIO", errno: -5, syscall: "fstat" },
      );
      const closeFailure = new Error(
        `close failed after invalidation during ${stage}`,
      );
      let descriptor: FileHandle | undefined;
      let statCalls = 0;
      let closeAttempts = 0;
      let failOnStat = stage === "admission" ? 1 : 2;
      injected.opened = (openedPath, handle) => {
        if (openedPath !== path || descriptor !== undefined) return;
        descriptor = handle;
        const stat = handle.stat.bind(handle);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (...args) => {
          statCalls += 1;
          if (statCalls === failOnStat) {
            failOnStat = -1;
            throw statFailure;
          }
          return stat(...args);
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          closeAttempts += 1;
          await close();
          throw closeFailure;
        });
      };

      const reader = createReader(path);
      const scope = new ArtifactResourceScope();
      const owner = { kind: "reader" as const, resource: path, reader };
      onTestFinished(async () => {
        injected.opened = undefined;
        await scope.close().catch(() => undefined);
        vi.restoreAllMocks();
      });

      const primary = await (async () => {
        try {
          for await (const _entry of reader.entries()) {
            // Both injected failures happen before the reader can yield an entry.
          }
        } catch (cause: unknown) {
          return cause;
        }
        throw new Error("Expected reader initialization to fail");
      })();
      expect(primary).toBeInstanceOf(Error);
      expect(causeChainContains(primary, statFailure)).toBe(true);

      const release = await scope.release(owner);
      expect(release).toEqual({ kind: "failed", cause: closeFailure });
      expect(descriptor?.fd).toBe(-1);
      await expect(scope.close()).rejects.toMatchObject({
        reason: "unavailable",
        cleanup: { reason: closeFailure.message, resources: [path] },
      });
      // Native close invalidated the fd before rejecting. Retrying the same owner
      // must remain failed without another syscall or a false successful release.
      expect(closeAttempts).toBe(1);
    }
  },
);

const causeChainContains = (cause: unknown, expected: unknown): boolean => {
  let current: unknown = cause;
  while (current instanceof Error) {
    if (current === expected) return true;
    current = current.cause;
  }
  return false;
};
