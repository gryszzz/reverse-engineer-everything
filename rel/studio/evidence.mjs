import { readFileSync, statSync } from "node:fs";
import { MAX_EVIDENCE_FILE_BYTES } from "../evidence-explorer.mjs";
import { studioError } from "./errors.mjs";

const cache = new Map();

/** Load a saved Evidence file within the explorer size limit. */
export function loadEvidence(path) {
  const stat = statSync(path);
  if (!stat.isFile())
    throw studioError("Evidence file is not a regular file.", 404);
  if (stat.size > MAX_EVIDENCE_FILE_BYTES)
    throw studioError(
      "Evidence exceeds the 64 MiB explorer limit. Use the REA CLI for this record.",
      413,
    );
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
    return cached.record;
  const record = JSON.parse(readFileSync(path, "utf8"));
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, record });
  if (cache.size > 2) cache.delete(cache.keys().next().value);
  return record;
}
