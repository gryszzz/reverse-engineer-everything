import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createRustImage } from "../fixtures/rust/image.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "reports cargo-auditable packages through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-");
    const path = join(root, "sample");
    await writeFile(path, createRustImage({ format: "macho" }));
    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.auditable_metadata).toMatchObject({
      section_name: "__DATA,.dep-v0",
      format_version: 1,
      root_package_index: 1,
      packages: [
        { name: "itoa", version: "1.0.18" },
        { name: "sample", version: "0.1.0", root: true },
      ],
    });
  },
);

cliTest("returns null metadata when .dep-v0 is absent", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-rust-cli-missing-");
  const path = join(root, "plain");
  await writeFile(path, createRustImage({ format: "elf", omitSection: true }));
  const result = await cli.run({
    arguments: ["inspect-rust-binary", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
    result.json,
  );
  expect(evidence.normalized_result.auditable_metadata).toBeNull();
  expect(evidence.normalized_result.limitations.join("\n")).toContain(
    "does not mean the binary has no dependencies",
  );
});

cliTest("reports malformed zlib as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-rust-cli-zlib-");
  const path = join(root, "broken.elf");
  await writeFile(
    path,
    createRustImage({
      format: "elf",
      payload: deflateSync(Buffer.from("{")),
      includeRustc: false,
    }),
  );
  const result = await cli.run({
    arguments: ["inspect-rust-binary", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_rust_binary" },
  });
});
