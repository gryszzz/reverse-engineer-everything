import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { classifyUrl } from "../outside-in/policy.mjs";

const PACKAGE_NAME =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;

export function detectInput(input) {
  const text = String(input ?? "").trim();
  if (!text) return { kind: "empty", reason: "An input is required." };
  if (/^npm:/iu.test(text)) return npmName(text.slice(4).trim());
  if (/^https?:\/\//iu.test(text)) return fromUrl(text);
  const path = resolve(text);
  if (!existsSync(path))
    return { kind: "missing", path, reason: "That path does not exist." };
  const stat = statSync(path);
  if (stat.isDirectory()) return { kind: "directory", path };
  if (!stat.isFile())
    return { kind: "missing", path, reason: "That path is not a file." };
  const lower = path.toLowerCase();
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz"))
    return { kind: "npm-tarball", path };
  return { kind: "file", path };
}

function npmName(name) {
  if (!PACKAGE_NAME.test(name))
    return {
      kind: "npm",
      name,
      ok: false,
      reason: "That is not a public npm package name.",
    };
  return { kind: "npm", name, ok: true };
}

function fromUrl(text) {
  const policy = classifyUrl(text);
  if (!policy.ok)
    return {
      kind: "url",
      ok: false,
      href: text,
      reason: policy.detail,
      policy,
    };
  const url = policy.url;
  const host = url.hostname.toLowerCase();
  const github = githubRepo(url);
  if (host === "github.com" && github)
    return { kind: "github", ok: true, url, ...github };
  if (host === "github.com")
    return {
      kind: "github",
      ok: false,
      url,
      reason:
        "Only a public repository URL is read. Gists, logins, and other GitHub pages are skipped.",
    };
  const npm = npmFromUrl(url);
  if (npm) return npm;
  return { kind: "website", ok: true, url };
}

function githubRepo(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!safeSegment(owner) || !safeSegment(repo.replace(/\.git$/u, "")))
    return null;
  if (["login", "signup", "settings", "marketplace"].includes(owner))
    return null;
  return { owner, repo: repo.replace(/\.git$/u, "") };
}

function safeSegment(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    /^[A-Za-z0-9_.-]+$/u.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function npmFromUrl(url) {
  const host = url.hostname.toLowerCase();
  if (host === "www.npmjs.com" || host === "npmjs.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "package" || parts.length < 2) return null;
    const name = parts[1].startsWith("@")
      ? `${parts[1]}/${parts[2] ?? ""}`
      : parts[1];
    return npmName(name);
  }
  if (host === "registry.npmjs.org") {
    const name = decodeURIComponent(url.pathname.replace(/^\/+/u, ""));
    if (!name) return null;
    return npmName(name);
  }
  return null;
}
