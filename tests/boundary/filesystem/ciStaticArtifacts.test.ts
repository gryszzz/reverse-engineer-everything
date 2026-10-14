import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { parseStaticArchive } from "../../../scripts/ci/artifacts.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const producer = fileURLToPath(
  new URL("../../../scripts/ci/static-check-report.mjs", import.meta.url),
);

it.each([3.5, 100, 0])(
  "retains real lint failures when the duplication threshold is %s",
  async (threshold) => {
    const root = await createTestTempDirectory("rea-ci-static-archive-");
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(
      join(root, ".oxlintrc.json"),
      JSON.stringify({ rules: { "no-debugger": "error" } }),
    );
    await writeFile(
      join(root, ".jscpd.json"),
      JSON.stringify({ threshold, minLines: 5, minTokens: 50 }),
    );
    await writeFile(
      join(root, "src/example.ts"),
      "debugger;\nexport const example = true;\n",
    );
    const duplicate =
      "export function compute(value: number) {\n" +
      Array.from({ length: 20 }, (_, index) => `  value += ${index};\n`).join(
        "",
      ) +
      "  return value;\n}\n";
    for (const name of threshold === 3.5 ? [] : ["first", "second"])
      await writeFile(join(root, `src/${name}.ts`), duplicate);
    await expect(
      execute(process.execPath, [producer, "lint", "src/example.ts"], {
        cwd: root,
      }),
    ).rejects.toMatchObject({ code: 1 });
    const duplication = execute(process.execPath, [producer, "duplicates"], {
      cwd: root,
    });
    if (threshold === 0)
      await expect(duplication).rejects.toMatchObject({ code: 1 });
    else await duplication;
    const reports = join(root, ".cache/static-checks");
    expect(
      JSON.parse(
        await readFile(join(reports, "jscpd/jscpd-report.json"), "utf8"),
      ),
    ).toMatchObject({ reaCheck: { exitCode: threshold === 0 ? 1 : 0 } });
    await writeFile(
      join(reports, "static-task-context.json"),
      JSON.stringify({
        version: 1,
        sourceSha: "a".repeat(40),
        sourceClean: true,
        nodeVersion: process.version,
        npmVersion: "11.16.0",
        turboVersion: "2.11.7",
        platform: process.platform,
        architecture: process.arch,
        taskHashes: { "lint:built": "a".repeat(16), jscpd: "b".repeat(16) },
      }),
    );
    const archive = join(root, "reports.zip");
    await execute(
      "zip",
      [
        "-q",
        archive,
        "oxlint.json",
        "jscpd/jscpd-report.json",
        "static-task-context.json",
      ],
      { cwd: reports },
    );
    const evidence = await parseStaticArchive(archive);
    expect(evidence.diagnostics.filter(({ kind }) => kind === "lint")).toEqual([
      expect.objectContaining({
        kind: "lint",
        path: "src/example.ts",
        severity: "error",
      }),
    ]);
    const duplicates = evidence.diagnostics.filter(
      ({ kind }) => kind === "jscpd",
    );
    if (threshold === 0) expect(duplicates.length).toBeGreaterThan(0);
    else expect(duplicates).toEqual([]);
  },
);
