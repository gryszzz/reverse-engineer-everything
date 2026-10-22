import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryRoot } from "../studio/paths.mjs";

const aliasScript = `on run argv
  set sourcePath to item 1 of argv
  set desktopPath to item 2 of argv
  tell application "Finder"
    set sourceItem to POSIX file sourcePath as alias
    set desktopFolder to POSIX file desktopPath as alias
    set linkItem to make alias file to sourceItem at desktopFolder
    set name of linkItem to "REE"
  end tell
end run`;

/** Copy a built REE.app into ~/Applications and put an alias on the Desktop. */
export function installMacApp({
  app = join(repositoryRoot, "build", "REE.app"),
  home = homedir(),
  platform = process.platform,
} = {}) {
  const source = resolve(app);
  const plist = join(source, "Contents", "Info.plist");
  const launcher = join(source, "Contents", "MacOS", "REE");
  if (!existsSync(plist) || !existsSync(launcher)) {
    throw new Error(
      "REE.app is incomplete. Run node ree.mjs app build on macOS before installing.",
    );
  }
  const identity = readFileSync(plist, "utf8");
  if (
    !identity.includes("<string>REE</string>") ||
    !identity.includes("<string>io.github.gryszzz.ree.studio</string>")
  ) {
    throw new Error("Refusing to install a bundle that is not REE.");
  }
  const applications = join(resolve(home), "Applications");
  const desktop = join(resolve(home), "Desktop");
  const destination = join(applications, "REE.app");
  if (source === destination) {
    throw new Error("The source REE.app is already the install destination.");
  }
  mkdirSync(applications, { recursive: true });
  mkdirSync(desktop, { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  const alias = join(desktop, "REE");
  rmSync(alias, { recursive: true, force: true });
  const aliasKind = placeAlias({
    platform,
    destination,
    desktop,
    alias,
  });
  return {
    app: destination,
    alias,
    alias_kind: aliasKind,
    window: existsSync(join(destination, "Contents", "MacOS", "REEWindow"))
      ? "built"
      : "not-built",
  };
}

function placeAlias({ platform, destination, desktop, alias }) {
  if (platform === "darwin") {
    const result = spawnSync(
      "osascript",
      ["-e", aliasScript, destination, desktop],
      {
        encoding: "utf8",
        timeout: 15000,
      },
    );
    if (
      result.status === 0 &&
      existsSync(alias) &&
      !lstatSync(alias).isSymbolicLink()
    ) {
      return "finder";
    }
    rmSync(alias, { recursive: true, force: true });
  }
  symlinkSync(destination, alias);
  if (readlinkSync(alias) !== destination) {
    throw new Error(
      "The Desktop link does not point at the installed REE.app.",
    );
  }
  return "symlink";
}
