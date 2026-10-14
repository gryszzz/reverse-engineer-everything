import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect } from "vitest";

import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
} from "../../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../../src/domain/evidence.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const plist = (message: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>message</key><string>${message}</string></dict></plist>\n`;

const inventoryEvidence = (input: unknown): Evidence => {
  const inspection = parseEvidence(input);
  const inventory = artifactInspectionResultSchema
    .parse(inspection.normalized_result)
    .substeps.find(
      ({ evidence }) => evidence.operation === "inventory_artifact",
    )?.evidence;
  if (inventory === undefined) throw new Error("Expected inventory Evidence");
  return parseEvidence(inventory);
};

const inspectPair = async (
  cli: TestCli,
  leftPath: string,
  rightPath: string,
) => {
  const result = await cli.run({
    arguments: ["inspect-artifact", leftPath, "--json"],
  });
  expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
  const left = inventoryEvidence(result.json);
  const { call } = await connectLocalToolsMcp();
  const opened = await call("open_binary", { path: rightPath });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const inspected = await call("inspect_artifact", {});
  expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
  return { left, right: inventoryEvidence(inspected.structuredContent), call };
};

const assertCoverageControls = async ({
  left,
  right,
  inventory,
  compare,
}: {
  left: Evidence;
  right: Evidence;
  inventory: ArtifactInventoryResult;
  compare: (left: Evidence, right: Evidence) => Promise<Evidence>;
}) => {
  // Authenticated derived controls isolate missing members and genuine coverage
  // gaps; they do not claim that the complete plist producer omitted children.
  const derive = (result: unknown) =>
    createEvidence(
      {
        path: right.subject?.local_path ?? "",
        sha256: inventory.manifest.root_sha256,
        format: "plist",
      },
      right.provider,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: jsonValueSchema.parse(result),
        confidence: "derived",
        authority: "shipped-artifact",
      },
    );
  const partial = await compare(left, derive({ ...inventory, nodes: [] }));
  expect(partial.normalized_result).toMatchObject({
    status: "truncated",
    summary: { unchanged: 0, unknown: 1 },
  });
  const reworded = await compare(
    left,
    derive({
      ...inventory,
      coverage: { scope: "root", status: "complete" },
      limitations: ["Root bytes observed; no container children are modeled."],
    }),
  );
  expect(reworded.normalized_result).toMatchObject({
    status: "unchanged",
    summary: { unchanged: 1, unknown: 0 },
    limitations: expect.arrayContaining([
      "Right: Root bytes observed; no container children are modeled.",
    ]),
  });
  const gap = await compare(
    left,
    derive({
      ...inventory,
      coverage: { scope: "root", status: "unknown" },
      coverage_status: "partial",
      limitations: [],
    }),
  );
  expect(gap.normalized_result).toMatchObject({
    status: "unknown",
    summary: { unchanged: 0, unknown: 1 },
  });
  const differentScope = await compare(
    left,
    derive({
      ...inventory,
      coverage: { scope: "container-entries", status: "complete" },
    }),
  );
  expect(differentScope.normalized_result).toMatchObject({
    status: "unknown",
    limitations: expect.arrayContaining(["Artifact inventory scopes differ."]),
  });

  const { coverage, coverage_status: _coverageStatus, ...legacy } = inventory;
  expect(coverage).toBeDefined();
  const retained = await compare(left, derive(legacy));
  expect(retained.normalized_result).toMatchObject({
    status: "unchanged",
    summary: { unchanged: 1, unknown: 0 },
  });
  for (const limitation of [
    "Child inventory is unavailable.",
    "Missing child observations; 1 integrity contradiction(s) were recorded.",
  ]) {
    const unfamiliarLegacy = await compare(
      left,
      derive({ ...legacy, limitations: [limitation] }),
    );
    expect(unfamiliarLegacy.normalized_result).toMatchObject({
      status: "unknown",
      summary: { unchanged: 0, unknown: 1 },
    });
  }
};

cliTest(
  "compares fully observed roots without inventing coverage gaps through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-artifact-coverage-");
    const leftPath = join(root, "left.plist");
    const rightPath = join(root, "right.plist");
    await Promise.all([
      writeFile(leftPath, plist("hello")),
      writeFile(rightPath, plist("hello")),
    ]);
    const leftResult = await cli.run({
      arguments: ["inspect-artifact", leftPath, "--json"],
    });
    expect(leftResult.exitCode, leftResult.stderr).toBe(0);
    const left = inventoryEvidence(leftResult.json);
    const { call } = await connectLocalToolsMcp();
    const inspect = async (path: string) => {
      const opened = await call("open_binary", { path });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const result = await call("inspect_artifact", {});
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return inventoryEvidence(result.structuredContent);
    };
    const compare = async (left: Evidence, right: Evidence) => {
      const result = await call("compare_artifacts", { left, right });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return parseEvidence(result.structuredContent);
    };
    const right = await inspect(rightPath);
    const inventory = artifactInventoryResultSchema.parse(
      right.normalized_result,
    );
    expect(inventory.coverage).toEqual({ scope: "root", status: "complete" });
    expect(inventory.manifest).toMatchObject({
      root_format: "plist",
      node_count: 1,
      occurrence_count: 1,
      edge_count: 0,
    });
    expect(inventory.limitations).toEqual([
      "Artifact has no child container entries.",
    ]);
    const equal = await compare(left, right);
    expect(equal.normalized_result).toMatchObject({
      status: "unchanged",
      summary: { unchanged: 1, unknown: 0 },
      changes: [],
      limitations: [
        "Left: Artifact has no child container entries.",
        "Right: Artifact has no child container entries.",
      ],
    });
    const behavior = await call("find_changed_behavior", {
      comparisons: [equal],
    });
    expect(behavior.isError, JSON.stringify(behavior)).not.toBe(true);
    expect(behavior.structuredContent).toMatchObject({
      normalized_result: {
        behavior_status: "unknown",
        summary: { unresolved: 0 },
        findings: { items: [] },
        limitations: expect.arrayContaining([
          "No process comparison Evidence was supplied.",
        ]),
      },
    });
    const unknowns = await call("list_unknowns", {
      domain: "artifact-comparison",
    });
    expect(unknowns.isError, JSON.stringify(unknowns)).not.toBe(true);
    expect(unknowns.structuredContent).toMatchObject({
      result: { items: [], total: 0 },
    });

    await writeFile(rightPath, plist("world"));
    const changed = await compare(left, await inspect(rightPath));
    expect(changed.normalized_result).toMatchObject({
      status: "changed",
      summary: { unchanged: 0, changed: 1, unknown: 0 },
      changes: [
        expect.objectContaining({ logical_path: ".", dimensions: ["content"] }),
      ],
    });

    const zipPaths = [join(root, "left.zip"), join(root, "right.zip")] as const;
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("same.txt", new TextReader("same"));
    const bytes = await writer.close();
    await Promise.all(zipPaths.map((path) => writeFile(path, bytes)));
    const zip = await compare(
      await inspect(zipPaths[0]),
      await inspect(zipPaths[1]),
    );
    expect(zip.normalized_result).toMatchObject({
      status: "unchanged",
      summary: { unchanged: 2, unknown: 0 },
      changes: [],
    });

    await assertCoverageControls({ left, right, inventory, compare });
  },
  30_000,
);

cliTest.skipIf(process.platform === "win32")(
  "preserves executable metadata changes for fully observed plist roots",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-artifact-mode-");
    const leftPath = join(root, "left.plist");
    const rightPath = join(root, "right.plist");
    await Promise.all([
      writeFile(leftPath, plist("hello")),
      writeFile(rightPath, plist("hello")),
    ]);
    await Promise.all([chmod(leftPath, 0o644), chmod(rightPath, 0o755)]);
    const result = await cli.run({
      arguments: ["inspect-artifact", leftPath, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const left = inventoryEvidence(result.json);
    const { call } = await connectLocalToolsMcp();
    const opened = await call("open_binary", { path: rightPath });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const inspected = await call("inspect_artifact", {});
    expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
    const right = inventoryEvidence(inspected.structuredContent);
    expect(right.subject?.digest.sha256).toBe(left.subject?.digest.sha256);
    const comparison = await call("compare_artifacts", { left, right });
    expect(comparison.isError, JSON.stringify(comparison)).not.toBe(true);
    expect(
      parseEvidence(comparison.structuredContent).normalized_result,
    ).toMatchObject({
      status: "changed",
      summary: { unchanged: 0, changed: 1, unknown: 0 },
      changes: [
        expect.objectContaining({
          logical_path: ".",
          dimensions: ["executable"],
        }),
      ],
    });
  },
  30_000,
);

cliTest.skipIf(process.platform === "win32")(
  "retains traversal uncertainty when a directory omits special filesystem entries",
  async ({ cli, processes }) => {
    const root = await createTestTempDirectory("rea-gap-");
    const leftPath = join(root, "l.app"),
      rightPath = join(root, "r.app");
    await Promise.all([mkdir(leftPath), mkdir(rightPath)]);
    await Promise.all([
      writeFile(join(leftPath, "same.txt"), "same"),
      writeFile(join(rightPath, "same.txt"), "same"),
    ]);
    await Promise.all(
      [leftPath, rightPath].flatMap((path) => [
        writeFile(
          join(path, "Info.plist"),
          "<plist><dict><key>CFBundleExecutable</key><string>main.js</string></dict></plist>",
        ),
        writeFile(join(path, "main.js"), "export const value = 1;"),
      ]),
    );
    const fifo = await processes.run("mkfifo", [join(leftPath, "p")]);
    expect(fifo.exitCode, fifo.stderr).toBe(0);
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(join(leftPath, "s"), resolve);
    });
    try {
      const { left, right, call } = await inspectPair(cli, leftPath, rightPath);
      const inventory = artifactInventoryResultSchema.parse(
        left.normalized_result,
      );
      expect(inventory.coverage).toEqual({
        scope: "container-entries",
        status: "unknown",
      });
      expect(inventory.limitations).toEqual(
        expect.arrayContaining([
          'Artifact traversal omitted fifo at "p".',
          'Artifact traversal omitted socket at "s".',
        ]),
      );
      const compared = await call("compare_artifacts", { left, right });
      expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
      expect(
        parseEvidence(compared.structuredContent).normalized_result,
      ).toMatchObject({ status: "unknown", summary: { unchanged: 0 } });
    } finally {
      await new Promise<void>((resolve, reject) =>
        socket.close((cause) =>
          cause === undefined ? resolve() : reject(cause),
        ),
      );
    }
  },
  30_000,
);

cliTest(
  "compares fully traversed case-distinct ZIP entries while retaining materialization limits",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-case-coverage-");
    const leftPath = join(root, "left.zip"),
      rightPath = join(root, "right.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("A", new TextReader("upper"));
    await writer.add("a", new TextReader("lower"));
    const bytes = await writer.close();
    await Promise.all([
      writeFile(leftPath, bytes),
      writeFile(rightPath, bytes),
    ]);
    const { left, right, call } = await inspectPair(cli, leftPath, rightPath);
    const inventory = artifactInventoryResultSchema.parse(
      left.normalized_result,
    );
    expect(inventory.coverage).toEqual({
      scope: "container-entries",
      status: "complete",
    });
    expect(
      inventory.occurrences.map(({ logical_path }) => logical_path).sort(),
    ).toEqual([".", "A", "a"]);
    const compared = await call("compare_artifacts", { left, right });
    expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
    expect(
      parseEvidence(compared.structuredContent).normalized_result,
    ).toMatchObject({
      status: "unchanged",
      summary: { unchanged: 3, unknown: 0 },
      changes: [],
      limitations: expect.arrayContaining([
        expect.stringContaining("case-insensitive destination"),
      ]),
    });
  },
  30_000,
);

cliTest(
  "keeps unreadable encrypted ZIP content unknown with complete traversal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-encrypted-comparison-");
    const leftPath = join(root, "left.zip");
    const rightPath = join(root, "right.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("secret.txt", new TextReader("secret bytes"), {
      password: "fixture-password",
    });
    const bytes = await writer.close();
    await Promise.all([
      writeFile(leftPath, bytes),
      writeFile(rightPath, bytes),
    ]);
    const { left, right, call } = await inspectPair(cli, leftPath, rightPath);
    for (const evidence of [left, right])
      expect(
        artifactInventoryResultSchema.parse(evidence.normalized_result),
      ).toMatchObject({
        coverage: { scope: "container-entries", status: "complete" },
        occurrences: expect.arrayContaining([
          expect.objectContaining({
            logical_path: "secret.txt",
            hash_status: "unavailable",
            encrypted: true,
          }),
        ]),
      });
    const compared = await call("compare_artifacts", { left, right });
    expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
    const result = parseEvidence(compared.structuredContent).normalized_result;
    expect(result).toMatchObject({
      status: "unknown",
      summary: { unknown: expect.any(Number) },
    });
    expect(result).toHaveProperty("summary.unknown", 1);
  },
);
