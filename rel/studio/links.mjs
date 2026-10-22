import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { BlockList, isIP } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { digestValue } from "./experiment.mjs";
import { studioError } from "./errors.mjs";

const PAGE_BYTES = 2 * 1024 * 1024;
const FILE_BYTES = 16 * 1024 * 1024;
const REPO_BYTES = 32 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 60_000;
const MAX_SCRIPTS = 8;
const MAX_ARCHIVE_FILES = 200;

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
])
  blocked.addSubnet(address, prefix, "ipv4");
blocked.addAddress("255.255.255.255", "ipv4");
blocked.addAddress("::1", "ipv6");
blocked.addAddress("::", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");

const PACKAGE_NAME =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;

/**
 * Describe a link fetch without touching the network.
 * The digest covers this description. Approval must match it.
 */
export function planLink(input, { gitAvailable = null } = {}) {
  if (typeof input !== "string" || input.trim() === "" || input.length > 2000)
    throw studioError("Paste one https link or an npm package name.");
  const text = input.trim();
  const plan = describe(text, gitAvailable);
  const body = {
    kind: plan.kind,
    input: plan.input,
    requests: plan.requests,
    git: plan.git,
    executes: false,
  };
  return { ...plan, executes: false, plan_digest: digestValue(body) };
}

export function approveLink({ input, approved, planDigest, gitAvailable }) {
  const plan = planLink(input, { gitAvailable });
  if (approved !== true)
    throw studioError("Check the box to approve this fetch.", 403);
  if (planDigest !== plan.plan_digest)
    throw studioError("Review the exact fetch plan before it runs.", 409);
  if (plan.available === false) throw studioError(plan.unavailable_reason, 409);
  return plan;
}

/**
 * Fetch an already approved plan into destination.
 * Downloaded bytes are stored and hashed. They are not executed.
 */
export async function performLink(plan, options) {
  const destination = options.destination;
  mkdirSync(destination, { recursive: true });
  try {
    if (plan.kind === "git") return await performGit(plan, options);
    if (plan.kind === "npm") return await performNpm(plan, options);
    if (plan.kind === "web-page") return await performPage(plan, options);
    return await performDirect(plan, options);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function describe(text, gitAvailable) {
  const git = parseGit(text);
  if (git) {
    const available = gitAvailable ?? defaultGitAvailable();
    return {
      kind: "git",
      input: text,
      available,
      unavailable_reason: available
        ? null
        : "git is not on PATH. REE does not install it. The repository was not cloned.",
      requests: [
        {
          url: git.cloneUrl,
          limit_bytes: REPO_BYTES,
          timeout_ms: GIT_TIMEOUT_MS,
          purpose: "shallow clone",
          exact: true,
        },
      ],
      git: {
        argv: [
          "git",
          "-c",
          "credential.helper=",
          "clone",
          "--depth",
          "1",
          "--single-branch",
          ...(git.branch ? ["--branch", git.branch] : []),
          "--",
          git.cloneUrl,
          "<project links directory>",
        ],
      },
      destination: "project links directory",
      note: "A shallow clone is stored under this project's links directory. It is not executed.",
    };
  }
  if (text.startsWith('https://')) {
    const url = publicUrl(text);
    if (isNpmPackagePage(url)) return npmPlan(text, packageFromNpmPage(url));
    if (isDirectFile(url))
      return {
        kind: "file",
        input: text,
        available: true,
        unavailable_reason: null,
        requests: [httpRequest(url.href, FILE_BYTES, "direct download")],
        git: null,
        destination: "project links directory",
        note: "The file is copied into this project's links directory and hashed. It is not executed.",
      };
    return {
      kind: "web-page",
      input: text,
      available: true,
      unavailable_reason: null,
      requests: [
        httpRequest(url.href, PAGE_BYTES, "page"),
        {
          url: url.origin,
          limit_bytes: PAGE_BYTES,
          timeout_ms: HTTP_TIMEOUT_MS,
          purpose: `up to ${MAX_SCRIPTS} https script and sourceMappingURL references named by that page, each capped, total ${FILE_BYTES} bytes`,
          exact: false,
        },
      ],
      git: null,
      destination: "project links directory",
      note: "The page and referenced scripts are saved as source. They are not executed.",
    };
  }
  if (PACKAGE_NAME.test(text)) return npmPlan(text, text);
  throw studioError(
    "Use an https GitHub or GitLab URL, an https file or page URL, or an npm package name.",
  );
}

function npmPlan(input, name) {
  const registry = `https://registry.npmjs.org/${name.replace("/", "%2f")}`;
  return {
    kind: "npm",
    input,
    available: true,
    unavailable_reason: null,
    requests: [
      httpRequest(registry, 1024 * 1024, "npm metadata"),
      {
        url: "https://registry.npmjs.org/",
        limit_bytes: FILE_BYTES,
        timeout_ms: HTTP_TIMEOUT_MS,
        purpose:
          "dist.tarball from that metadata; the host must stay registry.npmjs.org",
        exact: false,
      },
    ],
    git: null,
    destination: "project links directory",
    note: "The registry document and one tarball are fetched. A safe archive is unpacked as source. Nothing is installed or executed.",
  };
}

function httpRequest(url, limit, purpose) {
  return {
    url,
    limit_bytes: limit,
    timeout_ms: HTTP_TIMEOUT_MS,
    purpose,
    exact: true,
  };
}

function parseGit(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "gitlab.com") return null;
  let parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  let branch = null;
  if (host === "gitlab.com") {
    const marker = parts.indexOf("-");
    if (marker !== -1) {
      if (parts[marker + 1] !== "tree" || parts.length !== marker + 3)
        return null;
      branch = parts[marker + 2];
      parts = parts.slice(0, marker);
    }
  } else if (parts[2] === "tree") {
    if (parts.length !== 4) return null;
    branch = parts[3];
    parts = parts.slice(0, 2);
  } else if (parts.length !== 2) return null;
  if (parts.length < 2) return null;
  if (branch && (!/^[\w./-]{1,200}$/u.test(branch) || branch.includes("..")))
    return null;
  const repo = parts.at(-1).replace(/\.git$/u, "");
  const owners = parts.slice(0, -1);
  if (
    !/^[\w.-]+$/u.test(repo) ||
    owners.some((part) => !/^[\w.-]+$/u.test(part))
  )
    return null;
  return {
    cloneUrl: `https://${host}/${owners.join("/")}/${repo}.git`,
    branch,
  };
}

function publicUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw studioError("That link is not a URL.");
  }
  if (url.protocol !== "https:")
    throw studioError("Links must use https. Nothing was fetched.");
  if (url.username || url.password)
    throw studioError(
      "Links must not contain credentials. Nothing was fetched.",
    );
  if (!url.hostname) throw studioError("That link has no host.");
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  )
    throw studioError(
      "That host is not a public address. Nothing was fetched.",
    );
  if (isIP(host)) {
    const family = isIP(host) === 6 ? "ipv6" : "ipv4";
    if (blocked.check(host, family))
      throw studioError(
        "That host is not a public address. Nothing was fetched.",
      );
  }
  return url;
}

function isNpmPackagePage(url) {
  return (
    (url.hostname === "www.npmjs.com" || url.hostname === "npmjs.com") &&
    url.pathname.startsWith("/package/")
  );
}

function packageFromNpmPage(url) {
  const name = decodeURIComponent(
    url.pathname.slice("/package/".length),
  ).replace(/\/$/u, "");
  if (!PACKAGE_NAME.test(name))
    throw studioError("That npm page does not name one package.");
  return name;
}

function isDirectFile(url) {
  const path = url.pathname.toLowerCase();
  return [
    ".apk",
    ".aab",
    ".zip",
    ".wasm",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
    ".hex",
    ".evm",
    ".asar",
    ".js",
    ".mjs",
    ".cjs",
    ".tgz",
    ".gz",
    ".tar",
  ].some((ext) => path.endsWith(ext));
}

function defaultGitAvailable() {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

async function performGit(plan, options) {
  const git = parseGit(plan.input);
  const dest = join(options.destination, "repo");
  await assertPublic(git.cloneUrl, options.lookup ?? dnsLookup);
  const spawn = options.spawn ?? spawnSync;
  const result = spawn(
    "git",
    [
      "-c",
      "credential.helper=",
      "clone",
      "--depth",
      "1",
      "--single-branch",
      ...(git.branch ? ["--branch", git.branch] : []),
      "--",
      git.cloneUrl,
      dest,
    ],
    {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: gitEnv(),
    },
  );
  if (result.error || result.status !== 0) {
    throw studioError(
      `The shallow clone failed. ${String(result.stderr || result.error?.message || "").slice(0, 500)}`,
    );
  }
  auditTree(dest, REPO_BYTES, 4000);
  return finish(plan, dest, [
    {
      url: git.cloneUrl,
      bytes: treeBytes(dest),
      sha256: treeHash(dest),
      purpose: "shallow clone",
    },
  ]);
}

async function performDirect(plan, options) {
  const url = plan.requests[0].url;
  const saved = await fetchBytes(url, FILE_BYTES, options);
  const name = safeLeaf(new URL(saved.url).pathname) || "download.bin";
  const path = join(options.destination, name);
  writeFileSync(path, saved.bytes, { mode: 0o644 });
  if (name.endsWith(".tgz") || name.endsWith(".tar.gz")) {
    const unpacked = unpackArchive(
      saved.bytes,
      join(options.destination, "unpacked"),
    );
    if (unpacked)
      return finish(plan, unpacked, [record(saved, "direct download")]);
  }
  return finish(plan, path, [record(saved, "direct download")]);
}

async function performNpm(plan, options) {
  const registry = plan.requests[0].url;
  const meta = await fetchBytes(registry, 1024 * 1024, options);
  let document;
  try {
    document = JSON.parse(meta.bytes.toString("utf8"));
  } catch {
    throw studioError("The npm metadata was not JSON. Nothing was unpacked.");
  }
  const tarball = document?.dist?.tarball;
  let parsed;
  try {
    parsed = new URL(tarball);
  } catch {
    throw studioError("The npm metadata did not include a tarball URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "registry.npmjs.org")
    throw studioError(
      "The tarball URL is not on registry.npmjs.org. It was not fetched.",
    );
  const packed = await fetchBytes(parsed.href, FILE_BYTES, options);
  const unpacked = unpackArchive(
    packed.bytes,
    join(options.destination, "package"),
  );
  const path = unpacked ?? join(options.destination, "package.tgz");
  if (!unpacked) writeFileSync(path, packed.bytes, { mode: 0o644 });
  return finish(plan, path, [
    record(meta, "npm metadata"),
    record(packed, "npm tarball"),
  ]);
}

async function performPage(plan, options) {
  const pageUrl = plan.requests[0].url;
  const page = await fetchBytes(pageUrl, PAGE_BYTES, options);
  const directory = join(options.destination, "page");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.html"), page.bytes, { mode: 0o644 });
  const fetched = [record(page, "page")];
  const html = page.bytes.toString("utf8");
  const refs = referencedResources(html, page.url).slice(0, MAX_SCRIPTS);
  let total = 0;
  let index = 0;
  for (const ref of refs) {
    const saved = await fetchBytes(ref, PAGE_BYTES, options);
    total += saved.bytes.length;
    if (total > FILE_BYTES)
      throw studioError(
        "Referenced scripts exceeded 16 MiB. Nothing was kept.",
      );
    index += 1;
    const leaf = safeLeaf(new URL(saved.url).pathname) || `script-${index}.js`;
    const name =
      leaf.endsWith(".js") || leaf.endsWith(".map")
        ? leaf
        : `script-${index}.js`;
    writeFileSync(join(directory, `${index}-${name}`), saved.bytes, {
      mode: 0o644,
    });
    fetched.push(record(saved, "referenced script"));
  }
  const inline = inlineScripts(html);
  inline.forEach((source, number) => {
    writeFileSync(join(directory, `inline-${number + 1}.js`), source, {
      mode: 0o644,
    });
  });
  return finish(plan, directory, fetched);
}

export function referencedResources(html, pageUrl) {
  const found = [];
  const page = new URL(pageUrl);
  const patterns = [
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/giu,
    /sourceMappingURL=(\S+)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      let url;
      try {
        url = new URL(match[1].trim(), page);
      } catch {
        continue;
      }
      if (url.protocol !== "https:") continue;
      found.push(url.href);
    }
  }
  return [...new Set(found)];
}

function inlineScripts(html) {
  const blocks = [];
  for (const match of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/giu,
  )) {
    if (/\bsrc\s*=/iu.test(match[1])) continue;
    const source = match[2].trim();
    if (source) blocks.push(source.slice(0, PAGE_BYTES));
    if (blocks.length >= 4) break;
  }
  return blocks;
}

async function fetchBytes(url, limit, options) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const lookup = options.lookup ?? dnsLookup;
  return readHttp(url, {
    limit,
    fetchImpl,
    lookup,
    hops: 3,
    timeout: HTTP_TIMEOUT_MS,
  });
}

async function readHttp(url, { limit, fetchImpl, lookup, hops, timeout }) {
  await assertPublic(url, lookup);
  const response = await fetchImpl(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
    headers: {
      accept: "*/*",
      "user-agent": "REE-studio-link-intake",
    },
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (hops <= 0) throw studioError("That link redirected too many times.");
    const location = response.headers.get("location");
    if (!location) throw studioError("A redirect had no location.");
    return readHttp(new URL(location, url).href, {
      limit,
      fetchImpl,
      lookup,
      hops: hops - 1,
      timeout,
    });
  }
  if (!response.ok)
    throw studioError(
      `The fetch returned HTTP ${response.status}. Nothing was kept.`,
    );
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw studioError(
      `The response declares ${declared} bytes, over the ${limit} byte limit.`,
    );
  const reader = response.body?.getReader?.();
  if (!reader) throw studioError("The response had no body.");
  const chunks = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw studioError(
        `The download exceeded ${limit} bytes and was discarded.`,
      );
    }
    chunks.push(Buffer.from(step.value));
  }
  const bytes = Buffer.concat(chunks);
  return {
    url,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function assertPublic(raw, lookup) {
  const url = publicUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  )
    throw studioError(
      "That host is not a public address. Nothing was fetched.",
    );
  let addresses;
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true });
  } catch {
    throw studioError("The host could not be resolved. Nothing was fetched.");
  }
  for (const item of addresses) {
    const family = item.family === 6 ? "ipv6" : "ipv4";
    if (blocked.check(item.address, family))
      throw studioError(
        "That host resolves to a non-public address. Nothing was fetched.",
      );
  }
}

function unpackArchive(bytes, dest) {
  let data;
  try {
    data = gunzipSync(bytes, { maxOutputLength: FILE_BYTES });
  } catch {
    return null;
  }
  const entries = readTar(data);
  if (!entries) return null;
  mkdirSync(dest, { recursive: true });
  for (const entry of entries) {
    const path = join(dest, entry.name);
    if (entry.directory) mkdirSync(path, { recursive: true });
    else {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, entry.bytes, { mode: 0o644 });
    }
  }
  auditTree(dest, FILE_BYTES, MAX_ARCHIVE_FILES);
  return dest;
}

function readTar(data) {
  const entries = [];
  let offset = 0;
  let pendingName = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = textField(header, 0, 100);
    const prefix = textField(header, 345, 155);
    let full = pendingName || (prefix ? `${prefix}/${name}` : name);
    pendingName = null;
    const size = parseInt(textField(header, 124, 12).trim(), 8) || 0;
    const type = header[156];
    offset += 512;
    if (offset + size > data.length) return null;
    const body = data.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === 120 || type === 103) {
      const pathLine = body
        .toString("utf8")
        .split("\n")
        .find((line) => /(^|\s)path=/u.test(line));
      pendingName = pathLine?.split("path=")[1]?.trim() || null;
      continue;
    }
    if (type === 53) {
      if (!safeArchivePath(full)) return null;
      entries.push({ name: full, directory: true, bytes: Buffer.alloc(0) });
      continue;
    }
    if (type !== 0 && type !== 48) return null;
    if (!safeArchivePath(full)) return null;
    entries.push({ name: full, directory: false, bytes: Buffer.from(body) });
    if (entries.length > MAX_ARCHIVE_FILES) return null;
  }
  return entries;
}

function safeArchivePath(name) {
  const trimmed = name.replace(/\/$/u, "");
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  )
    return false;
  return trimmed.split("/").every((part) => part !== "" && part !== "..");
}

function textField(buffer, start, length) {
  return buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/su, "");
}

function auditTree(root, byteLimit, fileLimit) {
  const pending = [root];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const rel = relative(root, path);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw studioError("The download left its destination. It was removed.");
      if (stat.isSymbolicLink())
        throw studioError(
          "The download contains a symbolic link. It was removed and was not executed.",
        );
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > fileLimit || bytes > byteLimit)
          throw studioError(
            "The download is over the studio size limit. It was removed.",
          );
      } else
        throw studioError(
          "The download contains a special file. It was removed.",
        );
    }
  }
}

function treeBytes(root) {
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      if (name === ".git") continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile()) bytes += stat.size;
    }
  }
  return bytes;
}

function treeHash(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      if (name === ".git") continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile()) files.push(path);
    }
  }
  const hash = createHash("sha256");
  for (const path of files.sort()) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(createHash("sha256").update(readFileSync(path)).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function finish(plan, path, fetches) {
  return {
    path,
    kind: plan.kind,
    executes: false,
    fetches,
  };
}

function record(saved, purpose) {
  return {
    url: saved.url,
    bytes: saved.bytes.length,
    sha256: saved.sha256,
    purpose,
  };
}

function safeLeaf(pathname) {
  const leaf = pathname.split("/").filter(Boolean).at(-1) ?? "";
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80);
  if (!cleaned || cleaned === "." || cleaned === "..") return "";
  return cleaned;
}

function gitEnv() {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C",
    GIT_TERMINAL_PROMPT: "0",
  };
}
