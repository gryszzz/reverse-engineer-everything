import { OutsideInError } from "../outside-in/errors.mjs";
import { ReadError, readSource } from "./run.mjs";

const HELP = [
  "REE read — a cited behavior spec from a public or local input.",
  "",
  "node ree.mjs read INPUT --out DIR [--name NAME] [--authorized] [--json]",
  "",
  "INPUT is detected and routed:",
  "  a public http(s) URL, crawled one hop on the same origin",
  "  an OpenAPI, Swagger, Postman, GraphQL, HTML, or Markdown file",
  "  npm:name, an npmjs.com package URL, or a .tgz / .tar.gz tarball",
  "  a public github.com/owner/repo URL",
  "  a local project folder",
  "",
  "Public sources only. There is no login, no cookie, and no Authorization header.",
  "robots.txt is obeyed. Live requests wait at least one second per host.",
  "A website crawl follows docs, pricing, feature, changelog, and API links only.",
  "GitHub files are read only when the repository publishes an open-source license.",
  "npm tarball types are read only when a license is published.",
  "Implementation source and binaries are not copied.",
  "Declaration files contribute exported names only.",
  "--authorized runs static JavaScript analysis when the folder is JavaScript",
  "and the REA runtime is built. It does not run native, mobile, or firmware files.",
  "--out must sit outside this repository.",
  "",
  "Writes behavior-spec.json, OUTSIDE_IN_REPORT.md, and read.json.",
  "read.json lists each source, each skip and why, and counts.",
  "Those counts are not a percentage of the original product.",
  "Exit 0 when a spec is produced. Exit 3 when every document is refused.",
  "Exit 2 for usage errors. The spec is still written on exit 3.",
].join("\n");

export async function runReadCommand(argv) {
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
    const result = await readSource({
      input: settings.input,
      outDir: settings.out,
      name: settings.name,
      authorized: settings.authorized,
    });
    if (settings.json) console.log(JSON.stringify(result.read, null, 2));
    else console.log(formatSummary(result, settings.out));
    return result.exitCode;
  } catch (error) {
    if (error instanceof ReadError || error instanceof OutsideInError) {
      console.error("REE: " + error.message);
      return 2;
    }
    throw error;
  }
}

function formatSummary(result, out) {
  const spec = result.spec;
  const read = result.read;
  const lines = [
    `Read behavior spec: ${spec.target.name}`,
    `Detected: ${read.detected}`,
    `Status: ${spec.status}`,
    `Network: ${read.network ? "yes" : "no"}`,
    `Authorization: ${read.authorization}`,
    `Documents read: ${read.coverage.documents_read}`,
    `Documents skipped: ${read.coverage.documents_skipped}`,
    `Features: ${read.coverage.features}`,
    `API endpoints: ${read.coverage.endpoints}`,
    `Spec: ${out}/behavior-spec.json`,
    `Report: ${out}/OUTSIDE_IN_REPORT.md`,
    `Read: ${out}/read.json`,
  ];
  for (const item of read.skipped) {
    lines.push(`Skipped ${item.target}: ${item.reason}`);
  }
  lines.push(read.note);
  return lines.join("\n");
}

export function parseArgs(argv) {
  const settings = {
    help: false,
    json: false,
    authorized: false,
    name: null,
    out: null,
    input: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") settings.help = true;
    else if (arg === "--json") settings.json = true;
    else if (arg === "--authorized") settings.authorized = true;
    else if (arg === "--name") settings.name = needValue(argv, ++index, arg);
    else if (arg === "--out") settings.out = needValue(argv, ++index, arg);
    else if (arg.startsWith("-")) throw new ReadError("Unknown option: " + arg);
    else if (settings.input) throw new ReadError("Use read <input> --out DIR.");
    else settings.input = arg;
  }
  if (!settings.help && (!settings.input || !settings.out))
    throw new ReadError("Use read <input> --out DIR.");
  return settings;
}

function needValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--"))
    throw new ReadError(flag + " requires a value.");
  return value;
}
