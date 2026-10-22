import { REDACTED, SIMILARITY_THRESHOLD, QUOTE_MAX } from "./constants.mjs";

const SKIP_KEYS = new Set([
  "url",
  "fetched_at",
  "generated_at",
  "sha256",
  "schema_version",
  "user_agent",
  "id",
  "method",
  "path",
  "operation_id",
  "currency",
  "interval",
  "amount",
  "display",
  "status",
  "role",
  "reason",
  "content_type",
  "rule",
  "provider",
  "ree_remote_calls",
  "origin",
  "kind",
  "style",
  "placement",
  "window",
  "limit",
  "scope",
  "mode",
  "platform",
  "authentication",
  "source_acquisition",
  "transport",
  "error",
  "published_at",
  "action",
]);

export function applySimilarityGuard(spec, sources, options = {}) {
  const settings = {
    threshold: options.threshold ?? SIMILARITY_THRESHOLD,
    quoteMax: options.quoteMax ?? QUOTE_MAX,
    redacted: options.redacted ?? REDACTED,
  };
  const findings = [];
  walk(spec, "", sources, settings, findings);
  return findings;
}

export function collectQuotes(value, quotes = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectQuotes(item, quotes);
    return quotes;
  }
  if (!value || typeof value !== "object") return quotes;
  if (value.attributed_quote === true && typeof value.text === "string") quotes.push(value.text);
  for (const child of Object.values(value)) collectQuotes(child, quotes);
  return quotes;
}

export function guardReport(report, sources, options, allowedQuotes) {
  const threshold = options.threshold ?? SIMILARITY_THRESHOLD;
  const quoteMax = options.quoteMax ?? QUOTE_MAX;
  const findings = [];
  const lines = report.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.length < threshold) return line;
    const hit = findRun(trimmed, sources, threshold);
    if (!hit) return line;
    const prose = trimmed.replace(/^>\s*/, "");
    const covered = allowedQuotes.some(
      (quote) =>
        quote.length <= quoteMax &&
        hit.length <= quoteMax &&
        (quote === prose || quote.includes(prose)),
    );
    if (covered) return line;
    findings.push({
      path: "/report",
      run_length: hit.length,
      source_url: hit.url,
      action: "redacted",
    });
    return line.startsWith(">") ? "> " + REDACTED : REDACTED;
  });
  return { report: lines.join("\n"), findings };
}

export function verbatimRunLength(needle, haystack, threshold) {
  if (!needle || !haystack || needle.length < threshold || haystack.length < threshold) return 0;
  if (haystack.includes(needle)) return needle.length;
  let best = 0;
  for (let index = 0; index <= needle.length - threshold;) {
    const probe = needle.slice(index, index + threshold);
    const at = haystack.indexOf(probe);
    if (at < 0) {
      index += 1;
      continue;
    }
    let length = threshold;
    while (
      index + length < needle.length &&
      at + length < haystack.length &&
      needle[index + length] === haystack[at + length]
    ) {
      length += 1;
    }
    if (length > best) best = length;
    index += Math.max(1, length - threshold + 1);
  }
  return best;
}

function walk(value, path, sources, options, findings) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}/${index}`, sources, options, findings));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.attributed_quote === true && typeof value.text === "string") {
    consider(value, "text", `${path}/text`, sources, options, findings, true);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    if (typeof child === "string") {
      if (!skipped(key, childPath))
        consider(value, key, childPath, sources, options, findings, false);
    } else walk(child, childPath, sources, options, findings);
  }
}

function skipped(key, path) {
  if (SKIP_KEYS.has(key)) return true;
  return key === "name" && (path === "/target/name" || path === "/collector/name");
}

function consider(holder, key, path, sources, options, findings, quoted) {
  const text = holder[key];
  if (quoted && text.length <= options.quoteMax) return;
  if (text.length < options.threshold) return;
  const hit = findRun(text, sources, options.threshold);
  if (!hit) return;
  holder[key] = options.redacted;
  findings.push({
    path,
    run_length: hit.length,
    source_url: hit.url,
    action: "redacted",
  });
}

function findRun(needle, sources, threshold) {
  let best = null;
  for (const source of sources) {
    const length = verbatimRunLength(needle, source.body ?? "", threshold);
    if (length >= threshold && (!best || length > best.length)) best = { length, url: source.url };
  }
  return best;
}
