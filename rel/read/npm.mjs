import { readFileSync } from "node:fs";
import { requestHeaders } from "../outside-in/fetch.mjs";
import { readGzipTar } from "./archive.mjs";

const UNLICENSED = /^(unlicensed|proprietary|none|all rights reserved)$/iu;
const MAX_TARBALL = 2_000_000;
const MAX_TYPES = 8;

export async function readNpmPackage({
  name,
  fetchImpl,
  sleep,
  minIntervalMs,
}) {
  const registryUrl = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
  const response = await get(fetchImpl, registryUrl, sleep, minIntervalMs, 0);
  if (!response.ok)
    return {
      documents: [],
      skipped: [
        {
          target: registryUrl,
          reason: `The public registry returned HTTP ${response.status}.`,
        },
      ],
    };
  let meta;
  try {
    meta = JSON.parse(response.body);
  } catch {
    return {
      documents: [],
      skipped: [
        { target: registryUrl, reason: "Registry JSON could not be parsed." },
      ],
    };
  }
  const version = meta?.["dist-tags"]?.latest;
  const manifest = version ? meta.versions?.[version] : null;
  const documents = [];
  const skipped = [];
  const provenance = [];
  const readme = typeof meta.readme === "string" ? meta.readme : "";
  if (readme.trim()) {
    documents.push({
      url: registryUrl,
      role: "docs",
      kind: "sdk-readme",
      type: "text/markdown; charset=utf-8",
      body: readme,
    });
  } else {
    skipped.push({
      target: registryUrl,
      reason: "The registry record has no README.",
    });
  }
  const license = manifest?.license ?? meta.license ?? null;
  const tarball = manifest?.dist?.tarball;
  if (!tarball || typeof tarball !== "string") {
    skipped.push({
      target: name,
      reason: "The registry record has no tarball URL. Types were not read.",
    });
    return {
      documents,
      skipped,
      provenance,
      name: manifest?.name ?? name,
      license,
    };
  }
  if (licenseBlocked(license)) {
    skipped.push({
      target: tarball,
      reason: license
        ? `License ${license} does not allow unpacking the tarball. Types were not read.`
        : "No license was published. The tarball was not unpacked.",
    });
    return {
      documents,
      skipped,
      provenance,
      name: manifest?.name ?? name,
      license,
    };
  }
  const packed = await get(
    fetchImpl,
    tarball,
    sleep,
    minIntervalMs,
    documents.length > 0 ? minIntervalMs : 0,
    true,
  );
  if (!packed.ok) {
    skipped.push({
      target: tarball,
      reason: `The tarball returned HTTP ${packed.status}. Types were not read.`,
    });
    return {
      documents,
      skipped,
      provenance,
      name: manifest?.name ?? name,
      license,
    };
  }
  if (packed.bytes.length > MAX_TARBALL) {
    skipped.push({
      target: tarball,
      reason: "The tarball is larger than 2 MB. Types were not read.",
    });
    return {
      documents,
      skipped,
      provenance,
      name: manifest?.name ?? name,
      license,
    };
  }
  const types = typeNames(packed.bytes, skipped, tarball);
  if (types.length > 0) {
    documents.push({
      url: `https://owned.docs/npm/${encodeURIComponent(name)}/types.md`,
      role: "docs",
      kind: "sdk-readme",
      type: "text/markdown; charset=utf-8",
      body: typesMarkdown(types),
    });
    provenance.push({
      target: tarball,
      note: "Declaration names were read from this tarball. Implementation source and declaration bodies were not copied.",
    });
  }
  return {
    documents,
    skipped,
    provenance,
    name: manifest?.name ?? name,
    license,
  };
}

export function readNpmTarball(path) {
  const bytes = readFileSync(path);
  const skipped = [];
  const documents = [];
  let entries;
  try {
    entries = readGzipTar(bytes);
  } catch {
    return {
      documents,
      skipped: [{ target: path, reason: "The tarball could not be read." }],
      name: "package",
    };
  }
  const readme = entries.find((entry) =>
    /(^|\/)readme\.md$/iu.test(entry.name),
  );
  if (readme) {
    documents.push({
      url: "https://owned.docs/package/README.md",
      role: "docs",
      kind: "sdk-readme",
      type: "text/markdown; charset=utf-8",
      body: readme.content.toString("utf8"),
    });
  } else {
    skipped.push({ target: path, reason: "The tarball has no README.md." });
  }
  const types = typeNamesFromEntries(entries, skipped);
  if (types.length > 0) {
    documents.push({
      url: "https://owned.docs/package/types.md",
      role: "docs",
      kind: "sdk-readme",
      type: "text/markdown; charset=utf-8",
      body: typesMarkdown(types),
    });
  }
  return { documents, skipped, name: packageName(entries) };
}

function licenseBlocked(license) {
  if (license == null) return true;
  const text = Array.isArray(license)
    ? license.map((item) => item?.type ?? item).join(" ")
    : typeof license === "string"
      ? license
      : (license.type ?? "");
  return !String(text).trim() || UNLICENSED.test(String(text).trim());
}

function typeNames(bytes, skipped, tarball) {
  let entries;
  try {
    entries = readGzipTar(bytes);
  } catch {
    skipped.push({
      target: tarball,
      reason: "The tarball could not be unpacked.",
    });
    return [];
  }
  return typeNamesFromEntries(entries, skipped);
}

function typeNamesFromEntries(entries, skipped) {
  const names = [];
  let files = 0;
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (
      lower.endsWith(".js") ||
      lower.endsWith(".mjs") ||
      lower.endsWith(".cjs")
    ) {
      skipped.push({
        target: entry.name,
        reason: "Implementation source is not copied.",
      });
      continue;
    }
    if (!lower.endsWith(".d.ts")) continue;
    files += 1;
    if (files > MAX_TYPES) {
      skipped.push({
        target: entry.name,
        reason: `Past the ${MAX_TYPES} declaration file limit.`,
      });
      continue;
    }
    const text = entry.content.toString("utf8");
    for (const match of text.matchAll(
      /export\s+(?:declare\s+)?(?:interface|type|class|function|const|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
    )) {
      if (!names.includes(match[1])) names.push(match[1]);
    }
  }
  return names;
}

function typesMarkdown(names) {
  const lines = ["# Declaration names", ""];
  for (const name of names) {
    lines.push(
      `## ${name}`,
      "",
      "A declaration name was read. The declaration body was not copied.",
      "",
    );
  }
  return lines.join("\n");
}

function packageName(entries) {
  const manifest = entries.find((entry) =>
    /(^|\/)package\.json$/u.test(entry.name),
  );
  if (!manifest) return "package";
  try {
    const parsed = JSON.parse(manifest.content.toString("utf8"));
    return typeof parsed.name === "string" && parsed.name
      ? parsed.name
      : "package";
  } catch {
    return "package";
  }
}

async function get(fetchImpl, url, sleep, minIntervalMs, wait, binary = false) {
  if (wait > 0) await sleep(wait);
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    headers: requestHeaders(),
  });
  const status = response.status ?? 0;
  if (binary) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return { ok: status >= 200 && status < 300, status, bytes };
  }
  const body = await response.text();
  return { ok: status >= 200 && status < 300, status, body };
}
