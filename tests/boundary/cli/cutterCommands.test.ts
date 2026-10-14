import { createServer } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cli } from "incur";
import { afterEach, describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { serveCli } from "./cliServeHarness.js";

const SESSION_ID = "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a";
const registeredCommands = Cli.toCommands as WeakMap<
  object,
  Map<string, unknown>
>;

const cutterCommand = async (
  environment: Record<string, string | undefined>,
  args: {
    readonly sessionId: string;
    readonly expectedGeneration: number;
    readonly command: string;
  },
): Promise<unknown> => {
  const cli = createCli(environment);
  const entry = registeredCommands.get(cli)?.get("cutter-command") ?? {};
  const run = Reflect.get(entry, "run") as (...args: unknown[]) => unknown;
  return Reflect.apply(run, undefined, [{ args, options: { json: false } }]);
};

const listen = async (
  server: ReturnType<typeof createServer>,
): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected an ephemeral TCP listener");
  return address.port;
};

describe("Cutter CLI commands", () => {
  let directory: string | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (server !== undefined)
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
    directory = undefined;
    server = undefined;
  });

  it("lists sessions from the selected bridge directory", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-cutter-cli-test-"));

    const result = await serveCli(["list-cutter-sessions", "--json"], {
      REA_CUTTER_BRIDGE_DIR: directory,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      sessions: [],
      discovery_status: "no_live_bridge_found",
      bridge_directory: directory,
    });
  });

  it("reports an unavailable selected session for a command", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-cutter-cli-test-"));

    const result = await serveCli(
      ["cutter-command", SESSION_ID, "0", "pdi", "--json"],
      { REA_CUTTER_BRIDGE_DIR: directory },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("invalid_request");
  });

  it("returns Evidence when the selected Cutter session completes a command", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-cutter-cli-test-"));
    const token = "synthetic-cutter-cli-token-for-test";
    let nextConnectionOrdinal = 0;
    server = createServer((connection) => {
      const ordinal = ++nextConnectionOrdinal;
      connection.setEncoding("utf8");
      let input = "";
      let clientNonce = "";
      let serverNonce = "";
      connection.on("data", (chunk: string) => {
        input += chunk;
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const frame = JSON.parse(input.slice(0, newline)) as Record<
          string,
          unknown
        >;
        input = input.slice(newline + 1);
        if (frame.kind === "rea-auth-v2") {
          clientNonce = String(frame.nonce);
          serverNonce = `${ordinal.toString(16).padStart(16, "0")}${"b".repeat(48)}`;
          connection.write(
            `${JSON.stringify({ session_id: SESSION_ID, nonce: serverNonce, proof: createHmac("sha256", token).update(`rea-cutter-server-v2:${SESSION_ID}:${clientNonce}:${serverNonce}`).digest("hex") })}\n`,
          );
          return;
        }
        const requestBytes = String(frame.request);
        const request = JSON.parse(requestBytes) as Record<string, unknown>;
        if (
          frame.proof !==
          createHmac("sha256", token)
            .update(
              `rea-cutter-client-v2:${SESSION_ID}:${clientNonce}:${serverNonce}:${requestBytes}`,
            )
            .digest("hex")
        ) {
          connection.destroy();
          return;
        }
        const status = request.kind === "status";
        const response = JSON.stringify({
          ok: true,
          session_id: request.session_id,
          ...(status
            ? {
                current_file: null,
                document_generation: 0,
                cutter_version: "Cutter fixture",
                identity_status: "partial",
                completed_connection: (ordinal - 1)
                  .toString(16)
                  .padStart(16, "0"),
                completed_commands: [],
              }
            : request.kind === "ack"
              ? { acknowledged: false }
              : {
                  output: { answer: 42 },
                  current_file: null,
                  document_generation: 0,
                  cutter_version: "Cutter fixture",
                  identity_status: "partial",
                  execution_state: "complete",
                  output_truncated: false,
                }),
        });
        const proof = createHmac("sha256", token)
          .update(
            `rea-cutter-response-v2:${SESSION_ID}:${clientNonce}:${serverNonce}:${response}`,
          )
          .digest("hex");
        connection.end(`${JSON.stringify({ response, proof })}\n`);
      });
    });
    const port = await listen(server);
    await writeFile(
      join(directory, `cutter-${process.pid}-${SESSION_ID}.json`),
      JSON.stringify({
        session_id: SESSION_ID,
        pid: process.pid,
        host: "127.0.0.1",
        port,
        token,
        document_generation: 0,
        current_file: null,
        cutter_version: "Cutter fixture",
        identity_status: "partial",
      }),
      { mode: 0o600 },
    );

    const result = await cutterCommand(
      { REA_CUTTER_BRIDGE_DIR: directory },
      { sessionId: SESSION_ID, expectedGeneration: 0, command: "pdi" },
    );

    expect(JSON.stringify(result)).toContain("rea.cutter.command-observation");
    expect(JSON.stringify(result)).toContain('"answer":42');
  });
});
