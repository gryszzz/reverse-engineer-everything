import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectGaps, GAPS_TITLE } from "./report.mjs";

function write(dir, name, value) {
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n");
}

test("gaps list left-out builds, skipped reads, and standing limits", () => {
  const dir = mkdtempSync(join(tmpdir(), "ree-gaps-"));
  try {
    write(dir, "provenance.json", {
      left_out: [
        { id: "feature:nested", reason: "path template is not expanded" },
      ],
      generator_limits: ["GraphQL operations are not built."],
    });
    write(dir, "capabilities.json", {
      capabilities: [
        { id: "storage", status: "implemented", reason: "sqlite" },
        {
          id: "pricing",
          status: "left-out",
          reason: "The spec has no pricing plan.",
        },
      ],
    });
    write(dir, "read.json", {
      skipped: [
        {
          target: "https://owned.docs/private",
          reason: "robots.txt disallows that page.",
        },
        { target: "Northwind Sample secret", reason: "kept out" },
      ],
    });
    const report = collectGaps({
      projectDir: dir,
      forbidden: ["Northwind Sample"],
    });
    assert.equal(report.title, GAPS_TITLE);
    assert.match(report.note, /not a percentage/);
    const text = report.items.map((item) => item.text).join("\n");
    assert.match(text, /feature:nested: path template is not expanded/);
    assert.match(text, /pricing: The spec has no pricing plan/);
    assert.match(text, /Skipped https:\/\/owned\.docs\/private/);
    assert.match(text, /robots\.txt disallows/);
    assert.equal(text.includes("Northwind Sample"), false);
    assert.match(text, /One gap was omitted/);
    assert.match(text, /more than one \{name\} segment/);
    assert.match(text, /Login bypass and protection bypass are not attempted/);
    assert.equal(
      report.items.some((item) => item.text.includes("sqlite")),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a product without reports says those lists are absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ree-gaps-empty-"));
  try {
    const report = collectGaps({ projectDir: dir });
    const text = report.items.map((item) => item.text).join("\n");
    assert.match(text, /No capability report was saved/);
    assert.match(text, /No read report was saved/);
    assert.match(text, /Java providers are not run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
