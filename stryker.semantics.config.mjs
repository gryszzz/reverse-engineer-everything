import { mutationRanges } from "./scripts/lib/reverse-tools-mutation-targets.mjs";

const config = {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  testRunner: "command",
  commandRunner: {
    command: "npx vitest run --config vitest.reverse-tools-semantics.config.ts",
  },
  plugins: ["@stryker-mutator/typescript-checker"],
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.reverse-tools-mutation.json",
  typescriptChecker: {
    prioritizePerformanceOverAccuracy: true,
  },
  coverageAnalysis: "off",
  thresholds: { break: null },
  ignorePatterns: ["/.cache/rea-command-locks/**", "/coverage/**"],
  concurrency: 2,
  timeoutMS: 30000,
  reporters: ["clear-text", "progress", "html", "json"],
};

export default {
  ...config,
  mutate: [
    ...mutationRanges("src/cutter/CutterBridgeClient.ts", [
      {
        kind: "expression",
        text: "status.data.current_file === undefined",
      },
      {
        kind: "expression",
        text: "response.current_file === undefined",
      },
    ]),
    ...mutationRanges("src/rizin/RizinDebugSessionManager.ts", [
      {
        kind: "declaration",
        name: "isRizinCommandDeadlineExpired",
      },
      {
        kind: "declaration",
        name: "createRizinCommandTimeoutError",
      },
      {
        kind: "declaration",
        name: "createRizinCommandTimeoutEvidence",
      },
    ]),
  ],
};
