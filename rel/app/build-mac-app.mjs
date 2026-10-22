import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../studio/paths.mjs";

const macSource = fileURLToPath(new URL("./mac/", import.meta.url));

const hostArch = () => (process.arch === "arm64" ? "arm64" : "x86_64");

const commandText = (result) =>
  `${result.stderr || ""}${result.stdout || ""}`.trim().slice(0, 2000);

/**
 * Assemble an unsigned REE.app that launches this checkout.
 * The WebKit window is compiled only on macOS. layoutOnly skips that compile.
 */
export function buildMacApp({
  out = join(repositoryRoot, "build", "REE.app"),
  layoutOnly = false,
  platform = process.platform,
  root = repositoryRoot,
  nodePath = process.execPath,
} = {}) {
  if (!layoutOnly && platform !== "darwin") {
    throw new Error(
      "REE.app must be built on macOS so the WebKit window can be compiled. This host can assemble the bundle with node ree.mjs app build --layout-only.",
    );
  }
  const destination = resolve(out);
  if (basename(destination) !== "REE.app") {
    throw new Error("The app output path must end in REE.app.");
  }
  if (existsSync(destination)) {
    throw new Error(
      "Refusing to replace an existing REE.app. Remove it or pass a new --out path.",
    );
  }
  const contents = join(destination, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  copyFileSync(join(macSource, "Info.plist"), join(contents, "Info.plist"));
  writeFileSync(join(contents, "PkgInfo"), "APPL????");
  const launcher = join(macos, "REE");
  copyFileSync(join(macSource, "ree-launcher.sh"), launcher);
  chmodSync(launcher, 0o755);
  writeFileSync(join(resources, "checkout.path"), `${root}\n`);
  writeFileSync(join(resources, "node.path"), `${nodePath}\n`);
  copyFileSync(join(macSource, "AppIcon.svg"), join(resources, "AppIcon.svg"));
  for (const name of ["AppIcon.png", "AppIcon.icns"]) {
    const source = join(macSource, name);
    if (existsSync(source)) copyFileSync(source, join(resources, name));
  }
  if (platform === "darwin") writeNativeIcon(resources);

  let window = "not-built";
  let windowReason =
    "WebKit window was not compiled. The launcher opens the studio in the default browser.";
  let architectures = [];
  if (!layoutOnly) {
    const compiled = compileWindow(macos);
    window = "built";
    windowReason = null;
    architectures = compiled.architectures;
    if (compiled.skipped.length > 0) {
      windowReason = `Compiled ${compiled.architectures.join(", ")}. Skipped ${compiled.skipped.map((item) => item.arch).join(", ")}.`;
    }
  } else if (platform === "darwin") {
    windowReason =
      "layout-only: WebKit window was not compiled. Re-run without --layout-only on macOS.";
  } else {
    windowReason =
      "This host is not macOS, so the WebKit window was not compiled. Build on a Mac for REEWindow.";
  }
  writeFileSync(
    join(resources, "window.txt"),
    `${window}\n${windowReason ?? architectures.join(",")}\n`,
  );
  return {
    app: destination,
    window,
    window_reason: windowReason,
    architectures,
    checkout: root,
    node: nodePath,
    identifier: "io.github.gryszzz.ree.studio",
  };
}

function writeNativeIcon(resources) {
  const png = join(resources, "AppIcon.png");
  if (!existsSync(png)) return;
  const iconset = join(resources, "AppIcon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  const names = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  try {
    for (const [size, name] of names) {
      const sized = spawnSync(
        "sips",
        ["-z", String(size), String(size), png, "--out", join(iconset, name)],
        { encoding: "utf8" },
      );
      if (sized.status !== 0) {
        throw new Error(
          `sips could not size the REE icon. ${commandText(sized)}`,
        );
      }
    }
    const made = spawnSync(
      "iconutil",
      ["-c", "icns", iconset, "-o", join(resources, "AppIcon.icns")],
      { encoding: "utf8" },
    );
    if (made.status !== 0) {
      throw new Error(
        `iconutil could not write AppIcon.icns. ${commandText(made)}`,
      );
    }
  } finally {
    rmSync(iconset, { recursive: true, force: true });
  }
}

function compileWindow(macos) {
  const swift = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (swift.error?.code === "ENOENT" || swift.status !== 0) {
    throw new Error(
      "swiftc was not found. Install the Xcode Command Line Tools, then run node ree.mjs app build again.",
    );
  }
  const source = join(macSource, "REEWindow.swift");
  const built = [];
  const skipped = [];
  for (const arch of ["arm64", "x86_64"]) {
    const output = join(macos, `REEWindow-${arch}`);
    const result = spawnSync(
      "swiftc",
      [
        "-O",
        "-target",
        `${arch}-apple-macos12.0`,
        "-o",
        output,
        source,
        "-framework",
        "Cocoa",
        "-framework",
        "WebKit",
      ],
      { encoding: "utf8" },
    );
    if (result.status === 0) built.push({ arch, output });
    else skipped.push({ arch, detail: commandText(result) });
  }
  if (!built.some((item) => item.arch === hostArch())) {
    const detail = skipped
      .map((item) => `${item.arch}: ${item.detail}`)
      .join("\n");
    throw new Error(
      `swiftc did not produce a ${hostArch()} REE window.\n${detail}`,
    );
  }
  const finalPath = join(macos, "REEWindow");
  if (built.length === 1) {
    rmSync(finalPath, { force: true });
    copyFileSync(built[0].output, finalPath);
    rmSync(built[0].output);
  } else {
    const lipo = spawnSync(
      "lipo",
      ["-create", "-output", finalPath, ...built.map((item) => item.output)],
      { encoding: "utf8" },
    );
    if (lipo.status !== 0) {
      throw new Error(
        `lipo could not combine REEWindow architectures. ${commandText(lipo)}`,
      );
    }
    for (const item of built) rmSync(item.output, { force: true });
  }
  chmodSync(finalPath, 0o755);
  return {
    architectures: built.map((item) => item.arch),
    skipped,
  };
}
