import { readFile } from "node:fs/promises";

import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

import {
  agentEvaluationPassed,
  summarizeFactualCorrectness,
} from "../../../src/evaluation/AgentEvaluationReport.js";

const routingSuccess = {
  exitCode: 0,
  naturalUse: true,
  correctFirstTool: true,
  repeatedCallCount: 0,
  inputValidationFailureCount: 0,
  requiredToolSubsequenceMet: true,
  inputTokens: 100,
  answerHeuristicsMet: true,
  epistemicCuePresent: true,
};

describe("agent evaluation release gate", () => {
  it("rejects incorrect fixture claims even when every text heuristic passes", async () => {
    const predicate = await runnerFailurePredicate();
    expect(
      predicate({
        exitCode: 0,
        naturalUse: true,
        correctFirstTool: true,
        repeatedCallCount: 0,
        inputValidationFailureCount: 0,
        requiredToolSubsequenceMet: true,
        inputTokens: 100,
        answerHeuristicsMet: true,
        epistemicCuePresent: true,
        factualCorrectness: "failed",
      }),
    ).toBe(true);
  });
});

async function runnerFailurePredicate(): Promise<(item: unknown) => unknown> {
  const source = await readFile("scripts/verify-agent-experience.mjs", "utf8");
  const program = parse(source, { sourceType: "module" }).program;
  for (const top of program.body) {
    if (top.type !== "TryStatement") continue;
    for (const statement of top.block.body) {
      if (statement.type !== "VariableDeclaration") continue;
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type !== "Identifier" ||
          declaration.id.name !== "failed"
        )
          continue;
        const initializer = declaration.init;
        if (initializer?.type !== "CallExpression") continue;
        const argument = initializer.arguments[0];
        if (
          argument?.type !== "ArrowFunctionExpression" ||
          typeof argument.start !== "number" ||
          typeof argument.end !== "number"
        )
          continue;
        const factory = new Function(
          "agentEvaluationPassed",
          `return (${source.slice(argument.start, argument.end)});`,
        );
        const result: unknown = factory(agentEvaluationPassed);
        if (typeof result !== "function")
          throw new Error("Runner gate is not callable");
        return (item) => result(item);
      }
    }
  }
  throw new Error("Runner failure gate missing");
}

describe("scoped factual report", () => {
  it("requires a validated target clarification and zero REA calls for the negative route", () => {
    const clarification = {
      ...routingSuccess,
      expectedFirstTool: null,
      naturalUse: false,
      factualCorrectness: "not_assessed" as const,
      answerHeuristicsMet: false,
      epistemicCuePresent: false,
      targetClarificationPassed: true,
    };
    expect(agentEvaluationPassed(clarification)).toBe(true);
    for (const change of [
      { naturalUse: true },
      { correctFirstTool: false },
      { targetClarificationPassed: false },
      { exitCode: 1 },
      { inputTokens: 0 },
    ])
      expect(agentEvaluationPassed({ ...clarification, ...change })).toBe(
        false,
      );
  });

  it("accepts correct structured facts without superficial prose cues", () => {
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        answerHeuristicsMet: false,
        epistemicCuePresent: false,
        factualCorrectness: "passed",
      }),
    ).toBe(true);
  });

  it("retains workflow and execution checks for factually correct answers", () => {
    for (const change of [
      { exitCode: 1 },
      { naturalUse: false },
      { correctFirstTool: false },
      { repeatedCallCount: 1 },
      { inputValidationFailureCount: 1 },
      { requiredToolSubsequenceMet: false },
      { inputTokens: 0 },
    ])
      expect(
        agentEvaluationPassed({
          ...routingSuccess,
          factualCorrectness: "passed",
          ...change,
        }),
      ).toBe(false);
  });

  it("retains heuristic checks only for unassessed scenarios", () => {
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "not_assessed",
      }),
    ).toBe(true);
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "not_assessed",
        answerHeuristicsMet: false,
      }),
    ).toBe(false);
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "not_assessed",
        epistemicCuePresent: false,
      }),
    ).toBe(false);
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "failed",
      }),
    ).toBe(false);
  });

  it("reports assessed failures separately from unassessed scenarios", () => {
    expect(
      summarizeFactualCorrectness([
        { factualCorrectness: "passed" },
        { factualCorrectness: "failed" },
        { factualCorrectness: "not_assessed" },
      ]),
    ).toEqual({
      status: "failed",
      scope: "configured_fixture_claims",
      counts: { assessed: 2, passed: 1, failed: 1, notAssessed: 1 },
    });
    expect(
      summarizeFactualCorrectness([
        { factualCorrectness: "passed" },
        { factualCorrectness: "not_assessed" },
      ]).status,
    ).toBe("passed");
    expect(
      summarizeFactualCorrectness([{ factualCorrectness: "not_assessed" }])
        .status,
    ).toBe("not_assessed");
    expect(summarizeFactualCorrectness([]).status).toBe("not_assessed");
  });
});
