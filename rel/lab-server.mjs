/**
 * REE Visual Lab: minimal, dependency-free, read-only learning server.
 *
 * Serves ONLY the visual lab, its two actual sample modules, and the
 * human-readable verification note. It never executes a supplied target,
 * exposes arbitrary repo files, or listens outside the local machine.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAB = "/experiments/rel-visual-lab/index.html";
const SOURCES = Object.freeze({
  "/experiments/rel-visual-lab/": [
    "experiments/rel-visual-lab/index.html",
    "text/html; charset=utf-8",
  ],
  [LAB]: ["experiments/rel-visual-lab/index.html", "text/html; charset=utf-8"],
  "/experiments/rel-first-lab/cli.mjs": [
    "experiments/rel-first-lab/cli.mjs",
    "text/javascript; charset=utf-8",
  ],
  "/experiments/rel-first-lab/notes.mjs": [
    "experiments/rel-first-lab/notes.mjs",
    "text/javascript; charset=utf-8",
  ],
  "/experiments/rel-first-lab/search.mjs": [
    "experiments/rel-first-lab/search.mjs",
    "text/javascript; charset=utf-8",
  ],
  "/experiments/rel-first-lab/VERIFIED_RESULTS.md": [
    "experiments/rel-first-lab/VERIFIED_RESULTS.md",
    "text/markdown; charset=utf-8",
  ],
});

export const allowedLabPaths = Object.freeze(Object.keys(SOURCES));

function respond(res, status, message, extras = {}) {
  const body = Buffer.from(message);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extras,
  });
  res.end(body);
}

export async function startLabServer({ port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("The local lab port must be an integer from 0 to 65535.");
  }
  const server = createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      respond(res, 405, "Read-only lab: use GET or HEAD.", {
        Allow: "GET, HEAD",
      });
      return;
    }
    let route;
    try {
      route = new URL(req.url, "http://127.0.0.1").pathname;
    } catch {
      respond(res, 400, "Invalid URL.");
      return;
    }
    if (route === "/") {
      res.writeHead(302, { Location: LAB, "Cache-Control": "no-store" });
      res.end();
      return;
    }
    if (!Object.hasOwn(SOURCES, route)) {
      respond(res, 404, "Not part of this learning lab.");
      return;
    }
    const [relativePath, mime] = SOURCES[route];
    try {
      const data = await readFile(resolve(REPO, relativePath));
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": data.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        // Only our local page and its inline learning script can run.
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      respond(res, 500, "A bundled lab file could not be loaded.");
    }
  });

  await new Promise((resolveReady, rejectReady) => {
    const onError = (error) => rejectReady(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveReady();
    });
  });

  return { server, url: "http://127.0.0.1:" + server.address().port + LAB };
}

/** Only a fixed loopback URL produced by startLabServer reaches the opener. */
export function openLabInBrowser(url) {
  const platform = process.platform;
  const spec =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd.exe", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(spec[0], spec[1], {
    stdio: "ignore",
    detached: platform !== "win32",
    windowsHide: true,
  });
  child.on("error", () => {
    console.error(
      "Browser could not be opened automatically. Copy the printed local URL instead.",
    );
  });
  child.unref();
}
