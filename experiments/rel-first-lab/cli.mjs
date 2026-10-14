import { NOTES } from "./notes.mjs";
import { searchNotes } from "./search.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log("Usage: node experiments/rel-first-lab/cli.mjs SEARCH TERMS");
} else if (args.length === 0) {
  console.error("Provide search terms. Run with --help for usage.");
  process.exitCode = 2;
} else {
  const results = searchNotes(NOTES, args.join(" "));
  if (results.length === 0) console.log("No matching notes.");
  for (const note of results) {
    console.log(`${note.id} | ${note.title} | ${note.tags.join(", ")}`);
  }
}
