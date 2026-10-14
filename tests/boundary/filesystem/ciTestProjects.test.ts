import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  BUILT_TEST_PROJECTS,
  SOURCE_TEST_PROJECTS,
  projectForTest,
} from "../../../scripts/lib/test-projects.mjs";
import {
  developmentTestPlan,
  parseDevelopmentTestRequest,
} from "../../../scripts/lib/development-tests.mjs";

const repository = process.cwd();

describe("canonical test-project ownership", () => {
  it("assigns every tracked test file exactly once to source or built", () => {
    const files = execFileSync("git", ["ls-files", "*.test.ts"], {
      cwd: repository,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    const grouped = new Map<string, string[]>();
    for (const file of files) {
      const project = projectForTest(file);
      grouped.set(project.group, [...(grouped.get(project.group) ?? []), file]);
    }

    expect(grouped.get("source")).not.toBeUndefined();
    expect(grouped.get("built")).not.toBeUndefined();
    expect(
      (grouped.get("source")?.length ?? 0) +
        (grouped.get("built")?.length ?? 0),
    ).toBe(files.length);
    expect(
      SOURCE_TEST_PROJECTS.reduce(
        (count, project) => count + project.include.length,
        0,
      ),
    ).toBeGreaterThan(0);
    expect(
      BUILT_TEST_PROJECTS.every((project) => project.group === "built"),
    ).toBe(true);
    expect(() => projectForTest("tests/unowned/example.test.ts")).toThrow(
      "No test project owns",
    );
  });

  it("owns the Hopper real-provider conformance test as built and requires preparation", () => {
    const testPath =
      "tests/conformance/providers/hopper/realHopperSearch.test.ts";
    expect(projectForTest(testPath)).toMatchObject({
      name: "boundary",
      group: "built",
    });
    expect(() => parseDevelopmentTestRequest("local", [testPath])).toThrow(
      `Use test:focused for built test projects: ${testPath}`,
    );
    const request = parseDevelopmentTestRequest("focused", [testPath]);
    expect(developmentTestPlan(request)).toMatchObject({ needsBuild: true });
  });

  it("uses canonical selectors in Vitest while retaining independent runner policy", async () => {
    const config = await readFile(join(repository, "vitest.config.ts"), "utf8");
    expect(config).toContain(
      "[...SOURCE_TEST_PROJECTS, ...BUILT_TEST_PROJECTS]",
    );
    expect(config).toContain("PROJECT_POLICIES");
    expect(config).not.toContain('"src/{contracts,domain}/**/*.test.ts"');
  });
});
