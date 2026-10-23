import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { selectCrawlLinks } from "./crawl.mjs";
import { detectInput } from "./detect.mjs";
import { readSource } from "./run.mjs";

const execFileAsync = promisify(execFile);
const repo = fileURLToPath(new URL("../..", import.meta.url));

function scratch() {
  return mkdtempSync(join(tmpdir(), "ree-read-"));
}

function responseFor(body, status = 200, type = "text/plain; charset=utf-8") {
  const text = typeof body === "string" ? body : "";
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(text);
  return {
    status,
    headers: {
      forEach(fn) {
        fn(type, "content-type");
      },
    },
    async text() {
      return bytes.toString("utf8");
    },
    async arrayBuffer() {
      return bytes;
    },
  };
}

function scriptedFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const hit = routes.get(String(url));
    if (!hit) return responseFor("", 404);
    return hit;
  };
  return { fetchImpl, calls };
}

function tarGz(files) {
  const chunks = [];
  for (const file of files) {
    const content = Buffer.from(file.content);
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100, "utf8");
    header.write(content.length.toString(8).padStart(11, "0"), 124, "utf8");
    header[156] = 48;
    chunks.push(header, content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function githubContent(text) {
  return responseFor(
    JSON.stringify({
      encoding: "base64",
      content: Buffer.from(text).toString("base64"),
    }),
    200,
    "application/json",
  );
}

test("detects each public input kind", () => {
  assert.equal(detectInput("npm:@scope/ledger-kit").kind, "npm");
  assert.equal(detectInput("npm:@scope/ledger-kit").ok, true);
  assert.equal(detectInput("npm:Not A Name").ok, false);
  const github = detectInput("https://github.com/acme/notes.git");
  assert.equal(github.kind, "github");
  assert.equal(github.owner, "acme");
  assert.equal(github.repo, "notes");
  assert.equal(detectInput("https://github.com/login").ok, false);
  assert.equal(detectInput("https://github.com/acme").ok, false);
  assert.equal(
    detectInput("https://www.npmjs.com/package/@scope/ledger-kit").name,
    "@scope/ledger-kit",
  );
  assert.equal(
    detectInput("https://registry.npmjs.org/ledger-kit").kind,
    "npm",
  );
  assert.equal(detectInput("https://notes.example/pricing").kind, "website");
  const root = scratch();
  try {
    writeFileSync(join(root, "pack.tgz"), tarGz([]));
    mkdirSync(join(root, "app"));
    assert.equal(detectInput(join(root, "pack.tgz")).kind, "npm-tarball");
    assert.equal(detectInput(join(root, "app")).kind, "directory");
    assert.equal(detectInput(join(root, "missing")).kind, "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(detectInput("http://127.0.0.1/secret").ok, false);
  assert.equal(detectInput("https://user:pass@notes.example/a").ok, false);
});

test("selects docs and pricing links and skips the rest", () => {
  const html = `
    <a href="/docs">Docs</a>
    <a href="/pricing">Pricing</a>
    <a href="/features">Features</a>
    <a href="https://other.example/docs">Offsite</a>
    <a href="/app.js">Script</a>
    <a href="https://user:pass@notes.example/docs">Creds</a>
    <a href="/about">About</a>
    <a href="/developers">One</a>
    <a href="/changelog">Two</a>
    <a href="/api">Three</a>
    <a href="/docs/extra">Four</a>
  `;
  const result = selectCrawlLinks(html, "https://notes.example/", 6);
  assert.deepEqual(
    result.selected.map((link) => link.url),
    [
      "https://notes.example/docs",
      "https://notes.example/pricing",
      "https://notes.example/features",
      "https://notes.example/developers",
      "https://notes.example/changelog",
      "https://notes.example/api",
    ],
  );
  assert.equal(
    result.selected.find((link) => link.url.endsWith("/pricing")).role,
    "pricing",
  );
  const reasons = result.skipped.map((item) => item.reason).join("\n");
  assert.match(reasons, /different origin/);
  assert.match(reasons, /Source and binary/);
  assert.match(reasons, /username or password/);
  assert.match(reasons, /not a docs/);
  assert.match(reasons, /Past the 6 page crawl limit/);
});

test("crawls a public site inside robots rules and records skips", async () => {
  const pages = new Map([
    [
      "https://notes.example/robots.txt",
      responseFor("User-agent: *\nAllow: /\n"),
    ],
    [
      "https://notes.example/",
      responseFor(
        `<h2>Shared boards</h2><p>People keep notes on a shared board.</p>
         <a href="/docs">Docs</a>
         <a href="/pricing">Pricing</a>
         <a href="https://other.example/docs">Offsite</a>`,
        200,
        "text/html",
      ),
    ],
    [
      "https://notes.example/docs",
      responseFor(
        "<h2>Public API</h2><p>The public API lists boards.</p>",
        200,
        "text/html",
      ),
    ],
    [
      "https://notes.example/pricing",
      responseFor(
        "<h2>Team</h2><p>The team plan is 12 dollars a month.</p>",
        200,
        "text/html",
      ),
    ],
  ]);
  const { fetchImpl, calls } = scriptedFetch(pages);
  const out = scratch();
  try {
    const result = await readSource({
      input: "https://notes.example/",
      outDir: out,
      fetchImpl,
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.read.detected, "website");
    assert.equal(result.read.network, true);
    assert.ok(
      result.spec.features.some((feature) => feature.name === "Shared boards"),
    );
    assert.ok(
      result.spec.features.some((feature) => feature.name === "Public API"),
    );
    assert.ok(
      result.read.skipped.some((item) => /different origin/.test(item.reason)),
    );
    assert.ok(
      result.read.read.every((source) => source.sha256 && source.fetched_at),
    );
    assert.match(result.read.note, /not a percentage/);
    assert.equal(result.read.coverage.documents_read, result.read.read.length);
    const saved = JSON.parse(readFileSync(join(out, "read.json"), "utf8"));
    assert.equal(saved.schema_version, "ree.read.v1");
    assert.ok(calls.some((call) => call.url === "https://notes.example/docs"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("does not fetch a page whose robots.txt disallows it", async () => {
  const { fetchImpl, calls } = scriptedFetch(
    new Map([
      [
        "https://notes.example/robots.txt",
        responseFor("User-agent: *\nDisallow: /\n"),
      ],
      ["https://notes.example/", responseFor("<h2>Hidden</h2><p>No.</p>")],
    ]),
  );
  const out = scratch();
  try {
    const result = await readSource({
      input: "https://notes.example/",
      outDir: out,
      fetchImpl,
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    assert.equal(result.exitCode, 3);
    assert.ok(calls.every((call) => call.url.endsWith("/robots.txt")));
    assert.match(
      result.read.skipped.map((item) => item.reason).join("\n"),
      /disallows/,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("reads OpenAPI, GraphQL, and Postman without keeping the token", async () => {
  const root = scratch();
  const out = scratch();
  const token = "super-secret-token";
  try {
    writeFileSync(
      join(root, "openapi.yaml"),
      "openapi: 3.0.3\ninfo:\n  title: Notes\n  version: '1'\npaths:\n  /boards:\n    get:\n      operationId: listBoards\n      responses:\n        '200':\n          description: ok\n",
    );
    writeFileSync(
      join(root, "schema.graphql"),
      "type Query { boards: [Board] }\ntype Mutation { createBoard(name: String): Board }\n",
    );
    writeFileSync(
      join(root, "notes.postman_collection.json"),
      JSON.stringify({
        info: {
          name: "Notes",
          schema:
            "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        auth: { type: "bearer", bearer: [{ key: "token", value: token }] },
        item: [
          {
            name: "List boards",
            request: {
              method: "GET",
              header: [{ key: "Authorization", value: `Bearer ${token}` }],
              url: "https://notes.example/boards",
            },
          },
        ],
      }),
    );
    const openapi = await readSource({
      input: join(root, "openapi.yaml"),
      outDir: join(out, "openapi"),
      name: "Notes API",
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    assert.equal(openapi.spec.api.style, "openapi");
    assert.ok(
      openapi.spec.api.endpoints.some(
        (endpoint) => endpoint.method === "GET" && endpoint.path === "/boards",
      ),
    );
    const graphql = await readSource({
      input: join(root, "schema.graphql"),
      outDir: join(out, "graphql"),
      name: "Notes Graph",
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    assert.equal(graphql.spec.api.style, "graphql");
    assert.ok(
      graphql.spec.api.endpoints.some(
        (endpoint) => endpoint.path === "query.boards",
      ),
    );
    assert.ok(
      graphql.spec.api.endpoints.some(
        (endpoint) => endpoint.path === "mutation.createBoard",
      ),
    );
    const postman = await readSource({
      input: join(root, "notes.postman_collection.json"),
      outDir: join(out, "postman"),
      name: "Notes Collection",
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    assert.equal(postman.spec.api.style, "postman");
    assert.ok(
      postman.spec.api.endpoints.some(
        (endpoint) => endpoint.method === "GET" && endpoint.path === "/boards",
      ),
    );
    const packed = JSON.stringify(postman.spec) + JSON.stringify(postman.read);
    assert.equal(packed.includes(token), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("reads an npm README and declaration names, not implementation source", async () => {
  const secret = "IMPL_SECRET_LINE";
  const packed = tarGz([
    {
      name: "package/package.json",
      content: JSON.stringify({ name: "ledger-kit" }),
    },
    {
      name: "package/README.md",
      content: "# Ledger\n\n## Packed readme\n\nLocal notes.\n",
    },
    { name: "package/index.js", content: `export const hidden = "${secret}";` },
    {
      name: "package/index.d.ts",
      content: "export interface LedgerRecord { secretField: string }\n",
    },
  ]);
  const registry = {
    name: "ledger-kit",
    readme: "# Ledger kit\n\n## Shared boards\n\nPeople keep notes.\n",
    license: "MIT",
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": {
        name: "ledger-kit",
        license: "MIT",
        dist: {
          tarball:
            "https://registry.npmjs.org/ledger-kit/-/ledger-kit-1.0.0.tgz",
        },
      },
    },
  };
  const { fetchImpl, calls } = scriptedFetch(
    new Map([
      [
        "https://registry.npmjs.org/ledger-kit",
        responseFor(JSON.stringify(registry), 200, "application/json"),
      ],
      [
        "https://registry.npmjs.org/ledger-kit/-/ledger-kit-1.0.0.tgz",
        responseFor(packed, 200, "application/octet-stream"),
      ],
    ]),
  );
  const out = scratch();
  try {
    const result = await readSource({
      input: "npm:ledger-kit",
      outDir: out,
      fetchImpl,
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    const packedText =
      JSON.stringify(result.spec) + JSON.stringify(result.read);
    assert.equal(result.exitCode, 0);
    assert.ok(
      result.spec.features.some((feature) => feature.name === "Shared boards"),
    );
    assert.ok(
      result.spec.features.some((feature) => feature.name === "LedgerRecord"),
    );
    assert.equal(packedText.includes(secret), false);
    assert.equal(packedText.includes("secretField"), false);
    assert.ok(
      result.read.skipped.some((item) =>
        /Implementation source is not copied/.test(item.reason),
      ),
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  assert.equal(calls.length, 2);
});

test("does not unpack an npm tarball without a usable license", async () => {
  const tarball = "https://registry.npmjs.org/closed/-/closed-1.0.0.tgz";
  const { fetchImpl, calls } = scriptedFetch(
    new Map([
      [
        "https://registry.npmjs.org/closed",
        responseFor(
          JSON.stringify({
            name: "closed",
            readme: "# Closed\n\n## Private notes\n\nNot unpacked.\n",
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                name: "closed",
                license: "UNLICENSED",
                dist: { tarball },
              },
            },
          }),
          200,
          "application/json",
        ),
      ],
    ]),
  );
  const out = scratch();
  try {
    const result = await readSource({
      input: "npm:closed",
      outDir: out,
      fetchImpl,
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    assert.equal(
      calls.some((call) => call.url === tarball),
      false,
    );
    assert.match(
      result.read.skipped.map((item) => item.reason).join("\n"),
      /UNLICENSED/,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("reads a permissive GitHub repo and skips an unrecognized license", async () => {
  const readme = "# Notes\n\n## Shared boards\n\nPeople keep notes.\n";
  const openapi =
    "openapi: 3.0.3\ninfo:\n  title: Notes\n  version: '1'\npaths:\n  /boards:\n    get:\n      responses:\n        '200':\n          description: ok\n";
  function repo(license) {
    return responseFor(
      JSON.stringify({
        full_name: "acme/notes",
        private: false,
        license: license ? { spdx_id: license } : null,
      }),
      200,
      "application/json",
    );
  }
  const allowed = scriptedFetch(
    new Map([
      ["https://api.github.com/repos/acme/notes", repo("MIT")],
      ["https://api.github.com/repos/acme/notes/readme", githubContent(readme)],
      [
        "https://api.github.com/repos/acme/notes/contents/",
        responseFor(
          JSON.stringify([
            { type: "file", name: "README.md" },
            { type: "file", name: "index.js" },
            { type: "file", name: "openapi.yaml" },
          ]),
          200,
          "application/json",
        ),
      ],
      [
        "https://api.github.com/repos/acme/notes/contents/openapi.yaml",
        githubContent(openapi),
      ],
    ]),
  );
  const out = scratch();
  try {
    const result = await readSource({
      input: "https://github.com/acme/notes",
      outDir: out,
      fetchImpl: allowed.fetchImpl,
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    assert.equal(result.exitCode, 0);
    assert.ok(
      result.spec.features.some((feature) => feature.name === "Shared boards"),
    );
    assert.ok(
      result.spec.api.endpoints.some((endpoint) => endpoint.path === "/boards"),
    );
    assert.ok(
      result.read.skipped.some((item) =>
        /Source code is not copied/.test(item.reason),
      ),
    );
    assert.ok(
      result.read.provenance.every((item) =>
        /No Authorization header/.test(item.note),
      ),
    );
    for (const call of allowed.calls) {
      const headers = call.headers;
      assert.equal(headers.authorization, undefined);
      assert.equal(headers.Authorization, undefined);
    }
    assert.equal(
      allowed.calls.some((call) => call.url.includes("index.js")),
      false,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }

  const blocked = scriptedFetch(
    new Map([["https://api.github.com/repos/acme/notes", repo("NOASSERTION")]]),
  );
  const blockedOut = scratch();
  try {
    const result = await readSource({
      input: "https://github.com/acme/notes",
      outDir: blockedOut,
      fetchImpl: blocked.fetchImpl,
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    assert.equal(blocked.calls.length, 1);
    assert.match(
      result.read.skipped.map((item) => item.reason).join("\n"),
      /NOASSERTION/,
    );
    assert.equal(result.exitCode, 3);
  } finally {
    rmSync(blockedOut, { recursive: true, force: true });
  }
});

test("reads a local project without copying source", async () => {
  const root = scratch();
  const out = scratch();
  const sourceSecret = "IMPL_SECRET_LINE";
  const typeSecret = "TYPE_BODY_SECRET";
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "field-ledger" }),
    );
    writeFileSync(
      join(root, "README.md"),
      "# Field\n\n## Shared boards\n\nPeople keep notes.\n",
    );
    writeFileSync(
      join(root, "schema.graphql"),
      "type Query { boards: [Board] }\n",
    );
    writeFileSync(
      join(root, "collection.json"),
      JSON.stringify({
        info: {
          schema:
            "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        item: [
          {
            name: "List boards",
            request: { method: "POST", url: "https://notes.example/boards" },
          },
        ],
      }),
    );
    writeFileSync(
      join(root, "types.d.ts"),
      `export interface Board { token: "${typeSecret}" }\n`,
    );
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "index.js"),
      `export const x = "${sourceSecret}";`,
    );
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "left.js"), "module.exports = 1;");
    const result = await readSource({
      input: root,
      outDir: out,
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    const packed = JSON.stringify(result.spec) + JSON.stringify(result.read);
    assert.equal(result.read.detected, "directory");
    assert.equal(result.read.network, false);
    assert.equal(result.spec.target.name, "field-ledger");
    assert.ok(result.spec.features.some((feature) => feature.name === "Board"));
    assert.ok(
      result.spec.api.endpoints.some(
        (endpoint) => endpoint.path === "query.boards",
      ),
    );
    assert.ok(
      result.spec.api.endpoints.some(
        (endpoint) => endpoint.method === "POST" && endpoint.path === "/boards",
      ),
    );
    assert.equal(packed.includes(sourceSecret), false);
    assert.equal(packed.includes(typeSecret), false);
    const reasons = result.read.skipped.map((item) => item.reason).join("\n");
    assert.match(reasons, /Implementation source is not copied/);
    assert.match(reasons, /package\.json supplies the name only/);
    assert.match(reasons, /That directory is skipped/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("static JavaScript analysis stays behind --authorized and drops detail", async () => {
  const root = scratch();
  const out = scratch();
  let calls = 0;
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "desk" }));
    writeFileSync(join(root, "index.js"), "export const started = true;\n");
    const refused = await readSource({
      input: root,
      outDir: join(out, "refused"),
      analyzeImpl: async () => {
        calls += 1;
        return { behaviors: [] };
      },
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    assert.equal(calls, 0);
    assert.match(
      refused.read.skipped.map((item) => item.reason).join("\n"),
      /needs --authorized/,
    );
    const detail = "SECRET_SOURCE_LINE";
    const allowed = await readSource({
      input: root,
      outDir: join(out, "allowed"),
      authorized: true,
      analyzeImpl: async () => ({
        evidence_id: "evidence-1",
        behaviors: [{ behavior: "http-get", detail }],
      }),
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    const packed = JSON.stringify(allowed.spec) + JSON.stringify(allowed.read);
    assert.equal(packed.includes(detail), false);
    assert.ok(
      allowed.spec.features.some((feature) => feature.name === "http-get"),
    );
    assert.ok(
      allowed.read.provenance.some((item) => item.target === "evidence-1"),
    );
    assert.equal(
      allowed.read.skipped.some((item) => item.target === "evidence-1"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("does not execute a native file", async () => {
  const root = scratch();
  const out = scratch();
  try {
    writeFileSync(join(root, "tool.exe"), Buffer.from("MZ-not-a-program"));
    let fetched = false;
    const result = await readSource({
      input: join(root, "tool.exe"),
      outDir: out,
      name: "Native tool",
      fetchImpl: async () => {
        fetched = true;
        return responseFor("");
      },
      analyzeImpl: async () => {
        throw new Error("analyzer ran");
      },
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    });
    assert.equal(fetched, false);
    assert.match(
      result.read.skipped.map((item) => item.reason).join("\n"),
      /needs its REA provider/,
    );
    assert.equal(result.exitCode, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("refuses private and credential URLs before any fetch", async () => {
  for (const input of [
    "http://127.0.0.1/secret",
    "https://user:pass@notes.example/docs",
  ]) {
    let fetched = false;
    const out = scratch();
    try {
      const result = await readSource({
        input,
        outDir: out,
        name: "Refused",
        fetchImpl: async () => {
          fetched = true;
          return responseFor("");
        },
        now: () => new Date("2026-10-23T00:00:00.000Z"),
      });
      assert.equal(fetched, false);
      assert.equal(result.read.network, false);
      assert.equal(result.exitCode, 3);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
});

test("CLI help and a local folder read stay offline", async () => {
  const help = await execFileAsync(
    process.execPath,
    ["ree.mjs", "read", "--help"],
    {
      cwd: repo,
    },
  );
  assert.match(help.stdout, /no Authorization header/);
  assert.match(help.stdout, /robots\.txt/);
  assert.match(help.stdout, /not a percentage/);
  const root = scratch();
  const out = scratch();
  try {
    writeFileSync(
      join(root, "README.md"),
      "# Kit\n\n## Shared boards\n\nPeople keep notes.\n",
    );
    const run = await execFileAsync(
      process.execPath,
      ["ree.mjs", "read", root, "--out", out, "--name", "Field Kit", "--json"],
      { cwd: repo },
    );
    const report = JSON.parse(run.stdout);
    assert.equal(report.detected, "directory");
    assert.equal(report.network, false);
    assert.ok(report.coverage.features >= 1);
    assert.match(report.note, /not a percentage/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
