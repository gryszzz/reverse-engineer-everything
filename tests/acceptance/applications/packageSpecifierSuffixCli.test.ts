import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

type PackageSpecifierCase = {
  readonly specifier: string;
  readonly target: string | null;
  readonly status: "resolved" | "external" | "rejected" | "not-found";
  readonly value: string | number | null;
  readonly error: string | null;
};

const requests = [
  {
    specifier: "rea-self-fixture",
    target: "root.cjs",
    status: "resolved",
    value: 11,
    error: null,
  },
  {
    specifier: "rea-self-fixture/feature",
    target: "feature.cjs",
    status: "resolved",
    value: 22,
    error: null,
  },
  {
    specifier: "rea-self-fixture/feature?cache=1",
    target: "punctuated.cjs",
    status: "resolved",
    value: 33,
    error: null,
  },
  {
    specifier: "rea-self-fixture/feature?cache=2",
    target: null,
    status: "external",
    value: null,
    error: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  },
  {
    specifier: "rea-self-fixture/feature#entry",
    target: null,
    status: "external",
    value: null,
    error: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  },
  {
    specifier: "fixture/feature?cache=1",
    target: null,
    status: "external",
    value: null,
    error: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  },
  {
    specifier: "fixture/feature#entry",
    target: null,
    status: "external",
    value: null,
    error: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  },
  {
    specifier: "fixture/literal?cache=1",
    target: "node_modules/fixture/literal.cjs",
    status: "resolved",
    value: "literal",
    error: null,
  },
  {
    specifier: "legacy/?cache=1",
    target: null,
    status: "rejected",
    value: null,
    error: "ERR_UNSUPPORTED_DIR_IMPORT",
  },
  {
    specifier: "legacy/#entry",
    target: null,
    status: "rejected",
    value: null,
    error: "ERR_UNSUPPORTED_DIR_IMPORT",
  },
  {
    specifier: "legacy/nested/?cache=1",
    target: null,
    status: "rejected",
    value: null,
    error: "ERR_UNSUPPORTED_DIR_IMPORT",
  },
  {
    specifier: "legacy/nested/#entry",
    target: null,
    status: "rejected",
    value: null,
    error: "ERR_UNSUPPORTED_DIR_IMPORT",
  },
  {
    specifier: "legacy/feature.js",
    target: "node_modules/legacy/feature.js",
    status: "resolved",
    value: "legacy feature",
    error: null,
  },
  {
    specifier: "legacy/feature.js?cache=1",
    target: "node_modules/legacy/feature.js",
    status: "resolved",
    value: "legacy feature",
    error: null,
  },
  {
    specifier: "legacy/feature.js#entry",
    target: "node_modules/legacy/feature.js",
    status: "resolved",
    value: "legacy feature",
    error: null,
  },
  {
    specifier: "legacy/with%20space.js?cache=1",
    target: "node_modules/legacy/with space.js",
    status: "resolved",
    value: "legacy spaced feature",
    error: null,
  },
  {
    specifier: "legacy/feature",
    target: null,
    status: "not-found",
    value: null,
    error: "ERR_MODULE_NOT_FOUND",
  },
] satisfies readonly PackageSpecifierCase[];

const createPackageSpecifierFixture = async (): Promise<{
  readonly root: string;
  readonly source: string;
}> => {
  const root = await createTestTempDirectory("rea-package-specifier-suffix-");
  const packagePath = join(root, "node_modules", "fixture");
  const legacyPackagePath = join(root, "node_modules", "legacy");
  await Promise.all([
    mkdir(packagePath, { recursive: true }),
    mkdir(join(legacyPackagePath, "nested"), { recursive: true }),
  ]);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "rea-self-fixture",
      exports: {
        ".": { import: "./root.cjs", require: "./require.cjs" },
        "./feature": { import: "./feature.cjs", require: "./require.cjs" },
        "./feature?cache=1": {
          import: "./punctuated.cjs",
          require: "./require.cjs",
        },
      },
    }),
  );
  const source = requests
    .map(
      ({ specifier }, index) =>
        `import value${index} from ${JSON.stringify(specifier)};`,
    )
    .join("\n");
  await Promise.all([
    writeFile(join(root, "main.mjs"), source),
    writeFile(join(root, "root.cjs"), "module.exports = 11;"),
    writeFile(join(root, "feature.cjs"), "module.exports = 22;"),
    writeFile(join(root, "punctuated.cjs"), "module.exports = 33;"),
    writeFile(join(root, "require.cjs"), "module.exports = -1;"),
  ]);
  await writeFile(
    join(packagePath, "package.json"),
    JSON.stringify({
      exports: {
        "./feature": "./feature.cjs",
        "./literal?cache=1": "./literal.cjs",
      },
    }),
  );
  await Promise.all([
    writeFile(join(packagePath, "feature.cjs"), 'module.exports = "feature";'),
    writeFile(join(packagePath, "literal.cjs"), 'module.exports = "literal";'),
    writeFile(
      join(legacyPackagePath, "package.json"),
      JSON.stringify({ name: "legacy", main: "./main.cjs" }),
    ),
    writeFile(
      join(legacyPackagePath, "main.cjs"),
      'module.exports = "legacy root";',
    ),
    writeFile(
      join(legacyPackagePath, "feature.js"),
      'module.exports = "legacy feature";',
    ),
    writeFile(
      join(legacyPackagePath, "with space.js"),
      'module.exports = "legacy spaced feature";',
    ),
    writeFile(
      join(legacyPackagePath, "nested", "package.json"),
      JSON.stringify({ main: "./main.cjs" }),
    ),
    writeFile(
      join(legacyPackagePath, "nested", "main.cjs"),
      'module.exports = "legacy nested";',
    ),
  ]);
  return { root, source };
};

cliTest.for(["CLI", "stdio MCP"] as const)(
  "resolves package self references and suffix keys through %s",
  async (surface, { cli }) => {
    const { root, source } = await createPackageSpecifierFixture();
    if (surface === "CLI") {
      const native = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const requests = ${JSON.stringify(requests.map(({ specifier }) => specifier))};
          const results = await Promise.all(requests.map(async (specifier) => {
            try {
              const result = await import(specifier);
              return { value: result.default, error: null };
            } catch (error) {
              return { value: null, error: error.code };
            }
          }));
          console.log(JSON.stringify(results));`,
        ],
        { cwd: root, timeout: 5_000 },
      );
      expect(JSON.parse(native.stdout)).toEqual(
        requests.map(({ value, error }) => ({ value, error })),
      );
    }

    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    for (const { specifier, target, status } of requests)
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            module_link_kind: "import",
            specifier,
            resolved_path: target,
            resolution_status: status,
          }),
          evidence: expect.objectContaining({
            ...(specifier === "legacy/feature"
              ? {
                  limitations: expect.arrayContaining([
                    "The selected package ESM subpath target node_modules/legacy/feature does not exist in the inventoried artifact container; ESM subpath targets are exact files, so no extension or directory index was tried.",
                  ]),
                }
              : {}),
            artifact: expect.objectContaining({
              sha256: createHash("sha256").update(source).digest("hex"),
            }),
            location: expect.objectContaining({
              value: expect.objectContaining({ source: "main.mjs" }),
            }),
          }),
        }),
      );
  },
);
