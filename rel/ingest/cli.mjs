import { ingestPublicDocs, IngestError } from "./docs.mjs";
import { OutsideInError } from "../outside-in/errors.mjs";

const HELP = [
  "REE ingest-docs — a cited behavior spec from public docs.",
  "",
  "node ree.mjs ingest-docs <url-or-dir> --out DIR [--name NAME] [--json]",
  "",
  "A directory of OpenAPI, Swagger, HTML, or Markdown is read locally.",
  "No network request is made. A URL is one public http(s) document.",
  "robots.txt is fetched and obeyed. Requests are rate-limited.",
  "There is no login, no cookie, and no Authorization header.",
  "The URL is not crawled. --out must sit outside this repository.",
  "",
  "Writes behavior-spec.json, OUTSIDE_IN_REPORT.md, and ingest.json.",
  "ingest.json lists endpoints' resource paths, features, and pricing tiers.",
  "Exit 0 when a spec is produced. Exit 3 when every document is refused.",
  "Exit 2 for usage errors. The spec is still written on exit 3.",
].join("\n");

export async function runIngestDocsCommand(argv) {
  let settings;
  try {
    settings = parseArgs(argv);
  } catch (error) {
    console.error("REE: " + error.message);
    return 2;
  }
  if (settings.help) {
    console.log(HELP);
    return 0;
  }
  try {
    const result = await ingestPublicDocs({
      input: settings.input,
      outDir: settings.out,
      name: settings.name,
    });
    if (settings.json) console.log(JSON.stringify(result.spec, null, 2));
    else console.log(formatSummary(result, settings.out));
    return result.exitCode;
  } catch (error) {
    if (error instanceof IngestError || error instanceof OutsideInError) {
      console.error("REE: " + error.message);
      return 2;
    }
    throw error;
  }
}

function formatSummary(result, out) {
  const spec = result.spec;
  const ingest = result.ingest;
  return [
    `Ingested behavior spec: ${spec.target.name}`,
    `Status: ${spec.status}`,
    `Source: ${ingest.source}`,
    `Network: ${ingest.network ? "yes" : "no"}`,
    `Features: ${spec.features.length}`,
    `Resources: ${ingest.resources.length}`,
    `API endpoints: ${spec.api.endpoints.length}`,
    `Pricing tiers: ${ingest.pricing_tiers.length}`,
    `Refusals: ${spec.refusals.length}`,
    `Spec: ${out}/behavior-spec.json`,
    `Report: ${out}/OUTSIDE_IN_REPORT.md`,
    `Ingest: ${out}/ingest.json`,
  ].join("\n");
}

export function parseArgs(argv) {
  const settings = {
    help: false,
    json: false,
    name: null,
    out: null,
    input: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") settings.help = true;
    else if (arg === "--json") settings.json = true;
    else if (arg === "--name") settings.name = needValue(argv, ++index, arg);
    else if (arg === "--out") settings.out = needValue(argv, ++index, arg);
    else if (arg.startsWith("-"))
      throw new IngestError("Unknown option: " + arg);
    else if (settings.input)
      throw new IngestError("Use ingest-docs <url-or-dir> --out DIR.");
    else settings.input = arg;
  }
  if (!settings.help && (!settings.input || !settings.out))
    throw new IngestError("Use ingest-docs <url-or-dir> --out DIR.");
  return settings;
}

function needValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--"))
    throw new IngestError(flag + " requires a value.");
  return value;
}
