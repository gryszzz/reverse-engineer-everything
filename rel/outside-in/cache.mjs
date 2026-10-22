import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function createMemoryCache(now, maxAgeMs) {
  const entries = new Map();
  return {
    get(url) {
      const entry = entries.get(url);
      if (!entry) return null;
      if (!fresh(entry, now, maxAgeMs)) return null;
      return { ...entry, hit: true };
    },
    put(url, record) {
      entries.set(url, { ...record, hit: false });
    },
  };
}

export function createFileCache(dir, now, maxAgeMs) {
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const bodies = join(dir, "bodies");
  mkdirSync(bodies, { recursive: true });
  let manifest = { version: 1, entries: {} };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    manifest = { version: 1, entries: {} };
  }
  if (!manifest.entries) manifest.entries = {};

  return {
    get(url) {
      const entry = manifest.entries[url];
      if (!entry || !fresh(entry, now, maxAgeMs)) return null;
      try {
        const body = readFileSync(join(dir, entry.file), "utf8");
        return { ...entry, body, hit: true };
      } catch {
        return null;
      }
    },
    put(url, record) {
      const file = join("bodies", `${record.sha256}.txt`);
      writeFileSync(join(dir, file), record.body);
      manifest.entries[url] = {
        fetched_at: record.fetched_at,
        status: record.status,
        content_type: record.content_type,
        sha256: record.sha256,
        bytes: record.bytes,
        headers: record.headers,
        file,
      };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };
}

function fresh(entry, now, maxAgeMs) {
  if (!(maxAgeMs > 0)) return false;
  const fetched = Date.parse(entry.fetched_at);
  if (!Number.isFinite(fetched)) return false;
  return now().getTime() - fetched <= maxAgeMs;
}
