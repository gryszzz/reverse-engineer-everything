import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  inventoryFirmwareOutput,
  readFirmwareReport,
} from "../../../src/firmware/FirmwareFiles.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  ["invalid leading byte", [0xff]],
  ["incomplete sequence", [0xe2, 0x82]],
  ["overlong sequence", [0xc0, 0xaf]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
])(
  "rejects complete JSON containing %s without repairing producer bytes",
  async (_name, bytes) => {
    const root = await createTestTempDirectory("rea-firmware-report-");
    const path = join(root, "report.json");
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from('{"description":"'),
        Buffer.from(bytes),
        Buffer.from('"}'),
      ]),
    );
    await expect(
      readFirmwareReport(path, "inspect_firmware_regions"),
    ).rejects.toMatchObject({
      _tag: "AnalysisOutputError",
      reason: "Tool report is not valid complete JSON",
    });
  },
);

it("preserves valid Unicode and a literal replacement character in producer JSON", async () => {
  const root = await createTestTempDirectory("rea-firmware-report-");
  const path = join(root, "report.json");
  const report = { description: "固件 🧩 \ufffd", path: "/输入/firmware.bin" };
  await writeFile(path, JSON.stringify(report));
  expect(await readFirmwareReport(path, "inspect_firmware_regions")).toEqual(
    report,
  );
});

it("orders extracted firmware paths by code point independently of host locale", async () => {
  const root = await createTestTempDirectory("rea-firmware-inventory-");
  await mkdir(join(root, "Lib"));
  for (const path of ["a.bin", "z.bin", "\u00e4.bin", "B.bin", "Lib/x.bin"])
    await writeFile(join(root, path), "");
  const entries = await inventoryFirmwareOutput(
    root,
    1024,
    16,
    "inspect_firmware_regions",
  );
  // Locale collation would interleave case and place "ä" by language rules.
  expect(entries.map(({ relativePath }) => relativePath)).toEqual([
    "B.bin",
    "Lib/x.bin",
    "a.bin",
    "z.bin",
    "\u00e4.bin",
  ]);
});
