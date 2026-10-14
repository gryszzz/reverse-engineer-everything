import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { parseEvidence } from "../../src/domain/evidence.js";
import { webEventListenersSchema } from "../../src/domain/webEventListeners.js";
import { startRuntimeBrowser } from "../fixtures/webRuntime.js";

const entrypoint = fileURLToPath(
  new URL("../../scripts/rea.mjs", import.meta.url),
);
const environment = () => ({
  ...process.env,
  REA_LOG_LEVEL: "silent",
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-provider/hopper",
});

it("runs the compiled public listener command through its default native CDP composition", async () => {
  const browser = await startRuntimeBrowser();
  onTestFinished(() => browser.close());
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      entrypoint,
      "inspect-web-event-listeners",
      browser.endpoint,
      "allowed-page",
      "#selected",
      "--json",
    ],
    { env: environment(), timeout: 20_000 },
  );
  const result = webEventListenersSchema.parse(
    parseEvidence(JSON.parse(stdout)).normalized_result,
  );
  expect(result.listeners[0]?.location).toMatchObject({
    script_id: "script-a",
    source_association: "script_id",
  });
  expect(result.selected_node.selector).toBe("#selected");
});

it("translates SIGINT after real CLI arming into awaited instrumentation cleanup and a nonzero CLI failure", async () => {
  const browser = await startRuntimeBrowser();
  onTestFinished(() => browser.close());
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      "observe-web-execution",
      browser.endpoint,
      "allowed-page",
      "--observation-ms",
      "30000",
      "--json",
    ],
    { env: environment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  let stderr = "";
  let stdout = "";
  let armed = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (
      !armed &&
      stderr.includes('"completed":1') &&
      stderr.includes("browser_execution")
    ) {
      armed = true;
      child.kill("SIGINT");
    }
  });
  try {
    const [code, signal] = await once(child, "close");
    expect(armed, stderr).toBe(true);
    expect(code, stderr).not.toBe(0);
    expect(signal).toBeNull();
    const result: unknown = JSON.parse(stdout);
    expect(result).toMatchObject({
      code: "cancelled",
      category: "cancelled",
      details: { cleanup: "complete", operation: "observe_web_execution" },
    });
    expect(
      browser.commands.some(
        (command) => command.method === "Profiler.stopPreciseCoverage",
      ),
    ).toBe(true);
    expect(
      browser.commands.some(
        (command) => command.method === "Target.detachFromTarget",
      ),
    ).toBe(true);
  } finally {
    clearTimeout(timer);
  }
});

const cancellationSignals =
  process.platform === "win32"
    ? (["SIGINT"] as const)
    : (["SIGINT", "SIGTERM"] as const);
const webRuntimeCancellationCases = (
  ["observe-web-execution", "inspect-web-event-listeners"] as const
).flatMap((command) =>
  cancellationSignals.map(
    (signal) => [command, signal, signal === "SIGINT" ? 130 : 143] as const,
  ),
);

it.each(webRuntimeCancellationCases)(
  "%s preserves %s status when cancellation interrupts CDP discovery",
  async (command, signal, expectedExitCode) => {
    const sockets = new Set<Socket>();
    const server = createServer(() => undefined);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected a TCP loopback listener");
    const endpoint = `http://127.0.0.1:${String(address.port)}`;
    const contacted = once(server, "request");

    const args =
      command === "observe-web-execution"
        ? [
            command,
            endpoint,
            "page-fixture",
            "--observation-ms",
            "30000",
            "--json",
          ]
        : [command, endpoint, "page-fixture", "body", "--json"];
    const child = spawn(process.execPath, [entrypoint, ...args], {
      env: environment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      let contactTimeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          contacted,
          new Promise<never>((_resolve, reject) => {
            contactTimeout = setTimeout(
              () => reject(new Error("CLI did not contact the CDP fixture")),
              5_000,
            );
          }),
        ]);
      } finally {
        if (contactTimeout !== undefined) clearTimeout(contactTimeout);
      }
      child.kill(signal);
      const [exitCode, terminationSignal] = await closed;
      expect(terminationSignal).toBeNull();
      expect(exitCode).toBe(expectedExitCode);
      expect(JSON.parse(stdout)).toMatchObject({
        code: "cancelled",
        category: "cancelled",
        details: { cleanup: "complete" },
      });
    } finally {
      clearTimeout(timeout);
      try {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await closed;
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  },
);
