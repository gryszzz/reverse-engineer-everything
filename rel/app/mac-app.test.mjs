import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildMacApp,
  macosSwiftArgs,
  macosSwiftEnv,
  resolveMacosSdk,
  resolveSwiftc,
} from "./build-mac-app.mjs";
import { installMacApp } from "./install-mac-app.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ree = join(repositoryRoot, "ree.mjs");

function temp(name) {
  return mkdtempSync(join(tmpdir(), `ree-app-${name}-`));
}

function runLauncher(app, env, timeout = 20000) {
  return spawnSync(join(app, "Contents", "MacOS", "REE"), [], {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    env,
  });
}

test("layout build records the REE bundle identity and this checkout", () => {
  const directory = temp("layout");
  const built = buildMacApp({
    out: join(directory, "REE.app"),
    layoutOnly: true,
  });
  const plist = readFileSync(join(built.app, "Contents", "Info.plist"), "utf8");
  assert.match(plist, /<key>CFBundleName<\/key>\s*<string>REE<\/string>/);
  assert.match(
    plist,
    /<key>CFBundleDisplayName<\/key>\s*<string>REE<\/string>/,
  );
  assert.match(plist, /<string>io\.github\.gryszzz\.ree\.studio<\/string>/);
  assert.doesNotMatch(plist, /io\.github\.morluto/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>REE<\/string>/);
  assert.match(
    plist,
    /<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/,
  );
  assert.equal(
    statSync(join(built.app, "Contents", "MacOS", "REE")).mode & 0o111,
    0o111,
  );
  assert.equal(
    readFileSync(
      join(built.app, "Contents", "Resources", "checkout.path"),
      "utf8",
    )
      .trim()
      .replace(/\/$/, ""),
    repositoryRoot.replace(/\/$/, ""),
  );
  assert.equal(
    readFileSync(
      join(built.app, "Contents", "Resources", "node.path"),
      "utf8",
    ).trim(),
    process.execPath,
  );
  assert.equal(built.window, "not-built");
  assert.match(
    readFileSync(
      join(built.app, "Contents", "Resources", "AppIcon.svg"),
      "utf8",
    ),
    /#5ce1ff/,
  );
  const icns = readFileSync(
    join(built.app, "Contents", "Resources", "AppIcon.icns"),
  );
  assert.equal(icns.subarray(0, 4).toString(), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  rmSync(directory, { recursive: true, force: true });
});

test(
  "a non-mac build without --layout-only explains that the window is not compiled",
  {
    skip: process.platform === "darwin",
  },
  () => {
    const directory = temp("host");
    const result = spawnSync(
      process.execPath,
      [ree, "app", "build", "--out", join(directory, "REE.app"), "--json"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must be built on macOS/);
    rmSync(directory, { recursive: true, force: true });
  },
);

test("the launcher smoke-checks the local studio page and then stops", () => {
  const directory = temp("smoke");
  const data = join(directory, "data");
  const built = buildMacApp({
    out: join(directory, "REE.app"),
    layoutOnly: true,
  });
  const result = runLauncher(built.app, {
    ...process.env,
    HOME: directory,
    REE_APP_DATA: data,
    REE_APP_INSTANCE: join(directory, "instance.json"),
    REE_APP_SMOKE: "1",
    REE_APP_OPEN: "0",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REE smoke ok: http:\/\/127\.0\.0\.1:\d+\//);
  assert.equal(
    spawnSync(process.execPath, [
      "-e",
      "fetch(process.argv[1]).then(()=>process.exit(0)).catch(()=>process.exit(1))",
      result.stdout.match(/http:\/\/127\.0\.0\.1:\d+\//)[0],
    ]).status,
    1,
  );
  rmSync(directory, { recursive: true, force: true });
});

test("a missing Node.js binary is reported without starting the studio", () => {
  const directory = temp("node");
  const built = buildMacApp({
    out: join(directory, "REE.app"),
    layoutOnly: true,
  });
  const result = runLauncher(built.app, {
    PATH: "/usr/bin:/bin",
    HOME: directory,
    REE_NODE: join(directory, "missing-node"),
    REE_APP_SKIP_LOGIN_SHELL: "1",
    REE_APP_DATA: join(directory, "data"),
    REE_APP_INSTANCE: join(directory, "instance.json"),
    REE_APP_SMOKE: "1",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not find Node\.js/);
  assert.match(result.stderr, /\.nvmrc/);
  assert.match(result.stderr, /node ree\.mjs app build/);
  rmSync(directory, { recursive: true, force: true });
});

test("the launcher refuses a studio data directory inside the checkout", () => {
  const directory = temp("inside");
  const built = buildMacApp({
    out: join(directory, "REE.app"),
    layoutOnly: true,
  });
  const result = runLauncher(built.app, {
    ...process.env,
    HOME: directory,
    REE_APP_DATA: repositoryRoot,
    REE_APP_INSTANCE: join(directory, "instance.json"),
    REE_APP_SMOKE: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the REE checkout/);
  rmSync(directory, { recursive: true, force: true });
});

test("a second launch sees the running instance and does not replace it", async () => {
  const directory = temp("once");
  const built = buildMacApp({
    out: join(directory, "REE.app"),
    layoutOnly: true,
  });
  const env = {
    ...process.env,
    HOME: directory,
    REE_APP_DATA: join(directory, "data"),
    REE_APP_INSTANCE: join(directory, "instance.json"),
    REE_APP_OPEN: "0",
  };
  const child = spawn(join(built.app, "Contents", "MacOS", "REE"), [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const started = Date.now();
  while (
    !output.includes("Open this local address") &&
    Date.now() - started < 15000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(output, /Open this local address: http:\/\/127\.0\.0\.1:\d+\//);
  const second = runLauncher(built.app, env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(
    second.stdout,
    /REE is already running: http:\/\/127\.0\.0\.1:\d+\//,
  );
  child.kill("SIGKILL");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  assert.equal(exited, true);
  rmSync(directory, { recursive: true, force: true });
});

test("macOS dialogs are detached so a click cannot stall the launcher", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./mac/ree-launcher.sh", import.meta.url)),
    "utf8",
  );
  const invocations = source
    .split("\n")
    .filter((line) => line.includes("osascript -e"));
  assert.ok(invocations.length >= 1);
  for (const line of invocations) assert.match(line, /&\s*$/);
});

test("install copies the bundle and links it from the Desktop home", () => {
  const directory = temp("install");
  const home = join(directory, "home");
  const built = buildMacApp({
    out: join(directory, "REE.app"),
    layoutOnly: true,
  });
  const result = spawnSync(
    process.execPath,
    [ree, "app", "install", "--app", built.app, "--home", home, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const installed = JSON.parse(result.stdout);
  assert.equal(
    installed.alias_kind,
    process.platform === "darwin" ? installed.alias_kind : "symlink",
  );
  assert.equal(installed.app, join(home, "Applications", "REE.app"));
  assert.equal(
    statSync(join(installed.app, "Contents", "MacOS", "REE")).mode & 0o111,
    0o111,
  );
  if (installed.alias_kind === "symlink")
    assert.equal(readlinkSync(installed.alias), installed.app);
  rmSync(directory, { recursive: true, force: true });
});

function swiftResult({ status = 0, stdout = "", error = null } = {}) {
  return { status, stdout, stderr: "", error };
}

test("swiftc on PATH is used without asking xcrun", () => {
  const calls = [];
  const compiler = resolveSwiftc((command, args) => {
    calls.push([command, ...args]);
    return swiftResult({ stdout: "Apple Swift" });
  });
  assert.equal(compiler, "swiftc");
  assert.deepEqual(calls, [["swiftc", "--version"]]);
});

test("swiftc is taken from xcrun -f when it is absent from PATH", () => {
  const compiler = resolveSwiftc((command, args) => {
    if (command === "swiftc" && args[0] === "--version")
      return swiftResult({ status: null, error: { code: "ENOENT" } });
    if (command === "xcrun" && args[0] === "-f")
      return swiftResult({
        stdout: "/Library/Developer/CommandLineTools/usr/bin/swiftc\n",
      });
    if (command === "/Library/Developer/CommandLineTools/usr/bin/swiftc")
      return swiftResult({ stdout: "Apple Swift version 6" });
    return swiftResult({ status: 1 });
  });
  assert.equal(compiler, "/Library/Developer/CommandLineTools/usr/bin/swiftc");
});

test("swiftc falls through to xcrun --sdk macosx when the default lookup misses", () => {
  const calls = [];
  const compiler = resolveSwiftc((command, args) => {
    calls.push([command, ...args]);
    if (command === "swiftc")
      return swiftResult({ status: null, error: { code: "ENOENT" } });
    if (args[0] === "-f") return swiftResult({ status: 1, stdout: "" });
    if (args[0] === "--sdk" && args[1] === "macosx")
      return swiftResult({
        stdout: "/Library/Developer/CommandLineTools/usr/bin/swiftc\n",
      });
    if (String(command).endsWith("/swiftc"))
      return swiftResult({ stdout: "Apple Swift" });
    return swiftResult({ status: 1 });
  });
  assert.equal(compiler, "/Library/Developer/CommandLineTools/usr/bin/swiftc");
  assert.deepEqual(calls[2], ["xcrun", "--sdk", "macosx", "-f", "swiftc"]);
});

test("a missing swiftc names both xcrun lookups", () => {
  assert.throws(
    () =>
      resolveSwiftc(() =>
        swiftResult({ status: null, error: { code: "ENOENT" } }),
      ),
    /xcrun -f swiftc[\s\S]*xcrun --sdk macosx -f swiftc/,
  );
});

test("swiftc receives SDKROOT from xcrun even when swiftc is on PATH", () => {
  const sdk = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
  const resolved = resolveMacosSdk((command, args) => {
    assert.deepEqual(args, ["--sdk", "macosx", "--show-sdk-path"]);
    if (command === "xcrun") return swiftResult({ stdout: `${sdk}\n` });
    return swiftResult({ status: null, error: { code: "ENOENT" } });
  });
  assert.equal(resolved, sdk);
  const env = macosSwiftEnv(sdk, { PATH: "/usr/bin" });
  assert.equal(env.SDKROOT, sdk);
  assert.equal(env.PATH, "/usr/bin");
  const args = macosSwiftArgs({
    sdk,
    arch: "arm64",
    output: "/tmp/REEWindow-arm64",
    source: "/tmp/REEWindow.swift",
  });
  assert.deepEqual(args.slice(0, 2), ["-sdk", sdk]);
  assert.ok(args.includes("arm64-apple-macos12.0"));
});

test("a missing macOS SDK is reported instead of compiling without SDKROOT", () => {
  assert.throws(
    () =>
      resolveMacosSdk(() =>
        swiftResult({ status: 1, stdout: "", error: null }),
      ),
    /xcrun --sdk macosx --show-sdk-path/,
  );
});

test("a failed mac build removes the partial REE.app", () => {
  const directory = temp("partial");
  const out = join(directory, "REE.app");
  // A real darwin build succeeds on the macOS runner. Inject the tool failure
  // so cleanup is tested on every host, including one that has swiftc.
  assert.throws(
    () =>
      buildMacApp({
        out,
        platform: "darwin",
        spawn: () => ({
          status: 1,
          stdout: "",
          stderr: "injected tool failure",
          error: null,
        }),
      }),
    /sips could not size the REE icon|swiftc was not found/,
  );
  assert.equal(existsSync(out), false);
  const built = buildMacApp({
    out,
    layoutOnly: true,
  });
  assert.equal(existsSync(built.app), true);
  rmSync(directory, { recursive: true, force: true });
});

test("a Finder alias that ignores SIGTERM falls back to a symlink", () => {
  const directory = temp("alias-deadline");
  const home = join(directory, "home");
  const built = buildMacApp({
    out: join(directory, "REE.app"),
    layoutOnly: true,
  });
  const started = Date.now();
  const installed = installMacApp({
    app: built.app,
    home,
    platform: "darwin",
    spawn: (command, args, options) => {
      assert.equal(command, "osascript");
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(options.stdio, "ignore");
      assert.ok(options.timeout <= 5000);
      return spawnSync(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        {
          timeout: 1000,
          killSignal: "SIGKILL",
          stdio: "ignore",
        },
      );
    },
  });
  assert.ok(Date.now() - started < 8000);
  assert.equal(installed.alias_kind, "symlink");
  assert.equal(readlinkSync(installed.alias), installed.app);
  rmSync(directory, { recursive: true, force: true });
});

test("app commands reject analysis flags", () => {
  const result = spawnSync(
    process.execPath,
    [ree, "app", "build", "--authorized", "--layout-only"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /app build/);
  const help = spawnSync(process.execPath, [ree, "--help"], {
    encoding: "utf8",
  });
  assert.match(help.stdout, /node ree\.mjs app build/);
  assert.match(help.stdout, /node ree\.mjs app install/);
});
