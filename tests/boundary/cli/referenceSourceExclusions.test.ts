import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { historicalSourceGraphSchema } from "../../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

describe.skipIf(process.platform === "win32")(
  "compiled reference-source exclusion provenance",
  () => {
    cliTest(
      "reports project, default, and explicit secret exclusions",
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-reference-exclusions-");
        const logs = join(root, "logs");
        await mkdir(logs);
        await Promise.all([
          writeFile(join(root, ".gitignore"), "project.tmp\n"),
          writeFile(join(root, "project.tmp"), "project policy\n"),
          writeFile(join(logs, "application.log"), "default policy\n"),
          writeFile(join(root, "private.txt"), "sensitive local file\n"),
          writeFile(join(root, "source.ts"), "export const value = 1;\n"),
        ]);

        const result = await cli.run({
          arguments: ["import-reference-source", root, "--json"],
          cwd: root,
          environment: {
            HOME: root,
            USERPROFILE: root,
            XDG_CONFIG_HOME: root,
            XDG_CACHE_HOME: root,
            REA_REFERENCE_SECRET_PATTERNS_JSON: '["private.txt"]',
          },
        });

        expect(result.exitCode).toBe(0);
        const graph = historicalSourceGraphSchema.parse(result.json);
        expect(graph.exclusions).toEqual(
          expect.arrayContaining([
            {
              path: "project.tmp",
              reason: "project-ignored",
              pattern: "project.tmp",
            },
            {
              path: "logs/application.log",
              reason: "default-ignored",
              pattern: "*.log",
            },
            {
              path: "private.txt",
              reason: "configured-secret",
              pattern: "private.txt",
            },
          ]),
        );
        expect(graph.entries).toContainEqual(
          expect.objectContaining({ path: "source.ts", kind: "file" }),
        );
      },
    );
  },
);
