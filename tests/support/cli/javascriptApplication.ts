import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import type { TestCli } from "./cliFixture.js";

/** Analyze a directory through a public adapter and validate its result contract. */
export const analyzeJavaScriptDirectory = async (
  surface: "CLI" | "stdio MCP",
  cli: TestCli,
  root: string,
) => {
  let document: unknown;
  if (surface === "CLI") {
    const response = await cli.run({
      arguments: ["analyze-javascript-application", root, "--format", "json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(response.exitCode, response.stderr).toBe(0);
    document = response.json;
  } else {
    const { call } = await connectLocalToolsMcp();
    const response = await call("analyze_javascript_application", {
      input_path: root,
      format: "directory",
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    document = response.structuredContent;
  }
  return z
    .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
    .parse(document).normalized_result;
};
