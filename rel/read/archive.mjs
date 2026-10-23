import { gunzipSync } from "node:zlib";

/** ustar members from a gzip npm tarball. Implementation files stay bytes. */
export function readGzipTar(buffer) {
  const data = gunzipSync(buffer);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(header.subarray(0, 100));
    const prefix = text(header.subarray(345, 500));
    const size = parseInt(text(header.subarray(124, 136)), 8);
    const type = header[156];
    offset += 512;
    if (!Number.isFinite(size) || size < 0) break;
    const content = data.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type !== 0 && type !== 48) continue;
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      content,
    });
  }
  return entries;
}

function text(bytes) {
  return bytes.toString("utf8").replace(/\0.*$/su, "").trim();
}
