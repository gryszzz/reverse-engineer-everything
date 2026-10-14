import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NOTES } from "./notes.mjs";
import { searchNotes } from "./search.mjs";

const ids = (query) => searchNotes(NOTES, query).map(({ id }) => id);
assert.deepEqual(ids("bridge"), ["N-102", "N-101", "N-104"]);
assert.deepEqual(ids(" BRIDGE "), ids("bridge"));
assert.deepEqual(ids("signal"), ["N-101", "N-105"]);
assert.deepEqual(ids("observability"), ["N-103"]);
assert.deepEqual(ids("missing"), []);
assert.deepEqual(ids("  "), []);
assert.deepEqual(
  NOTES.map(({ id }) => id),
  ["N-101", "N-102", "N-103", "N-104", "N-105"],
);

const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const ok = spawnSync(process.execPath, [cliPath, "bridge"], {
  encoding: "utf8",
  timeout: 5000,
});
assert.equal(ok.status, 0);
assert.match(ok.stdout, /^N-102 \| Bridge Patterns/m);

const noQuery = spawnSync(process.execPath, [cliPath], {
  encoding: "utf8",
  timeout: 5000,
});
assert.equal(noQuery.status, 2);
assert.match(noQuery.stderr, /Provide search terms/);

console.log("REE first lab: 11 checks passed.");
