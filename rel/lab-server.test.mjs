import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { startLabServer, allowedLabPaths } from "./lab-server.mjs";
import { NOTES } from "../experiments/rel-first-lab/notes.mjs";
import { searchNotes } from "../experiments/rel-first-lab/search.mjs";

let lab;
let origin;
before(async () => {
  lab = await startLabServer();
  origin = new URL(lab.url).origin;
});
after(async () => {
  if (lab)
    await new Promise((resolveClose, rejectClose) => {
      lab.server.close((error) =>
        error ? rejectClose(error) : resolveClose(),
      );
    });
});

test("the lab binds only to the local machine with an ephemeral port", () => {
  assert.equal(lab.server.address().address, "127.0.0.1");
  assert.ok(lab.server.address().port > 0);
  assert.equal(
    new URL(lab.url).pathname,
    "/experiments/rel-visual-lab/index.html",
  );
});

test("a beginner can reach the lab with one local URL", async () => {
  const result = await fetch(origin + "/", { redirect: "manual" });
  assert.equal(result.status, 302);
  assert.equal(
    result.headers.get("location"),
    "/experiments/rel-visual-lab/index.html",
  );

  const page = await fetch(lab.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  const content = await page.text();
  assert.match(
    content,
    /You do <strong>not<\/strong> need to know programming/,
  );
  assert.match(content, /<details class="dictionary">/);
  assert.match(
    content,
    /import \{ NOTES \} from "\.\.\/rel-first-lab\/notes\.mjs"/,
  );
  assert.match(
    content,
    /import \{ searchNotes \} from "\.\.\/rel-first-lab\/search\.mjs"/,
  );
  assert.match(
    content,
    /hypothetical tag-first ranking|matching a tag is more important/,
  );
  assert.match(content, /cli\.mjs.*line 1.*notes\.mjs/);
  assert.match(
    page.headers.get("content-security-policy"),
    /connect-src 'none'/,
  );
});

test("all offered source links point to real allowlisted local files", async () => {
  for (const path of allowedLabPaths) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok((await response.arrayBuffer()).byteLength > 0, path);
  }
});

test("the browser receives exact source-owned search modules", async () => {
  for (const name of ["cli.mjs", "notes.mjs", "search.mjs"]) {
    const res = await fetch(origin + "/experiments/rel-first-lab/" + name);
    const expected = await readFile(
      resolve("experiments/rel-first-lab", name),
      "utf8",
    );
    assert.equal(await res.text(), expected);
    assert.match(res.headers.get("content-type"), /^text\/javascript/);
  }
});

test("the actual ranking rule matches the lesson's example", () => {
  assert.deepEqual(
    searchNotes(NOTES, "bridge").map((note) => note.title),
    ["Bridge Patterns", "Signal Bridge", "Local Cache"],
  );
  assert.deepEqual(
    searchNotes(NOTES, "  BRIDGE  ").map((note) => note.title),
    ["Bridge Patterns", "Signal Bridge", "Local Cache"],
  );
});

test("the lab cannot serve arbitrary repository files or endpoints", async () => {
  for (const path of [
    "/README.md",
    "/AGENTS.md",
    "/.env",
    "/experiments/rel-visual-lab/secrets.txt",
    "/experiments/rel-first-lab/verify.mjs",
    "/%2e%2e/%2e%2e/README.md",
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 404, path);
  }
  const forbidden = await fetch(origin + "/", { method: "POST" });
  assert.equal(forbidden.status, 405);
  assert.equal(forbidden.headers.get("allow"), "GET, HEAD");
});

test("HEAD returns the document metadata without a body", async () => {
  const result = await fetch(lab.url, { method: "HEAD" });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), "");
  assert.ok(Number(result.headers.get("content-length")) > 0);
});

test("bad ports fail before opening a listener", async () => {
  await assert.rejects(
    () => startLabServer({ port: -2 }),
    /integer from 0 to 65535/,
  );
  await assert.rejects(
    () => startLabServer({ port: 65536 }),
    /integer from 0 to 65535/,
  );
});
