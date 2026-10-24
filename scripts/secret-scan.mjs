import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".turbo",
  ".cache",
]);
const SKIP_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".wasm",
  ".zip",
  ".gz",
  ".tgz",
  ".pdf",
  ".woff",
  ".woff2",
]);
const MAX_BYTES = 2_000_000;

const RULES = [
  { id: "stripe-key", source: "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}" },
  { id: "stripe-webhook", source: "whsec_[A-Za-z0-9]{16,}" },
  { id: "aws-access-key", source: "AKIA[0-9A-Z]{16}" },
  { id: "private-key", source: "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
  { id: "github-token", source: "ghp_[A-Za-z0-9]{20,}" },
];

export function findingsInText(text) {
  const findings = [];
  const lines = String(text).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of RULES) {
      if (new RegExp(rule.source).test(lines[index]))
        findings.push({ line: index + 1, rule: rule.id });
    }
  }
  return findings;
}

function walk(root, dir, findings) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(root, path, findings);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot > 0 && SKIP_EXT.has(entry.name.slice(dot).toLowerCase())) continue;
    scanFile(root, path, findings);
  }
}

function scanFile(root, path, findings) {
  let info;
  try {
    info = statSync(path);
  } catch {
    return;
  }
  if (!info.isFile() || info.size > MAX_BYTES) return;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return;
  for (const finding of findingsInText(bytes.toString("utf8"))) {
    findings.push({
      file: relative(root, path) || path,
      line: finding.line,
      rule: finding.rule,
    });
  }
}

/** Scan a file or directory. Findings name the file, line, and rule. They omit the match. */
export function scanDirectory(root) {
  const findings = [];
  const info = statSync(root);
  if (info.isFile()) scanFile(root, root, findings);
  else walk(root, root, findings);
  return findings;
}

export function formatFinding(finding) {
  return `${finding.file}:${finding.line}:${finding.rule}: [redacted]`;
}

function main() {
  const root = process.argv[2] ? process.argv[2] : process.cwd();
  const findings = scanDirectory(root);
  for (const finding of findings) console.error(formatFinding(finding));
  if (findings.length > 0) process.exit(1);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) main();
