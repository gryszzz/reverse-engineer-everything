import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTarget, renderPlan, availableCategories } from "./intake.mjs";

const root = mkdtempSync(join(tmpdir(), "rel-intake-tests-"));
const put = (name, bytes) => {
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
};
const site = join(root, "project");
mkdirSync(site);
put("project/package.json", "{}");
put("example.js", "export const answer = 42;");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

test("recognizes a local JavaScript project without executing anything", () => {
  const r = classifyTarget(site);
  assert.equal(r.kind, "javascript");
  assert.equal(r.input_type, "directory");
  assert.equal(r.capability, "static-supported");
});
test("recognizes JavaScript source file", () =>
  assert.equal(classifyTarget(join(root, "example.js")).kind, "javascript"));
test("recognizes ELF signature over misleading extension", () => {
  const r = classifyTarget(
    put("pretend.txt", Buffer.from([127, 69, 76, 70, 2, 1, 1, 0])),
  );
  assert.equal(r.kind, "native");
  assert.match(r.basis, /ELF/);
});
test("a .dll is not assumed to be managed", () => {
  const r = classifyTarget(put("maybe.dll", Buffer.from("MZ000")));
  assert.equal(r.kind, "managed");
  assert.equal(r.capability, "verify-format");
});
test("recognizes wasm header", () =>
  assert.equal(
    classifyTarget(
      put("module.dat", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])),
    ).kind,
    "wasm",
  ));
test("recognizes sqlite header", () =>
  assert.equal(
    classifyTarget(put("notes.dat", Buffer.from("SQLite format 3\0rest"))).kind,
    "sqlite",
  ));
test("classifies Android artifact conservatively", () =>
  assert.equal(
    classifyTarget(put("test.apk", Buffer.from("PK\u0003\u0004"))).kind,
    "android",
  ));
test("classifies a HAR as recorded network capture, not a live fetch", () =>
  assert.equal(classifyTarget(put("trace.har", "{}")).kind, "network"));
test("treats a valid URL as a preview without requesting it", () => {
  const r = classifyTarget("https://example.org/demo");
  assert.equal(r.kind, "website");
  assert.equal(r.exists, null);
  assert.match(renderPlan(r), /Preview only/);
});
test("rejects credential-carrying URLs", () =>
  assert.throws(
    () => classifyTarget("https://john:secret@example.org/"),
    /credentials/,
  ));
test("rejects unsupported schemes", () =>
  assert.throws(() => classifyTarget("ftp://example.org/resource"), /HTTP/));
test("refuses symbolic links", () => {
  symlinkSync(join(root, "example.js"), join(root, "link.js"));
  assert.throws(() => classifyTarget(join(root, "link.js")), /Symbolic/);
});
test("refuses missing path and file-like special target", () =>
  assert.throws(() => classifyTarget(join(root, "absent")), /not found/));
test("unknown inputs stay unknown", () =>
  assert.equal(
    classifyTarget(put("sketch.unknown", "data")).capability,
    "unknown",
  ));
test("category list is broad but transparent about prerequisites", () => {
  const all = availableCategories();
  assert.ok(all.length >= 9);
  assert.ok(all.some((c) => c.kind === "firmware"));
  assert.ok(all.some((c) => c.capability === "unknown"));
});
test("entrypoint displays safe JSON preview", () => {
  const bin = fileURLToPath(new URL("../ree.mjs", import.meta.url));
  const output = execFileSync(
    process.execPath,
    [bin, "inspect", site, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(JSON.parse(output).execution, "preview-only");
});
test("entrypoint cannot execute arbitrary targets with --run", () => {
  const bin = fileURLToPath(new URL("../ree.mjs", import.meta.url));
  assert.throws(
    () =>
      execFileSync(process.execPath, [bin, "inspect", site, "--run"], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    /Analysis execution is only enabled/,
  );
});

test("legacy entrypoint forwards to the same REE interface", () => {
  const current = fileURLToPath(new URL("../ree.mjs", import.meta.url));
  const legacy = fileURLToPath(new URL("../rel.mjs", import.meta.url));
  const a = spawnSync(process.execPath, [current, "--help"], {
    encoding: "utf8",
  });
  const b = spawnSync(process.execPath, [legacy, "--help"], {
    encoding: "utf8",
  });
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.equal(b.stdout, a.stdout);
  assert.match(a.stdout, /REE/);
  assert.match(a.stdout, /node ree\.mjs/);
});
