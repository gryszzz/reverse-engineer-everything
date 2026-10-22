import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EDITION, formatEdition } from "./edition.mjs";

const cli = fileURLToPath(new URL("../ree.mjs", import.meta.url));

test("the edition record allows MIT sale and does not lock the pipeline", () => {
  assert.equal(EDITION.license, "MIT");
  assert.equal(EDITION.sale_permitted_by_license, true);
  assert.equal(EDITION.payment_implemented, false);
  assert.equal(EDITION.editions[1].commands.includes("rebuild"), true);
  assert.match(formatEdition(false), /no license key/);
  assert.match(formatEdition(false), /ree serve is not a command/);
});

test("node ree.mjs edition prints the same boundary", () => {
  const run = spawnSync(process.execPath, [cli, "edition"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /MIT/);
  assert.match(run.stdout, /not sold separately yet/);
  const json = spawnSync(process.execPath, [cli, "edition", "--json"], {
    encoding: "utf8",
  });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).payment_implemented, false);
});
