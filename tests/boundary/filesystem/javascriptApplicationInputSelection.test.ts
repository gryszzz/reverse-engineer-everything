import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

const analyzeFailure = async (input: Record<string, unknown>) => {
  const result = await analyzeJavaScriptApplication(input);
  if (result.ok) throw new Error("Expected the selection to be refused");
  return projectAnalysisError(result.error);
};

const application = async () => {
  const root = await createTestTempDirectory("rea-javascript-selection-");
  const directory = join(root, "app");
  await mkdir(directory);
  await writeFile(join(directory, "index.js"), "module.exports = 1;\n");
  return { root, directory };
};

describe("JavaScript application input selection", () => {
  it("reports a missing input path as invalid input, not an artifact read failure", async () => {
    const { root } = await application();
    const missing = join(root, "missing");

    expect(await analyzeFailure({ input_path: missing })).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        issues: [
          {
            path: ["input_path"],
            reason: "invalid_value",
            message: expect.stringContaining(missing),
          },
        ],
      },
    });
  });

  it("reports a file that is neither a directory nor an .asar as an unsupported target", async () => {
    const { root } = await application();
    const binary = join(root, "program");
    await writeFile(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));

    expect(await analyzeFailure({ input_path: binary })).toMatchObject({
      code: "unsupported_target",
      category: "unsupported_target",
      remediation: { action: expect.stringContaining(".asar") },
      details: {
        operation: "analyze_javascript_application",
        path: binary,
      },
    });
  });

  it.each([
    ["a directory", "directory", "asar"],
    ["an .asar file", "asar", "directory"],
  ] as const)(
    "reports %s selected with a contradicting format as an invalid request",
    async (_label, observed, format) => {
      const { root, directory } = await application();
      const selected =
        observed === "directory" ? directory : join(root, "app.asar");
      if (observed === "asar") await writeFile(selected, "not inspected");

      expect(
        await analyzeFailure({ input_path: selected, format }),
      ).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["format"],
              reason: "invalid_value",
              expected: ["auto", observed],
            },
          ],
        },
      });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable selected directory as a host access denial",
    async () => {
      const { directory } = await application();
      await chmod(directory, 0o000);
      onTestFinished(() => chmod(directory, 0o700));

      expect(await analyzeFailure({ input_path: directory })).toMatchObject({
        code: "access_denied",
        details: { path: directory, system_code: "EACCES" },
      });
    },
  );
});
