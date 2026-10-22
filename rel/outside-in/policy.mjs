import { clipDetail } from "./text.mjs";

const BLOCKED_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".pyw",
  ".go",
  ".c",
  ".h",
  ".hh",
  ".hpp",
  ".cc",
  ".cpp",
  ".cxx",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".m",
  ".mm",
  ".rb",
  ".php",
  ".cs",
  ".vb",
  ".scala",
  ".lua",
  ".pl",
  ".sh",
  ".bash",
  ".ps1",
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".a",
  ".o",
  ".obj",
  ".class",
  ".jar",
  ".war",
  ".pyc",
  ".whl",
  ".apk",
  ".ipa",
  ".aab",
  ".dmg",
  ".pkg",
  ".deb",
  ".rpm",
  ".msi",
  ".msix",
  ".bin",
  ".asar",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".7z",
  ".rar",
  ".iso",
  ".img",
  ".node",
  ".elf",
  ".map",
]);

const BLOCKED_TYPES = new Set([
  "application/octet-stream",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/wasm",
  "application/javascript",
  "text/javascript",
  "application/typescript",
  "application/x-executable",
  "application/x-mach-binary",
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/x-msdownload",
  "application/x-dosexec",
  "application/x-sharedlib",
  "application/x-elf",
]);

const SECRET_PARAMS = new Set([
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "password",
  "secret",
  "auth",
  "signature",
  "token",
]);

const CAPTCHA =
  /g-recaptcha|h-captcha|cf-challenge|cdn-cgi\/challenge|recaptcha\/api\.js|data-sitekey/i;

export function extensionBlocked(pathname) {
  const base = decodeURIComponent(
    pathname.split("/").pop() ?? "",
  ).toLowerCase();
  if (base.endsWith(".tar.gz") || base.endsWith(".tar.bz2")) return true;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return BLOCKED_EXTENSIONS.has(base.slice(dot));
}

export function contentTypeBlocked(type) {
  return BLOCKED_TYPES.has((type ?? "").toLowerCase());
}

export function looksBinary(buffer, type) {
  if (contentTypeBlocked(type)) return true;
  if (!buffer || buffer.length === 0) return false;
  const head = buffer.subarray(0, 8);
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45) return true;
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return true;
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04
  )
    return true;
  if (
    head.length >= 4 &&
    head[0] === 0x00 &&
    head[1] === 0x61 &&
    head[2] === 0x73 &&
    head[3] === 0x6d
  )
    return true;
  const sample = buffer.subarray(0, 512);
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

export function hasCaptcha(body) {
  return CAPTCHA.test(body ?? "");
}

export function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  )
    return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part)))
    return false;
  const nums = parts.map(Number);
  if (nums.some((num) => num > 255)) return false;
  const [a, b] = nums;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_PARAMS.has(key.toLowerCase()))
        url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

export function classifyUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      reason: "disallowed-url",
      detail: "The URL could not be parsed.",
      redactedUrl: "[invalid-url]",
    };
  }
  const redactedUrl = redactUrl(url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: "unsupported-scheme",
      detail: "Only http and https URLs are fetched.",
      redactedUrl,
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reason: "credentials-in-url",
      detail: "URLs with usernames or passwords are refused.",
      redactedUrl,
    };
  }
  for (const key of url.searchParams.keys()) {
    if (SECRET_PARAMS.has(key.toLowerCase())) {
      return {
        ok: false,
        reason: "credentials-in-url",
        detail: "URLs with credential query parameters are refused.",
        redactedUrl,
      };
    }
  }
  if (!url.hostname || isPrivateHost(url.hostname)) {
    return {
      ok: false,
      reason: "private-host",
      detail: "Loopback, link-local, and private hosts are refused.",
      redactedUrl,
    };
  }
  if (extensionBlocked(url.pathname)) {
    return {
      ok: false,
      reason: "source-or-binary",
      detail: "Source and binary filenames are not fetched.",
      redactedUrl,
    };
  }
  return { ok: true, url, redactedUrl };
}

export function markedPaywall(html) {
  const tags = String(html ?? "").match(/<meta\b[^>]*>/gi) ?? [];
  return tags.some(
    (tag) =>
      /name=["']paywall["']/i.test(tag) && /content=["']true["']/i.test(tag),
  );
}

export function dispositionFilenameBlocked(headers) {
  const header = headers["content-disposition"] ?? "";
  const match = /filename\*?=(?:UTF-8''|"?)([^";]+)"?/i.exec(header);
  if (!match) return false;
  return extensionBlocked(match[1]);
}

export function refusalDetail(text) {
  return clipDetail(text);
}
