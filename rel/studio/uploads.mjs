import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { studioError } from "./errors.mjs";
import { newId } from "./projects.mjs";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 24;
export const MAX_UPLOAD_TOTAL = 16 * 1024 * 1024;
const BATCH_ID = /^up_[a-f0-9]{16}$/u;
const SEGMENT = /^[A-Za-z0-9._ -]{1,80}$/u;

export function safeUploadRelative(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 240)
    throw studioError("The dropped relative path is invalid.");
  if (value.includes("\\") || value.startsWith("/") || value.includes("\0"))
    throw studioError("The dropped path must stay inside the upload folder.");
  const parts = value.split("/");
  if (
    parts.length > 4 ||
    parts.some((part) => part === "." || part === ".." || !SEGMENT.test(part))
  )
    throw studioError("The dropped path must stay inside the upload folder.");
  return parts.join("/");
}

function readMeta(directory) {
  const path = join(directory, "meta.json");
  if (!existsSync(path)) return { files: 0, bytes: 0, paths: [] };
  const meta = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(meta.paths)) meta.paths = [];
  return meta;
}

/**
 * Copy one dropped file into the studio data directory.
 * This is a local copy, not a remote upload, and it does not analyze the bytes.
 */
export function writeUpload({
  directory,
  batchId,
  name,
  relative: relativePath,
  bytes,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0)
    throw studioError("The dropped file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES)
    throw studioError("A dropped file exceeds 8 MiB.", 413);
  const id = batchId ?? newId("up_");
  if (!BATCH_ID.test(id)) throw studioError("Unknown upload batch.", 404);
  const batchDir = join(directory, "uploads", id);
  mkdirSync(batchDir, { recursive: true });
  const meta = readMeta(batchDir);
  if (meta.files >= MAX_UPLOAD_FILES)
    throw studioError("That drop has too many files.", 413);
  if (meta.bytes + bytes.length > MAX_UPLOAD_TOTAL)
    throw studioError("That drop exceeds 16 MiB.", 413);
  const stored = safeUploadRelative(relativePath) ?? safeUploadRelative(name);
  if (!stored) throw studioError("Provide a file name for the drop.");
  const destination = join(batchDir, stored);
  const fromBatch = relative(batchDir, destination);
  if (fromBatch.startsWith("..") || isAbsolute(fromBatch))
    throw studioError("The dropped path must stay inside the upload folder.");
  if (existsSync(destination))
    throw studioError("That dropped path was already copied.");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { flag: "wx" });
  meta.files += 1;
  meta.bytes += bytes.length;
  meta.paths.push(stored);
  writeFileSync(join(batchDir, "meta.json"), `${JSON.stringify(meta)}\n`);
  const classifyPath = meta.paths.length === 1 ? destination : batchDir;
  return { batchId: id, path: destination, classifyPath, meta };
}
