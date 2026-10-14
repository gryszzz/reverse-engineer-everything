import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { TestReverseEngineeringService } from "../support/reverseEngineeringService.js";

it("bounds concurrent reverse-engineering provider calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-capacity-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let mode: "success" | "failure" | "timeout" = "success";
  const service = new TestReverseEngineeringService({
    run: async () => {
      calls += 1;
      if (mode === "failure")
        throw Object.assign(new Error("provider failed"), { code: "ENOENT" });
      if (mode === "timeout")
        throw Object.assign(new Error("provider timed out"), {
          code: "ETIMEDOUT",
        });
      await gate;
      return { stdout: "", stderr: "" };
    },
  });

  try {
    const active = Array.from({ length: 8 }, () =>
      service.inspectWithObjdump({ path, operation: "file_headers" }),
    );
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      service.inspectWithObjdump(
        { path, operation: "file_headers" },
        { signal: preAborted.signal },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    await expect(
      service.inspectWithObjdump({ path, operation: "file_headers" }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "transport",
        reportedLimits: {
          max_concurrent_operations: 8,
          active_operations: 8,
        },
      },
    });
    release();
    const results = await Promise.all(active);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(calls).toBe(8);

    mode = "failure";
    const failed = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.inspectWithObjdump({ path, operation: "file_headers" }),
      ),
    );
    expect(failed.every((result) => !result.ok)).toBe(true);

    mode = "timeout";
    const timedOut = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.inspectWithObjdump({ path, operation: "file_headers" }),
      ),
    );
    expect(timedOut.every((result) => !result.ok)).toBe(true);

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.inspectWithObjdump(
          { path, operation: "file_headers" },
          { signal: aborted.signal },
        ),
      ),
    );
    expect(cancelled.every((result) => !result.ok)).toBe(true);

    mode = "success";
    await expect(
      service.inspectWithObjdump({ path, operation: "file_headers" }),
    ).resolves.toMatchObject({ ok: true });
  } finally {
    release();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
