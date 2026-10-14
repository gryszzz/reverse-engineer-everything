import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

describe("ordinary MCP progress and cancellation", () => {
  it("advances MCP progress when provider waiting does not advance completed work", async () => {
    const analysis: AnalysisOperationPort = {
      execute: async (_operation, _parameters, options) => {
        for (const message of ["import pending", "analysis pending"]) {
          await delay(120);
          await options?.progress?.report({
            phase: "ghidra_startup",
            completed: 0,
            total: null,
            message,
          });
        }
        return observed("0x1000");
      },
    };
    const server = createServer({ kind: "fixed", analysis });
    const client = new Client({ name: "progress-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const progress: {
      progress: number;
      total?: number | undefined;
      message?: string | undefined;
    }[] = [];
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool(
        { name: "current_address", arguments: {} },
        { onprogress: (update) => progress.push(update) },
      );

      expect(result.isError).not.toBe(true);
      expect(progress[0]?.progress).toBe(1);
      expect(progress.map((update) => update.message)).toEqual(
        expect.arrayContaining([
          "ghidra_startup: import pending",
          "ghidra_startup: analysis pending",
        ]),
      );
      expect(progress.at(-1)?.message).toContain("completed");
      progress.forEach((update, index) => {
        expect(update.progress).toBeGreaterThan(
          progress[index - 1]?.progress ?? 0,
        );
        expect(update.total).toBeUndefined();
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("propagates client cancellation to the active provider request", async () => {
    let providerObservedCancellation = false;
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const analysis: AnalysisOperationPort = {
      execute: async (operation, _parameters, options) => {
        markProviderStarted?.();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              providerObservedCancellation = true;
              resolve();
            },
            { once: true },
          );
        });
        return err(new AnalysisCancelledError(operation));
      },
    };
    const server = createServer({ kind: "fixed", analysis });
    const client = new Client({ name: "cancellation-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const controller = new AbortController();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const request = client.callTool(
        { name: "current_address", arguments: {} },
        { signal: controller.signal },
      );
      await providerStarted;
      controller.abort();
      await expect(request).rejects.toThrow(/abort/iu);
      await expect.poll(() => providerObservedCancellation).toBe(true);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
