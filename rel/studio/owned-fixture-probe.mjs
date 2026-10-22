#!/usr/bin/env node
/**
 * Bounded runtime probe for the repository-owned first lab only.
 * It imports that fixture's search module and prints the ranked ids.
 * It does not accept a caller-supplied program, path outside the fixture, or environment.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OWNED = realpathSync(
  fileURLToPath(new URL("../../experiments/rel-first-lab/", import.meta.url)),
);
const QUERIES = new Set(["bridge", "signal", "observability", "missing"]);

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--"))
    return null;
  return args[index + 1];
}

const args = process.argv.slice(2);
const fixtureArg = option(args, "--fixture");
const query = option(args, "--query");

if (!fixtureArg || !query) {
  process.stderr.write(
    "Usage: owned-fixture-probe.mjs --fixture OWNED_LAB --query QUERY\n",
  );
  process.exitCode = 2;
} else if (!QUERIES.has(query)) {
  process.stderr.write("Query is not in the owned-lab allowlist.\n");
  process.exitCode = 2;
} else {
  let fixture = null;
  try {
    fixture = realpathSync(fixtureArg);
  } catch {
    process.stderr.write("Owned fixture path could not be resolved.\n");
    process.exitCode = 2;
  }
  if (process.exitCode === undefined && fixture !== OWNED) {
    process.stderr.write(
      "This probe refuses every target except experiments/rel-first-lab.\n",
    );
    process.exitCode = 2;
  }
  if (process.exitCode === undefined) {
    const { NOTES } = await import(
      pathToFileURL(join(OWNED, "notes.mjs")).href
    );
    const { searchNotes } = await import(
      pathToFileURL(join(OWNED, "search.mjs")).href
    );
    const ids = searchNotes(NOTES, query).map((note) => note.id);
    process.stdout.write(
      `${JSON.stringify({
        fixture: OWNED,
        query,
        ids,
        source: "experiments/rel-first-lab/search.mjs",
      })}\n`,
    );
  }
}
