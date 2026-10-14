import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

it("resolves require calls by lexical binding and source mode", async () => {
  const root = await createTestTempDirectory("rea-reference-require-scope-");
  const sources: Record<string, string> = {
    "parameter.cjs": [
      "function load(require) { return require('./throwing.cjs'); }",
      "console.log(load(() => 'local'));",
    ].join("\n"),
    "destructured.cjs": [
      "function load({ require }) { return require('./throwing.cjs'); }",
      "console.log(load({ require: () => 'local' }));",
    ].join("\n"),
    "hoisted.cjs": [
      "function load() {",
      "  console.log(require('./throwing.cjs'));",
      "  function require() { return 'local'; }",
      "}",
      "load();",
    ].join("\n"),
    "catch.cjs": [
      "try { throw () => 'local'; }",
      "catch (require) { console.log(require('./throwing.cjs')); }",
    ].join("\n"),
    "nested.cjs": [
      "console.log(require('./loaded.cjs'));",
      "function load(require) { return require('./throwing.cjs'); }",
      "console.log(load(() => 'local'));",
    ].join("\n"),
    "dynamic-with.cjs": [
      "with ({ require: () => 'local' }) {",
      "  console.log(require('./throwing.cjs'));",
      "}",
    ].join("\n"),
    "top-level-var.cjs": [
      "var require;",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "initialized-var.cjs": [
      "var require = () => 'local';",
      "console.log(require('./throwing.cjs'));",
    ].join("\n"),
    "assigned-var.cjs": [
      "require = () => 'local';",
      "console.log(require('./throwing.cjs'));",
    ].join("\n"),
    "unbound-esm.mjs": [
      "try { require('./throwing.cjs'); }",
      "catch (error) {",
      "  if (!(error instanceof ReferenceError)) throw error;",
      "  console.log('no-global-require');",
      "}",
    ].join("\n"),
    "shadowed-esm.mjs": [
      "const require = () => 'local';",
      "console.log(require('./throwing.cjs'));",
    ].join("\n"),
    "create-require-esm.mjs": [
      "import { createRequire as makeRequire } from 'node:module';",
      "const require = makeRequire(import.meta.url);",
      "console.log(require('./loaded.cjs'));",
    ].join("\n"),
    "loaded.cjs": "console.log('loaded');\nmodule.exports = 'real';\n",
    "throwing.cjs": "throw new Error('A shadowed require must not load me');\n",
  };

  await Promise.all(
    Object.entries(sources).map(([path, source]) =>
      writeFile(join(root, path), source),
    ),
  );

  const runNode = promisify(execFile);
  for (const [path, stdout] of [
    ["parameter.cjs", "local\n"],
    ["destructured.cjs", "local\n"],
    ["hoisted.cjs", "local\n"],
    ["catch.cjs", "local\n"],
    ["nested.cjs", "loaded\nreal\nlocal\n"],
    ["dynamic-with.cjs", "local\n"],
    ["top-level-var.cjs", "loaded\nreal\n"],
    ["initialized-var.cjs", "local\n"],
    ["assigned-var.cjs", "local\n"],
    ["unbound-esm.mjs", "no-global-require\n"],
    ["shadowed-esm.mjs", "local\n"],
    ["create-require-esm.mjs", "loaded\nreal\n"],
  ] as const) {
    const executed = await runNode(process.execPath, [join(root, path)], {
      cwd: root,
      timeout: 5_000,
    });
    expect(executed.stdout).toBe(stdout);
    expect(executed.stderr).toBe("");
  }

  const result = await importReferenceSource({
    root,
    caller: "reference-shadowed-require-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;

  expect(
    result.value.relationships
      .filter(({ kind }) => kind === "requires")
      .map(({ from_path, to }) => [from_path, to])
      .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? "")),
  ).toEqual([
    ["create-require-esm.mjs", "loaded.cjs"],
    ["nested.cjs", "loaded.cjs"],
    ["top-level-var.cjs", "loaded.cjs"],
  ]);
});
