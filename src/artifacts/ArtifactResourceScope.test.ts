import { expect, it } from "vitest";

import { err } from "../domain/result.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import type { ArtifactReader } from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

it("waits for admitted operations and shares concurrent close", async () => {
  const scope = new ArtifactResourceScope();
  const started = deferred<void>();
  const finish = deferred<void>();
  const operation = scope.run(async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;

  const close = scope.close();
  expect(scope.close()).toBe(close);
  await expect(scope.run(async () => undefined)).rejects.toMatchObject({
    reason: "unavailable",
    message: "Artifact resource scope is closed",
  });
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);

  finish.resolve();
  await operation;
  await close;
  expect(closed).toBe(true);
});

it("retains the same failed reader owner and retries before admitting work", async () => {
  const scope = new ArtifactResourceScope();
  let closeAttempts = 0;
  const reader = {
    async close() {
      closeAttempts += 1;
      if (closeAttempts < 4) throw new Error(`close attempt ${closeAttempts}`);
    },
  } as unknown as ArtifactReader;
  const owner = { kind: "reader" as const, resource: "fixture reader", reader };

  expect(await scope.release(owner)).toMatchObject({ kind: "failed" });
  expect(closeAttempts).toBe(1);

  await expect(scope.run(async () => "must not run")).rejects.toMatchObject({
    reason: "unavailable",
    message: "Artifact cleanup remains incomplete: fixture reader",
  });
  expect(closeAttempts).toBe(2);
  await expect(scope.close()).rejects.toMatchObject({
    reason: "unavailable",
  });
  expect(closeAttempts).toBe(3);
  await scope.close();
  expect(closeAttempts).toBe(4);
});

it("retains a failed source analyzer until shutdown can verify its release", async () => {
  const scope = new ArtifactResourceScope();
  let releaseAllowed = false;
  const failure = new AnalysisOutputError(
    "analyze_javascript_application",
    "Owned worker is still running",
  );
  const owner = {
    kind: "javascript-source-analysis" as const,
    resource: "fixture source analyzer",
    analysis: {
      async analyze() {
        return err({
          error: failure,
          javascript: null,
          module: null,
          projection: null,
        });
      },
      async close() {
        if (!releaseAllowed) throw failure;
      },
    },
  };
  expect(await scope.release(owner)).toEqual({
    kind: "failed",
    cause: failure,
  });
  let admitted = false;
  await expect(
    scope.run(async () => {
      admitted = true;
    }),
  ).rejects.toMatchObject({
    cleanup: { resources: ["fixture source analyzer"] },
  });
  expect(admitted).toBe(false);
  await expect(scope.close()).rejects.toMatchObject({
    cleanup: { resources: ["fixture source analyzer"] },
  });
  releaseAllowed = true;
  await scope.close();
});
