import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  approveLink,
  performLink,
  planLink,
  referencedResources,
} from "./links.mjs";
import { startStudio } from "./server.mjs";

const lookup = async () => [{ address: "1.1.1.1", family: 4 }];

function ustar(name, content) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  Buffer.from(content).copy(body);
  return Buffer.concat([header, body]);
}

test("a GitHub link is a shallow clone plan and does not fetch", () => {
  const plan = planLink(
    "https://github.com/gryszzz/reverse-engineer-everything",
  );
  assert.equal(plan.kind, "git");
  assert.equal(
    plan.requests[0].url,
    "https://github.com/gryszzz/reverse-engineer-everything.git",
  );
  assert.equal(plan.executes, false);
  assert.ok(plan.git.argv.includes("--depth"));
  assert.equal(plan.plan_digest, planLink(plan.input).plan_digest);
});

test("http, credentials, and loopback links are refused before a plan exists", () => {
  assert.throws(
    () => planLink("http://github.com/gryszzz/reverse-engineer-everything"),
    /https/,
  );
  assert.throws(
    () => planLink("https://user:secret@github.com/a/b.git"),
    /credentials/,
  );
  assert.throws(() => planLink("https://127.0.0.1/app.wasm"), /public address/);
  assert.throws(
    () => planLink("https://169.254.169.254/latest"),
    /public address/,
  );
});

test("an npm name pins the registry host", () => {
  const plan = planLink("left-pad");
  assert.equal(plan.kind, "npm");
  assert.equal(plan.requests[0].url, "https://registry.npmjs.org/left-pad");
  assert.match(plan.requests[1].purpose, /registry\.npmjs\.org/);
  assert.equal(plan.requests[1].exact, false);
});

test("approval must be true and must match the digest", () => {
  const plan = planLink("left-pad");
  assert.throws(
    () =>
      approveLink({
        input: plan.input,
        approved: false,
        planDigest: plan.plan_digest,
      }),
    /approve this fetch/,
  );
  assert.throws(
    () =>
      approveLink({
        input: plan.input,
        approved: true,
        planDigest: "0".repeat(64),
      }),
    /exact fetch plan/,
  );
});

test("a direct download is stored, hashed, and not executed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ree-link-"));
  const bytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  const plan = approveLink({
    input: "https://example.com/app.wasm",
    approved: true,
    planDigest: planLink("https://example.com/app.wasm").plan_digest,
  });
  let fetches = 0;
  const saved = await performLink(plan, {
    destination: join(root, "out"),
    lookup,
    fetch: async () => {
      fetches += 1;
      return new Response(bytes);
    },
    spawn: () => {
      throw new Error("downloaded bytes must not be executed");
    },
  });
  assert.equal(fetches, 1);
  assert.equal(saved.executes, false);
  assert.equal(
    saved.fetches[0].sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(statSync(saved.path).mode & 0o111, 0);
  assert.equal(readFileSync(saved.path).equals(bytes), true);
  rmSync(root, { recursive: true, force: true });
});

test("a private address is refused before the request is sent", async () => {
  const plan = approveLink({
    input: "https://example.com/app.wasm",
    approved: true,
    planDigest: planLink("https://example.com/app.wasm").plan_digest,
  });
  const root = mkdtempSync(join(tmpdir(), "ree-link-private-"));
  await assert.rejects(
    () =>
      performLink(plan, {
        destination: join(root, "out"),
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        fetch: async () => {
          throw new Error("fetch should not run");
        },
      }),
    /non-public/,
  );
  assert.equal(existsSync(join(root, "out")), false);
  rmSync(root, { recursive: true, force: true });
});

test("an npm tarball is unpacked as source and not installed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ree-link-npm-"));
  const archive = gzipSync(
    Buffer.concat([
      ustar("package/package.json", '{"name":"left-pad"}\n'),
      ustar("package/index.js", "module.exports = function () {};\n"),
      Buffer.alloc(1024),
    ]),
  );
  const plan = approveLink({
    input: "left-pad",
    approved: true,
    planDigest: planLink("left-pad").plan_digest,
  });
  const bodies = new Map([
    [
      "https://registry.npmjs.org/left-pad",
      JSON.stringify({
        dist: {
          tarball: "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",
        },
      }),
    ],
    ["https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz", archive],
  ]);
  const saved = await performLink(plan, {
    destination: join(root, "out"),
    lookup,
    fetch: async (url) => new Response(bodies.get(url)),
    spawn: () => {
      throw new Error("npm install must not run");
    },
  });
  assert.equal(saved.fetches.length, 2);
  assert.equal(
    readFileSync(join(saved.path, "package/package.json"), "utf8").includes(
      "left-pad",
    ),
    true,
  );
  assert.equal(statSync(join(saved.path, "package/index.js")).mode & 0o111, 0);
  rmSync(root, { recursive: true, force: true });
});

test("a tarball URL on another host is not fetched", async () => {
  const plan = approveLink({
    input: "left-pad",
    approved: true,
    planDigest: planLink("left-pad").plan_digest,
  });
  const root = mkdtempSync(join(tmpdir(), "ree-link-host-"));
  const seen = [];
  await assert.rejects(
    () =>
      performLink(plan, {
        destination: join(root, "out"),
        lookup,
        fetch: async (url) => {
          seen.push(url);
          return new Response(
            JSON.stringify({
              dist: { tarball: "https://evil.example/pkg.tgz" },
            }),
          );
        },
      }),
    /registry\.npmjs\.org/,
  );
  assert.deepEqual(seen, ["https://registry.npmjs.org/left-pad"]);
  rmSync(root, { recursive: true, force: true });
});

test("page scripts are the referenced https URLs only", () => {
  const html =
    '<script src="/app.js"></script><script src="https://cdn.example/lib.js"></script><script>var local = 1;</script>';
  assert.deepEqual(referencedResources(html, "https://example.com/dir/page"), [
    "https://example.com/app.js",
    "https://cdn.example/lib.js",
  ]);
});

test("the studio link routes reject an unapproved fetch", async () => {
  const root = mkdtempSync(join(tmpdir(), "ree-link-api-"));
  const studio = await startStudio({ dataDir: join(root, "data") });
  const origin = studio.url.slice(0, -1);
  const call = async (path, body) => {
    const response = await fetch(origin + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ree-studio-token": studio.token,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const project = await call("/api/projects", {
      name: "Links",
      question: "What is this?",
      mode: "simple",
    });
    const input = "https://github.com/gryszzz/reverse-engineer-everything";
    const plan = await call(`/api/projects/${project.body.id}/links/plan`, {
      input,
    });
    assert.equal(plan.status, 201);
    assert.equal(plan.body.kind, "git");
    assert.equal(plan.body.executes, false);
    const refused = await call(`/api/projects/${project.body.id}/links`, {
      input,
      approved: false,
      plan_digest: plan.body.plan_digest,
    });
    assert.equal(refused.status, 403);
    const mismatch = await call(`/api/projects/${project.body.id}/links`, {
      input,
      approved: true,
      plan_digest: "0".repeat(64),
    });
    assert.equal(mismatch.status, 409);
    const stored = await fetch(`${origin}/api/projects/${project.body.id}`, {
      headers: { "x-ree-studio-token": studio.token },
    });
    const projectBody = await stored.json();
    assert.equal(projectBody.artifacts.length, 0);
  } finally {
    studio.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
