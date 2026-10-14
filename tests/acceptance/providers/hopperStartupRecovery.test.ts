import { spawn, type ChildProcess } from "node:child_process";
import { access, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, onTestFinished, vi } from "vitest";
import { z } from "zod";

import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";
import { acquireHopperTargetLease } from "../../../src/hopper/HopperTargetLease.js";

const statusSchema = z.object({ result: z.object({ open: z.boolean() }) });
const test = workspaceCliTest.skipIf(process.platform !== "darwin");

test(
  "retains a denial-shaped failure when caller arguments can alter the helper's AppleScript",
  { timeout: 90_000 },
  async ({ workspace }) => {
    for (const source of ["target", "loader"] as const) {
      const target = workspace.path(
        source === "target" ? 'quoted"target' : "loader-target",
      );
      await copyFile("/usr/bin/true", target);
      const mode = await workspace.write(
        `${source}-mode`,
        "denied-after-handoff",
      );
      const receipt = workspace.path(`${source}-bootstrap`);
      const loaderArgs = [
        resolve("tests/fixtures/hopperLaunchAdmission.mjs"),
        mode,
        receipt,
        ...(source === "loader" ? ['caller"loader'] : []),
      ];
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve("dist/main.js")],
        stderr: "pipe",
        env: {
          ...workspace.environment,
          PATH: process.env.PATH ?? "",
          REA_ANALYSIS_PROVIDER: "hopper",
          HOPPER_LAUNCHER_PATH: process.execPath,
          HOPPER_LOADER_ARGS_JSON: JSON.stringify(loaderArgs),
          REA_LOG_LEVEL: "silent",
        },
      });
      const mcp = new Client({ name: "hopper-literal-boundary", version: "1" });
      let runtime: string | undefined;
      try {
        await mcp.connect(transport);
        const call = (name: string, arguments_: Record<string, string> = {}) =>
          mcp.callTool({ name, arguments: arguments_ });
        expect((await call("open_binary", { path: target })).isError).not.toBe(
          true,
        );
        const first = parseMcpToolError(await call("current_document"));
        runtime = dirname(await readFile(receipt, "utf8"));
        expect(first.error).toMatchObject({
          code: "cleanup_incomplete",
          details: {
            diagnostics: {
              primary_error: {
                code: "provider_unavailable",
                details: {
                  launcher: {
                    exit_code: 2,
                    stderr: {
                      text: expect.stringContaining(
                        "Not authorized to send Apple events",
                      ),
                    },
                  },
                },
              },
            },
          },
        });
        await access(`${receipt}.document-created`);
        await access(runtime);
        expect(parseMcpToolError(await call("list_procedures"))).toEqual(first);
        expect(parseMcpToolError(await call("close_binary")).error.code).toBe(
          "cleanup_incomplete",
        );
      } finally {
        // SDK close can return immediately after SIGKILL. Wait for its actual
        // child-close event before recovering this process's retained lease.
        let serverExited: Promise<void> | undefined;
        if (transport.pid !== null) {
          const onclose = transport.onclose;
          serverExited = new Promise<void>((resolveExit) => {
            transport.onclose = () => {
              onclose?.();
              resolveExit();
            };
          });
        }
        await mcp.close();
        await transport.close();
        await serverExited;
        // The fixture created only this marker, never a native GUI document.
        if (runtime !== undefined)
          await rm(runtime, { recursive: true, force: true });
        const acquired = await acquireHopperTargetLease({
          targetPath: target,
          targetKind: "executable",
          loaderArgs,
          runId: "literal-boundary-test-cleanup",
        });
        if (!acquired.acquired) throw new Error("Fixture lease remained live");
        await acquired.lease.release();
      }
    }
  },
);

test("recovers a denied Hopper launch through the same stdio MCP session and CLI", async ({
  workspace,
  cli,
}) => {
  const target = workspace.path("target");
  await copyFile("/usr/bin/true", target);
  const mode = await workspace.write("mode", "denied");
  const receipt = workspace.path("bootstrap-path");
  const environment = {
    ...workspace.environment,
    PATH: process.env.PATH ?? "",
    REA_ANALYSIS_PROVIDER: "hopper",
    HOPPER_LAUNCHER_PATH: process.execPath,
    HOPPER_LOADER_ARGS_JSON: JSON.stringify([
      resolve("tests/fixtures/hopperLaunchAdmission.mjs"),
      mode,
      receipt,
    ]),
    REA_LOG_LEVEL: "silent",
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/main.js")],
    env: environment,
    stderr: "pipe",
  });
  const mcp = new Client({ name: "hopper-startup-recovery", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  onTestFinished(async () => {
    await mcp.close();
    await transport.close();
  });
  await mcp.connect(transport);
  const call = (name: string, arguments_: Record<string, string> = {}) =>
    mcp.callTool({ name, arguments: arguments_ }).catch((cause: unknown) => {
      throw new Error(`${name}: ${stderr}`, { cause });
    });
  expect((await call("open_binary", { path: target })).isError).not.toBe(true);
  for (const operation of ["current_document", "list_procedures"]) {
    const { error } = parseMcpToolError(await call(operation));
    expect(error).toMatchObject({
      code: "provider_unavailable",
      details: {
        stage: "launch",
        launcher: {
          exit_code: 2,
          stderr: {
            text: expect.stringContaining(
              "Not authorized to send Apple events",
            ),
          },
        },
      },
    });
    expect(error.message).toContain("Automation");
    const bootstrap = await readFile(receipt, "utf8");
    await expect(access(dirname(bootstrap))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  expect((await call("close_binary")).isError).not.toBe(true);
  const deniedCli = await cli.run({
    arguments: ["analyze", target, "--provider", "hopper", "--json"],
    environment,
    timeoutMs: 15_000,
  });
  expect(deniedCli.exitCode).toBe(1);
  expect(deniedCli.json).toMatchObject({
    code: "provider_unavailable",
    details: { launcher: { exit_code: 2 } },
  });

  await writeFile(mode, "bridge");
  expect((await call("open_binary", { path: target })).isError).not.toBe(true);
  expect((await call("current_document")).isError).not.toBe(true);
  expect((await call("close_binary")).isError).not.toBe(true);
  expect(
    statusSchema.parse((await call("binary_session")).structuredContent).result
      .open,
  ).toBe(false);
});

test.for(["handoff", "not-found"] as const)(
  "preserves an unconfirmed %s handoff and closes only a late bridge with matching run identity",
  { timeout: 60_000 },
  async (launchMode, { workspace }) => {
    const target = workspace.path("target");
    await copyFile("/usr/bin/true", target);
    const mode = await workspace.write("mode", launchMode);
    const receipt = workspace.path("bootstrap-path");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/main.js")],
      stderr: "pipe",
      env: {
        ...workspace.environment,
        PATH: process.env.PATH ?? "",
        REA_ANALYSIS_PROVIDER: "hopper",
        HOPPER_LAUNCHER_PATH: process.execPath,
        HOPPER_LOADER_ARGS_JSON: JSON.stringify([
          resolve("tests/fixtures/hopperLaunchAdmission.mjs"),
          mode,
          receipt,
        ]),
        REA_HOPPER_STARTUP_TIMEOUT_MS: "2000",
        REA_LOG_LEVEL: "silent",
      },
    });
    const mcp = new Client({ name: "hopper-late-readiness", version: "1" });
    const children: ChildProcess[] = [];
    let runtime: string | undefined;
    const stop = async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolveExit) =>
        child.once("exit", () => resolveExit()),
      );
      child.kill("SIGKILL");
      await exited;
    };
    onTestFinished(async () => {
      await Promise.all(children.map(stop));
      await mcp.close();
      await transport.close();
      if (runtime !== undefined)
        await rm(runtime, { recursive: true, force: true });
    });
    await mcp.connect(transport);
    const call = (name: string, arguments_: Record<string, string> = {}) =>
      mcp.callTool({ name, arguments: arguments_ });
    expect((await call("open_binary", { path: target })).isError).not.toBe(
      true,
    );
    const initial = parseMcpToolError(await call("current_document"));
    expect(initial.error).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        diagnostics: {
          primary_error: {
            code:
              launchMode === "handoff"
                ? "provider_timeout"
                : "provider_unavailable",
            details:
              launchMode === "handoff"
                ? { timeout_ms: 2000, launcher: { exit_code: 0 } }
                : { stage: "launch", launcher: { exit_code: 3 } },
          },
        },
      },
    });
    if (launchMode === "not-found") {
      await access(`${receipt}.document-created`);
      expect(initial.error.details).toMatchObject({
        diagnostics: {
          primary_error: { message: expect.stringContaining("Spotlight") },
        },
      });
    }
    expect(parseMcpToolError(await call("list_procedures"))).toEqual(initial);
    const status = z.object({
      result: z.object({
        provider_operation_health: z.object({
          // A timeout observes incomplete startup; a failed launcher without
          // confirmed ownership leaves the provider's state unknown.
          state: z.literal(
            launchMode === "handoff" ? "not_started" : "unknown",
          ),
          stage: z.literal("launch"),
        }),
      }),
    });
    status.parse((await call("binary_session")).structuredContent);
    expect(parseMcpToolError(await call("close_binary")).error.code).toBe(
      "cleanup_incomplete",
    );
    const bootstrap = await readFile(await readFile(receipt, "utf8"), "utf8");
    const setting = (name: string): string => {
      const line = bootstrap
        .split("\n")
        .find((value) => value.startsWith(`${name} = `));
      if (line === undefined)
        throw new Error(`Missing bootstrap setting ${name}`);
      return z.string().parse(JSON.parse(line.slice(name.length + 3)));
    };
    const socket = setting("REA_SOCKET");
    const token = setting("REA_TOKEN");
    const runId = setting("REA_RUN_ID");
    runtime = dirname(socket);
    const lateBridge = (identity: string, credential = token) => {
      const child = spawn(
        process.execPath,
        [
          resolve("tests/fixtures/fakeHopper.mjs"),
          socket,
          credential,
          identity,
        ],
        { stdio: "ignore" },
      );
      children.push(child);
      return child;
    };
    for (const [identity, credential] of [
      ["different-run", token],
      [runId, "different-token"],
    ] as const) {
      const wrong = lateBridge(identity, credential);
      await vi.waitFor(() => access(socket));
      expect(parseMcpToolError(await call("close_binary")).error.code).toBe(
        "cleanup_incomplete",
      );
      expect(wrong.exitCode).toBeNull();
      await access(runtime);
      await stop(wrong);
      await rm(socket, { force: true });
    }
    const closing = call("close_binary");
    await delay(150);
    // A verified close may remove the socket before the fixture can poll it.
    // The successful close and child exit establish the owned bridge outcome.
    const owned = lateBridge(runId);
    expect((await closing).isError).not.toBe(true);
    await vi.waitFor(() => expect(owned.exitCode).toBe(0));
    await expect(access(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(mode, "bridge");
    expect((await call("open_binary", { path: target })).isError).not.toBe(
      true,
    );
    expect((await call("current_document")).isError).not.toBe(true);
    expect((await call("close_binary")).isError).not.toBe(true);
  },
);
