import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it as test, onTestFinished } from "vitest";
import { androidResultSchemas } from "../../../src/domain/android/androidAnalysis.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  createJadxProtocolFixture,
  verifyJadxFixtureCleanup,
} from "../../fixtures/android/jadx.js";

const INVENTORY_CLASS_COUNT = 7096;

/** Count inventoried names across raw call records: MCP pages ride in text content. */
const rawInventoryNames = (raw: unknown): number => {
  const calls =
    (
      raw as {
        calls?: {
          operation: string;
          response: { content?: { text?: string }[] };
        }[];
      }
    ).calls ?? [];
  return calls
    .flatMap((call) => call.response.content ?? [])
    .map((entry) =>
      entry.text === undefined ? {} : (JSON.parse(entry.text) as unknown),
    )
    .filter((page) => Array.isArray((page as { items?: unknown[] }).items))
    .flatMap((page) => (page as { items: unknown[] }).items).length;
};

test("delivers bounded search_android_classes Evidence while retaining the complete inventory", async () => {
  const { provider, apk, launches } = await createJadxProtocolFixture(
    "normal",
    undefined,
    { classCount: INVENTORY_CLASS_COUNT - 1 },
  );
  const session = createTestBinarySession(() => {
    throw new Error("APK analysis must not acquire a deep binary provider");
  });
  const server = createServer(
    { kind: "session", session },
    { androidAnalysis: provider },
  );
  const client = new Client({
    name: "android-search-inventory-budget",
    version: "1",
  });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const search = async (query: string) =>
    parseEvidence(
      (
        await client.callTool({
          name: "search_android_classes",
          arguments: { path: apk, query },
        })
      ).structuredContent,
    );

  const single = await search("Target");
  expect(
    androidResultSchemas.search_android_classes.parse(single.normalized_result),
  ).toMatchObject({
    query: "Target",
    total_classes: INVENTORY_CLASS_COUNT,
    matches: ["fixture.Target"],
    coverage: "complete",
  });
  // The inline raw record keeps the pagination audit, not the class names.
  const singleRaw = JSON.stringify(single.raw_result);
  expect(singleRaw).not.toContain("fixture.Class");
  expect(singleRaw).toContain("items_omitted");
  expect(Buffer.byteLength(JSON.stringify(single))).toBeLessThan(32 * 1024);
  // The complete inventory stays locally retrievable through the retained record.
  const completeId = single.evidence_links[0];
  expect(completeId).toBeDefined();
  expect(completeId).toBe(
    (single.raw_result as { complete_evidence_id: string })
      .complete_evidence_id,
  );
  const complete = session.evidenceById(completeId as string);
  expect(complete).toBeDefined();
  expect(complete?.operation).toBe("search_android_classes");
  expect(rawInventoryNames(complete?.raw_result)).toBe(INVENTORY_CLASS_COUNT);
  expect(JSON.stringify(complete?.raw_result)).toContain("fixture.Class7094");

  const empty = await search("fixture.Missing");
  expect(
    androidResultSchemas.search_android_classes.parse(empty.normalized_result),
  ).toMatchObject({
    query: "fixture.Missing",
    total_classes: INVENTORY_CLASS_COUNT,
    matches: [],
    coverage: "complete",
  });
  expect(JSON.stringify(empty.raw_result)).not.toContain("fixture.Class");

  await client.close();
  await server.close();
  await verifyJadxFixtureCleanup(launches);
});

test("keeps the complete search inventory inline without a retaining session", async () => {
  const { service, apk, launches, provider } = await createJadxProtocolFixture(
    "normal",
    undefined,
    { classCount: INVENTORY_CLASS_COUNT - 1 },
  );
  const result = await service.execute("search_android_classes", {
    path: apk,
    query: "Target",
  });
  if (!result.ok) throw result.error;
  // Complete CLI JSON output keeps the full raw provider inventory.
  expect(rawInventoryNames(result.value.raw_result)).toBe(
    INVENTORY_CLASS_COUNT,
  );
  await provider.close();
  await verifyJadxFixtureCleanup(launches);
});
