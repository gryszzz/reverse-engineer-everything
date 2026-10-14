import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import {
  execFileBytes,
  execFileOutput,
  execFileOutputFailure,
} from "./ExecFileOutput.js";

const waitForFile = async (path: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return access(path).then(
    () => true,
    () => false,
  );
};

describe("execFileOutput", () => {
  it("ignores non-Error and incomplete failure metadata", () => {
    expect(execFileOutputFailure("failure")).toBeUndefined();
    expect(execFileOutputFailure(new Error("failure"))).toBeUndefined();
  });

  it("recognizes the execFile output limit code as truncated output", () => {
    const failure = Object.assign(new Error("output limit"), {
      stdout: "partial stdout",
      stderr: "partial stderr",
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    });

    expect(execFileOutputFailure(failure)?.outputTruncated).toBe(true);
  });

  it("preserves captured bytes for callers that own the output format", async () => {
    const result = await execFileBytes(process.execPath, [
      "-e",
      "process.stdout.write(Buffer.from([0x00, 0xff, 0x41])); process.stderr.write(Buffer.from([0xfe]));",
    ]);

    expect(result.stdout).toEqual(Buffer.from([0x00, 0xff, 0x41]));
    expect(result.stderr).toEqual(Buffer.from([0xfe]));
  });

  it("reports raw byte counts when UTF-8 decoding changes the captured text", async () => {
    const result = await execFileOutput(process.execPath, [
      "-e",
      "process.stdout.write(Buffer.from([0x61, 0xff])); process.stderr.write(Buffer.from([0xe2, 0x82, 0xac]));",
    ]);

    expect(result).toMatchObject({
      stdout: "a�",
      stderr: "€",
      stdoutBytes: 2,
      stderrBytes: 3,
    });
  });

  it("captures output larger than Node's default execFile limit", async () => {
    const marker = "tail-marker";
    const result = await execFileOutput(process.execPath, [
      "-e",
      `process.stdout.write("x".repeat(2 * 1024 * 1024)); process.stdout.write(${JSON.stringify(marker)});`,
    ]);

    expect(result.stdout).toHaveLength(2 * 1024 * 1024 + marker.length);
    expect(result.stdout.endsWith(marker)).toBe(true);
  });

  it("enforces a caller supplied output bound", async () => {
    await expect(
      execFileOutput(
        process.execPath,
        ["-e", 'process.stdout.write("x".repeat(1024))'],
        { maxBuffer: 64 },
      ),
    ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });

  it("retains both captured streams on a failed child process", async () => {
    await expect(
      execFileOutput(process.execPath, [
        "-e",
        'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7;',
      ]),
    ).rejects.toMatchObject({ code: 7, stdout: "out", stderr: "err" });
  });

  it("uses the built-in execFile timeout when no stop signal is requested", async () => {
    await expect(
      execFileOutput(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        timeout: 100,
      }),
    ).rejects.toMatchObject({ killed: true });
  });

  it.skipIf(process.platform === "win32")(
    "stops an aborted process with the caller's signal and settles after it exits",
    async () => {
      const directory = await createTestTempDirectory("rea-exec-stop-");
      const ready = join(directory, "ready");
      const stopped = join(directory, "stopped");
      // The child records the signal it received only after a cleanup delay.
      const script = [
        'const fs = require("node:fs");',
        'for (const name of ["SIGINT", "SIGTERM"])',
        `  process.on(name, () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(stopped)}, name); process.exit(0); }, 200));`,
        `fs.writeFileSync(${JSON.stringify(ready)}, "");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const controller = new AbortController();
      const execution = execFileOutput(process.execPath, ["-e", script], {
        signal: controller.signal,
        stopSignal: "SIGINT",
      }).then(
        () => undefined,
        async (cause: unknown) => ({
          cause,
          stoppedBeforeSettling: await readFile(stopped, "utf8").catch(
            () => null,
          ),
        }),
      );
      const readyObserved = await waitForFile(ready);
      controller.abort();
      const outcome = await execution;

      expect(readyObserved).toBe(true);
      expect(outcome?.cause).toMatchObject({ name: "AbortError" });
      expect(outcome?.stoppedBeforeSettling).toBe("SIGINT");
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the first stop reason when timeout arrives during abort cleanup",
    async () => {
      const directory = await createTestTempDirectory("rea-exec-double-stop-");
      const ready = join(directory, "ready");
      const script = [
        'const fs = require("node:fs");',
        'for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => {});',
        `fs.writeFileSync(${JSON.stringify(ready)}, "");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const controller = new AbortController();
      const execution = execFileOutput(process.execPath, ["-e", script], {
        signal: controller.signal,
        timeout: 10_000,
        stopSignal: "SIGINT",
      });
      const startedAt = Date.now();
      expect(await waitForFile(ready)).toBe(true);
      const remainingBeforeDeadline = Math.max(
        0,
        9_000 - (Date.now() - startedAt),
      );
      await new Promise((resolve) =>
        setTimeout(resolve, remainingBeforeDeadline),
      );
      controller.abort();

      await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    },
  );

  it("rejects an already aborted stoppable command without starting it", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      execFileOutput(process.execPath, ["-e", ""], {
        signal: controller.signal,
        stopSignal: "SIGINT",
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe.skipIf(process.platform === "win32")(
  "execFileOutput stop signal at a timeout",
  () => {
    it("stops a timed-out process with the caller's signal and reports the timeout", async () => {
      const directory = await createTestTempDirectory("rea-exec-timeout-");
      const stopped = join(directory, "stopped");
      // The child exits cleanly once it has recorded the signal it received.
      const script = [
        'const fs = require("node:fs");',
        'for (const name of ["SIGINT", "SIGTERM"])',
        `  process.on(name, () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(stopped)}, name); process.exit(0); }, 200));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const failure: unknown = await execFileOutput(
        process.execPath,
        ["-e", script],
        { timeout: 2_000, stopSignal: "SIGINT" },
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );

      expect(failure).toMatchObject({ code: "ETIMEDOUT", killed: true });
      expect(await readFile(stopped, "utf8")).toBe("SIGINT");
    });

    it.each([-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2 ** 53])(
      "refuses a malformed timeout (%s) in both modes before starting the command",
      async (timeout) => {
        // Starting this command would fail with ENOENT instead.
        await expect(
          execFileOutput("/nonexistent/rea-command", [], {
            timeout,
            stopSignal: "SIGINT",
          }),
        ).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });
        await expect(
          execFileOutput("/nonexistent/rea-command", [], { timeout }),
        ).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });
      },
    );

    it("preserves a child failure's missing signal when reporting timeout", async () => {
      const directory = await createTestTempDirectory(
        "rea-exec-missing-signal-",
      );
      const ready = join(directory, "ready");
      const script = [
        'const fs = require("node:fs");',
        'for (const name of ["SIGINT", "SIGTERM"])',
        "  process.on(name, () => process.exit(1));",
        `fs.writeFileSync(${JSON.stringify(ready)}, "");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      try {
        const execution = execFileOutput(process.execPath, ["-e", script], {
          timeout: 10_000,
          stopSignal: "SIGINT",
        });
        expect(await waitForFile(ready)).toBe(true);
        await expect(execution).rejects.toMatchObject({
          code: "ETIMEDOUT",
          signal: null,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("kills a timed-out process that ignores the stop signal", async () => {
      const script = [
        'for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => {});',
        "setInterval(() => {}, 1000);",
      ].join("\n");

      await expect(
        execFileOutput(process.execPath, ["-e", script], {
          timeout: 1_000,
          stopSignal: "SIGINT",
        }),
      ).rejects.toMatchObject({
        code: "ETIMEDOUT",
        killed: true,
        signal: "SIGKILL",
      });
    });
  },
);

describe("execFileOutput failure metadata", () => {
  it("preserves raw byte counts on a failed command with invalid UTF-8", async () => {
    const failure: unknown = await execFileOutput(process.execPath, [
      "-e",
      "process.stdout.write(Buffer.from([0x61, 0xff])); process.stderr.write(Buffer.from([0xe2, 0x82, 0xac])); process.exitCode = 7;",
    ]).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(execFileOutputFailure(failure)).toMatchObject({
      stdout: "a�",
      stderr: "€",
      stdoutBytes: 2,
      stderrBytes: 3,
      code: 7,
    });
  });
  it("preserves explicit truncation metadata from an owned process failure", () => {
    const failure = Object.assign(new Error("owned output was truncated"), {
      stdout: "partial stdout",
      stderr: "partial stderr",
      code: 7,
      outputTruncated: true,
    });

    expect(execFileOutputFailure(failure)).toEqual({
      stdout: "partial stdout",
      stderr: "partial stderr",
      code: 7,
      signal: null,
      killed: false,
      outputTruncated: true,
    });
  });
});
