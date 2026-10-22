import { readFileSync } from "node:fs";
import { analyzeOutsideIn } from "./analyze.mjs";
import { OutsideInError } from "./errors.mjs";

const HELP = [
  "REE outside-in — a clean-room behavior spec from public documents.",
  "",
  "node ree.mjs outside-in --name NAME --url URL [--url URL]",
  "    [--docs URL] [--pricing URL] [--changelog URL] [--reviews URL]",
  "    --out DIR [--json] [--cache DIR] [--summarizer none]",
  "",
  "node ree.mjs outside-in --request FILE --fixture DIR --out DIR --json",
  "",
  "The command fetches only the URLs you name, plus robots.txt for those",
  "origins. It does not log in, solve captchas, follow redirects, or fetch",
  "source or binaries. No model is called unless a programmatic caller passes",
  "a local summarizer. --summarizer remote is refused.",
  "",
  "Exit 0 when a spec is produced from at least one document.",
  "Exit 3 when every content URL is refused. The spec is still written.",
  "Exit 2 for usage errors and for a refused summarizer.",
].join("\n");

export async function runOutsideInCommand(argv) {
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
    const request = requestFrom(settings);
    const result = await analyzeOutsideIn(request);
    if (settings.json) console.log(JSON.stringify(result.spec, null, 2));
    else console.log(formatSummary(result, settings.out));
    return result.exitCode;
  } catch (error) {
    console.error("REE: " + error.message);
    return 2;
  }
}

function requestFrom(settings) {
  if (settings.request && (settings.name || settings.urls.length || settings.docs.length)) {
    throw new OutsideInError("Pass either --request or --name/--url inputs, not both.", "USAGE");
  }
  const base = settings.request
    ? JSON.parse(readFileSync(settings.request, "utf8"))
    : {
        target: { name: settings.name, urls: settings.urls },
        docs: settings.docs.map((url) => ({ url })),
        pricing_url: settings.pricing,
        changelog_url: settings.changelog,
        review_urls: settings.reviews,
      };
  if (!settings.request && !settings.name)
    throw new OutsideInError("Provide --name and --url, or --request FILE.", "USAGE");
  return {
    ...base,
    fixtureDir: settings.fixture,
    cacheDir: settings.cache,
    outDir: settings.out,
    summarizerChoice: settings.summarizer,
    minIntervalMs: settings.minIntervalMs,
    cacheMaxAgeMs: settings.cacheMaxAgeMs,
  };
}

function formatSummary(result, out) {
  const spec = result.spec;
  const lines = [
    `Outside-in behavior spec: ${spec.target.name}`,
    `Status: ${spec.status}`,
    "Clean room: yes",
    `LLM: ${spec.llm.used ? "caller-supplied" : "not used"}`,
    `Features: ${spec.features.length}`,
    `Workflows: ${spec.workflows.length}`,
    `API endpoints: ${spec.api.endpoints.length}`,
    `Plans: ${spec.pricing.plans.length}`,
    `Refusals: ${spec.refusals.length}`,
    `Similarity flagged: ${spec.similarity.flagged ? "yes" : "no"}`,
  ];
  if (out) {
    lines.push(`Spec: ${out}/behavior-spec.json`);
    lines.push(`Report: ${out}/OUTSIDE_IN_REPORT.md`);
  }
  return lines.join("\n");
}

export function parseArgs(argv) {
  const settings = {
    help: false,
    json: false,
    name: null,
    urls: [],
    docs: [],
    reviews: [],
    pricing: null,
    changelog: null,
    request: null,
    fixture: null,
    cache: null,
    out: null,
    summarizer: null,
    minIntervalMs: undefined,
    cacheMaxAgeMs: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") settings.help = true;
    else if (arg === "--json") settings.json = true;
    else if (arg === "--name") settings.name = needValue(argv, ++index, arg);
    else if (arg === "--url") settings.urls.push(needValue(argv, ++index, arg));
    else if (arg === "--docs") settings.docs.push(needValue(argv, ++index, arg));
    else if (arg === "--reviews") settings.reviews.push(needValue(argv, ++index, arg));
    else if (arg === "--pricing") settings.pricing = needValue(argv, ++index, arg);
    else if (arg === "--changelog") settings.changelog = needValue(argv, ++index, arg);
    else if (arg === "--request") settings.request = needValue(argv, ++index, arg);
    else if (arg === "--fixture") settings.fixture = needValue(argv, ++index, arg);
    else if (arg === "--cache") settings.cache = needValue(argv, ++index, arg);
    else if (arg === "--out") settings.out = needValue(argv, ++index, arg);
    else if (arg === "--summarizer") settings.summarizer = needValue(argv, ++index, arg);
    else if (arg === "--min-interval-ms") settings.minIntervalMs = numberValue(argv, ++index, arg);
    else if (arg === "--cache-max-age-ms") settings.cacheMaxAgeMs = numberValue(argv, ++index, arg);
    else throw new OutsideInError("Unknown option: " + arg, "USAGE");
  }
  return settings;
}

function needValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--"))
    throw new OutsideInError(flag + " requires a value.", "USAGE");
  return value;
}

function numberValue(argv, index, flag) {
  const value = Number(needValue(argv, index, flag));
  if (!Number.isInteger(value) || value < 0)
    throw new OutsideInError(flag + " must be a non-negative integer.", "USAGE");
  return value;
}
