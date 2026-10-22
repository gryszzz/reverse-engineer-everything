import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lowerHeaders } from "./text.mjs";

export function loadFixtureDirectory(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const reads = [];
  const requests = [];
  return {
    reads,
    requests,
    async respond(url, headers) {
      requests.push({ url, headers: { ...headers } });
      const entry = manifest.responses?.[url];
      if (!entry) return null;
      reads.push(url);
      const body =
        typeof entry.body === "string"
          ? entry.body
          : readFileSync(join(dir, entry.file), "utf8");
      return {
        status: entry.status ?? 200,
        headers: lowerHeaders(entry.headers ?? {}),
        body,
      };
    },
  };
}
