import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { observed } from "../../fixtures/analysisExecution.js";

it("selects and reassesses finite hypotheses through matching CLI and MCP workflows", async () => {
  const evidenceId = `ev_${"1".repeat(64)}`;
  const request = {
    hypotheses: [
      {
        id: "identity",
        predictions: [
          { input: 0, outcome: 0 },
          { input: 1, outcome: 1 },
        ],
      },
      {
        id: "double",
        predictions: [
          { input: 0, outcome: 0 },
          { input: 1, outcome: 2 },
        ],
      },
    ],
    observations: [{ input: 0, outcome: 0, evidence_ids: [evidenceId] }],
    candidate_inputs: [1],
  };
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(ok(null)),
  }));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "finite-hypothesis-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const catalog = await client.listTools();
    const tool = catalog.tools.find(
      ({ name }) => name === "discriminate_finite_hypotheses",
    );
    expect(tool?.outputSchema).toBeDefined();
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    expect(
      ajv.validateSchema(tool!.outputSchema as AnySchema),
      ajv.errorsText(ajv.errors),
    ).toBe(true);
    const result = await client.callTool({
      name: "discriminate_finite_hypotheses",
      arguments: request,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      assessment: {
        state: "probe-recommended",
        selected_probe: { input: 1, information_gain_bits: 1 },
      },
    });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "scripts/rea.mjs",
        "discriminate-finite-hypotheses",
        JSON.stringify(request),
        "--json",
      ],
      { cwd: process.cwd(), env: process.env },
    );
    expect(JSON.parse(stdout)).toEqual(result.structuredContent);
    const updated = await client.callTool({
      name: "discriminate_finite_hypotheses",
      arguments: {
        ...request,
        observations: [
          ...request.observations,
          { input: 1, outcome: 1, evidence_ids: [`ev_${"2".repeat(64)}`] },
        ],
      },
    });
    expect(updated.structuredContent).toMatchObject({
      assessment: {
        state: "already-unique-within-model",
        surviving_hypothesis_ids: ["identity"],
      },
    });
    const malformed = await client.callTool({
      name: "discriminate_finite_hypotheses",
      arguments: { ...request, hypotheses: [] },
    });
    expect(malformed.isError).toBe(true);
    const contradictory = await client.callTool({
      name: "discriminate_finite_hypotheses",
      arguments: {
        ...request,
        observations: [
          ...request.observations,
          { input: 1, outcome: 99, evidence_ids: [evidenceId] },
        ],
      },
    });
    expect(contradictory.structuredContent).toMatchObject({
      assessment: {
        state: "no-consistent-hypothesis",
        evidence_ids: [evidenceId],
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
}, 30_000);
