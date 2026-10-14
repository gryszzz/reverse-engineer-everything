import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runNode = (source: string, ...arguments_: string[]): string =>
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", source, ...arguments_],
    { cwd: root, encoding: "utf8" },
  );

describe("reverse-tools mutation configuration", () => {
  it("loads nonempty targets from both actual Stryker configs", () => {
    const result = runNode(
      `const [mainUrl, semanticsUrl] = process.argv.slice(1);
       const main = await import(mainUrl);
       const semantics = await import(semanticsUrl);
       process.stdout.write(JSON.stringify({
         main: main.default.mutate.length,
         semantics: semantics.default.mutate.length,
       }));`,
      pathToFileURL(join(root, "stryker.config.mjs")).href,
      pathToFileURL(join(root, "stryker.semantics.config.mjs")).href,
    );
    const targets = JSON.parse(result) as {
      main: number;
      semantics: number;
    };
    expect(targets.main).toBeGreaterThan(0);
    expect(targets.semantics).toBeGreaterThan(0);
  });

  it("fails closed when an owned mutation method is missing", async () => {
    const directory = await createTestTempDirectory("rea-mutation-selector-");
    const source = join(directory, "source.ts");
    await writeFile(source, "class Present { run() {} }\n");

    const result = runNode(
      `import { mutationRanges } from "./scripts/lib/reverse-tools-mutation-targets.mjs";
       const [source] = process.argv.slice(1);
       try {
         mutationRanges(source, [{ kind: "method", owner: "Missing", name: "run" }]);
         throw new Error("missing owner unexpectedly selected");
       } catch (error) {
         if (!(error instanceof Error) || !error.message.includes("found 0")) throw error;
         process.stdout.write(error.message);
       }`,
      source,
    );
    expect(result).toMatch(/found 0/u);
  });

  it("fails closed when an owned mutation method is ambiguous", async () => {
    const directory = await createTestTempDirectory("rea-mutation-selector-");
    const source = join(directory, "source.ts");
    await writeFile(source, "class Owner { run() {} run(value: string) {} }\n");

    const result = runNode(
      `import { mutationRanges } from "./scripts/lib/reverse-tools-mutation-targets.mjs";
       const [source] = process.argv.slice(1);
       try {
         mutationRanges(source, [{ kind: "method", owner: "Owner", name: "run" }]);
         throw new Error("ambiguous target unexpectedly selected");
       } catch (error) {
         if (!(error instanceof Error) || !error.message.includes("found 2")) throw error;
         process.stdout.write(error.message);
       }`,
      source,
    );
    expect(result).toMatch(/found 2/u);
  });
});
