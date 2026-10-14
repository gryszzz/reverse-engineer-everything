import { readFile, rm } from "node:fs/promises";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, onTestFinished } from "vitest";
import { z } from "zod";

import { toolContract } from "../../src/contracts/toolContracts.js";
import { createServer } from "../../src/server/createServer.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";

export const waitForStartedFile = async (path: string): Promise<void> => {
  await expect
    .poll(() => readFile(path, "utf8").catch(() => ""))
    .toBe("started");
};

export const validateDebuggerStatusResponse = async (
  client: Client,
  name: "gdb_session_status" | "rizin_debug_session_status",
  sessionId: string,
): Promise<Record<string, unknown>> => {
  const listed = (await client.listTools()).tools.find(
    (tool) => tool.name === name,
  );
  if (listed?.outputSchema === undefined)
    throw new Error(`Missing advertised ${name} output schema`);
  const response = await client.callTool({
    name,
    arguments: { session_id: sessionId },
  });
  expect(response.isError).not.toBe(true);
  const parsed = toolContract(name).outputSchema.parse(
    response.structuredContent,
  );
  expect(
    new Ajv2020({ strict: false, validateFormats: false }).validate(
      z.record(z.string(), z.unknown()).parse(listed.outputSchema),
      parsed,
    ),
  ).toBe(true);
  return z.record(z.string(), z.unknown()).parse(parsed);
};

export const createProviderEnvironmentMcpHarness = async (options: {
  readonly directory: string;
  readonly clientName: string;
  readonly serverOptions: NonNullable<Parameters<typeof createServer>[1]>;
}) => {
  const session = createTestBinarySession(() => {
    throw new Error("No binary analysis provider should start");
  });
  const server = createServer(
    { kind: "session", session },
    options.serverOptions,
  );
  const client = new Client({ name: options.clientName, version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
    await rm(options.directory, { recursive: true, force: true });
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client };
};
