import { spawnSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { isAbsolute, extname, join } from "node:path";
import { repositoryRoot } from "./paths.mjs";

const WABT_TOOLS = ["wasm-validate", "wasm-objdump", "wasm2wat"];
const WABT_VERSION = "1.0.42";

const ROUTES = [
  {
    id: "javascript-static",
    label: "JavaScript / Electron / ASAR",
    families: ["javascript"],
    engine: "implemented",
    studio: "implemented",
    command: "analyze",
    provider: "javascript-application",
  },
  {
    id: "pe-resources",
    label: "PE resource inventory",
    families: ["pe"],
    engine: "implemented",
    studio: "implemented",
    command: "inspect-pe-resources",
    provider: "rea-pe-resources",
  },
  {
    id: "wasm",
    label: "WebAssembly module",
    families: ["wasm"],
    engine: "implemented",
    studio: "implemented",
    command: "inspect-wasm-artifact",
    provider: "wabt",
  },
  {
    id: "evm",
    label: "EVM bytecode interface",
    families: ["evm"],
    engine: "implemented",
    studio: "implemented",
    command: "inspect-evm-interface",
    provider: "evmole-interface",
  },
  {
    id: "android-package",
    label: "Android package (JADX)",
    families: ["android"],
    engine: "implemented",
    studio: "implemented",
    command: "inspect-android-package",
    provider: "jadx",
  },
  {
    id: "android-apktool",
    label: "Android resources (apktool)",
    families: ["android"],
    engine: "implemented",
    studio: "implemented",
    command: "decode-android-resources",
    provider: "apktool",
  },
  {
    id: "elf-layout",
    label: "ELF layout (pwntools)",
    families: ["elf"],
    engine: "implemented",
    studio: "implemented",
    command: "inspect-binary-layout",
    provider: "pwntools",
  },
  {
    id: "macho",
    label: "Mach-O (otool/lipo)",
    families: ["macho"],
    engine: "implemented",
    studio: "implemented",
    command: "inspect-macho",
    provider: "native-macos",
  },
  {
    id: "objdump-headers",
    label: "Native file headers (objdump)",
    families: ["pe", "elf", "macho", "native"],
    engine: "implemented",
    studio: "implemented",
    command: "inspect-with-objdump",
    provider: "gnu.objdump",
  },
  {
    id: "ghidra",
    label: "Ghidra overview",
    families: ["pe", "elf", "macho", "native"],
    engine: "implemented",
    studio: "implemented",
    command: "inspect",
    provider: "ghidra",
  },
  {
    id: "rizin",
    label: "Rizin command",
    families: [],
    engine: "implemented",
    studio: "unsupported",
    command: "execute-rizin-command",
    provider: "rizin",
  },
  {
    id: "radare2",
    label: "radare2",
    families: [],
    engine: "not-applicable",
    studio: "unsupported",
    command: null,
    provider: null,
  },
];

function commandPresent(command) {
  const result = spawnSync("/usr/bin/which", [command], {
    encoding: "utf8",
    timeout: 1500,
  });
  return result.status === 0;
}

function fileState(value) {
  if (typeof value !== "string" || value.trim() === "") return "unset";
  if (!isAbsolute(value)) return "not-absolute";
  try {
    return statSync(value).isFile() ? "ready" : "missing";
  } catch {
    return "missing";
  }
}

function directoryState(value) {
  if (typeof value !== "string" || value.trim() === "") return "unset";
  if (!isAbsolute(value)) return "not-absolute";
  try {
    return statSync(value).isDirectory() ? "ready" : "missing";
  } catch {
    return "missing";
  }
}

function readWabtVersion(binary) {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 2000,
  });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function wabtFacts(env) {
  const directory = env.REA_WABT_BIN_DIRECTORY;
  if (typeof directory !== "string" || directory.trim() === "")
    return { state: "unset" };
  if (!isAbsolute(directory)) return { state: "not-absolute" };
  const missing = WABT_TOOLS.filter(
    (name) => !existsSync(join(directory, name)),
  );
  if (missing.length > 0) return { state: "incomplete", missing };
  const banner = readWabtVersion(join(directory, "wasm-validate"));
  if (!banner.split(/\r?\n/u).some((line) => line.trim() === WABT_VERSION))
    return { state: "version", banner };
  return { state: "ready" };
}

/** Facts the route table uses. PATH presence is not a completed analysis. */
export function collectRouteFacts({
  root = repositoryRoot,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  present = commandPresent,
} = {}) {
  const configured = env.REA_APKTOOL_COMMAND;
  let apktool;
  if (typeof configured === "string" && configured.trim() !== "")
    apktool = { state: fileState(configured), source: "environment" };
  else if (present("apktool")) apktool = { state: "ready", source: "path" };
  else apktool = { state: "missing", source: "path" };
  return {
    platform,
    arch,
    runtime: existsSync(join(root, "dist/cli-runtime/cli.js")),
    evmole: existsSync(join(root, "node_modules/evmole/package.json")),
    java: present("java"),
    objdump: present("objdump"),
    otool: present("otool"),
    lipo: present("lipo"),
    brew: present("brew"),
    apktool,
    wabt: wabtFacts(env),
    jadx: fileState(env.REA_JADX_MCP_JAR),
    pwntools: fileState(env.REA_PWNTOOLS_PYTHON),
    ghidra: directoryState(env.GHIDRA_INSTALL_DIR),
  };
}

function detail(status, text) {
  return { status, detail: text };
}

function assessOne(route, facts) {
  switch (route.id) {
    case "javascript-static":
    case "pe-resources":
      return facts.runtime
        ? detail(
            "ready",
            route.id === "pe-resources"
              ? "Pure parser. No external disassembler. It inventories resources and does not decompile code."
              : "ASAR archives and Electron or JavaScript directories use this same static analyzer.",
          )
        : detail(
            "missing-tool",
            "The built runtime dist/cli-runtime/cli.js is absent. Run npm run build:cached.",
          );
    case "wasm":
      if (facts.wabt.state === "ready")
        return detail(
          "ready",
          "REA_WABT_BIN_DIRECTORY points at WABT 1.0.42. The route does not execute the module.",
        );
      if (facts.wabt.state === "unset" || facts.wabt.state === "not-absolute")
        return detail(
          "not-configured",
          "Set REA_WABT_BIN_DIRECTORY to an absolute directory containing WABT 1.0.42 (wasm-validate, wasm-objdump, wasm2wat). A copy on PATH is not this setting. REA does not install WABT.",
        );
      if (facts.wabt.state === "incomplete")
        return detail(
          "missing-tool",
          `REA_WABT_BIN_DIRECTORY is missing ${facts.wabt.missing.join(", ")}.`,
        );
      return detail(
        "not-configured",
        `WABT in REA_WABT_BIN_DIRECTORY did not report ${WABT_VERSION}. REA does not install a replacement.`,
      );
    case "evm":
      return facts.evmole
        ? detail(
            "ready",
            "Uses the pinned evmole 0.9.3 package. Selectors are inferences. Discovery completeness stays unknown and the bytecode is not executed.",
          )
        : detail(
            "missing-tool",
            "node_modules/evmole is absent. npm ci installs the pinned package. REE does not fetch a different evmole build.",
          );
    case "android-package":
      if (facts.jadx === "unset" || facts.jadx === "not-absolute")
        return detail(
          "not-configured",
          "Set REA_JADX_MCP_JAR to the absolute path of a caller-supplied jadx-headless-mcp 0.7.1 JAR. REA does not download or install it. A Homebrew jadx binary does not set this variable.",
        );
      if (facts.jadx !== "ready")
        return detail(
          "missing-tool",
          "REA_JADX_MCP_JAR is not a regular file.",
        );
      if (!facts.java)
        return detail(
          "missing-tool",
          "java was not found on PATH. REE does not install Java.",
        );
      return detail(
        "ready",
        "The JAR path and java are present. The engine still checks that the JAR is jadx-headless-mcp 0.7.1 when the route runs.",
      );
    case "android-apktool":
      if (facts.apktool.state === "ready")
        return detail(
          "ready",
          facts.apktool.source === "environment"
            ? "REA_APKTOOL_COMMAND is an absolute launcher. This decodes resources and does not install the JADX route."
            : "apktool resolves on PATH. This decodes resources and does not install the JADX route.",
        );
      if (facts.apktool.source === "environment")
        return detail(
          "missing-tool",
          "REA_APKTOOL_COMMAND must be an absolute path to the apktool launcher.",
        );
      return detail(
        "missing-tool",
        "apktool is not on PATH and REA_APKTOOL_COMMAND is unset.",
      );
    case "elf-layout":
      if (facts.platform !== "linux" || facts.arch !== "x64")
        return detail(
          "unsupported",
          "The pwntools layout route in this engine profile is Linux x64.",
        );
      if (facts.pwntools === "unset" || facts.pwntools === "not-absolute")
        return detail(
          "not-configured",
          "Set REA_PWNTOOLS_PYTHON to an absolute caller-supplied Python with pwntools 4.15.0, pyelftools 0.33, and Unicorn 2.1.2. REA never installs Python or packages.",
        );
      if (facts.pwntools !== "ready")
        return detail(
          "missing-tool",
          "REA_PWNTOOLS_PYTHON is not a regular file.",
        );
      return detail(
        "ready",
        "The Python path is set. The engine checks the pinned package versions when the route runs. The binary is not executed.",
      );
    case "macho":
      if (facts.platform !== "darwin")
        return detail(
          "unsupported",
          "inspect-macho reads otool and lipo output and is a macOS route.",
        );
      if (!facts.otool || !facts.lipo)
        return detail(
          "missing-tool",
          "otool and lipo were not both found on PATH.",
        );
      return detail("ready", "Uses otool and lipo. It does not launch Hopper.");
    case "objdump-headers":
      return facts.objdump
        ? detail(
            "ready",
            "Runs inspect-with-objdump file_headers only. Raw stdout stays authoritative. Debug links are not followed.",
          )
        : detail("missing-tool", "objdump was not found on PATH.");
    case "ghidra":
      if (facts.ghidra === "unset" || facts.ghidra === "not-absolute")
        return detail(
          "not-configured",
          "Set GHIDRA_INSTALL_DIR to an extracted Ghidra release. REE does not install Ghidra. IDA and Hopper are not started from the studio.",
        );
      if (facts.ghidra !== "ready")
        return detail("missing-tool", "GHIDRA_INSTALL_DIR is not a directory.");
      return detail(
        "ready",
        "Runs inspect --provider ghidra. The studio does not auto-select a provider. The engine uses an ephemeral database and does not modify the executable. The studio limit is 180 seconds.",
      );
    case "rizin":
      return detail(
        "unsupported",
        "execute-rizin-command runs one caller-selected command, which can execute code and change files. The studio does not choose a command and does not start a Rizin debug session.",
      );
    case "radare2":
      return detail(
        "unsupported",
        "REA has no radare2 provider. Rizin is a different command, and the studio does not send one.",
      );
    default:
      return detail("unsupported", "This studio has no runner for that route.");
  }
}

function withStatus(route, facts) {
  const assessed = assessOne(route, facts);
  return {
    id: route.id,
    label: route.label,
    status: assessed.status,
    detail: assessed.detail,
    engine: route.engine,
    studio: route.studio,
    command: route.command,
    provider: route.provider,
    families: route.families,
  };
}

/** Every studio route, including ones that are unsupported on purpose. */
export function assessRoutes(facts) {
  return ROUTES.map((route) => withStatus(route, facts));
}

export function readMagic(path) {
  let descriptor;
  const bytes = Buffer.alloc(8);
  let count = 0;
  try {
    descriptor = openSync(path, "r");
    count = readSync(descriptor, bytes, 0, bytes.length, 0);
  } catch {
    return { elf: false, pe: false, macho: false, wasm: false };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const sample = bytes.subarray(0, count);
  const hex = sample.subarray(0, 4).toString("hex");
  return {
    elf: sample.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
    pe: sample.subarray(0, 2).equals(Buffer.from("MZ")),
    macho: [
      "feedface",
      "feedfacf",
      "cafebabe",
      "cffaedfe",
      "cefaedfe",
      "bebafeca",
    ].includes(hex),
    wasm: sample.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])),
  };
}

/** Classify a path into a route family. This does not analyze it. */
export function artifactFamily(path, kind = null) {
  const extension = extname(path).toLowerCase();
  if (kind === "javascript" || extension === ".asar") return "javascript";
  if (kind === "wasm" || extension === ".wasm") return "wasm";
  if (kind === "android" || extension === ".apk" || extension === ".aab")
    return "android";
  if (extension === ".hex" || extension === ".evm") return "evm";
  if (extension === ".class") return "other";
  const magic = readMagic(path);
  if (magic.wasm) return "wasm";
  if (magic.elf) return "elf";
  if (magic.pe) return "pe";
  if (magic.macho) return "macho";
  if (kind === "native") return "native";
  return "other";
}

export function evmEncoding(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".hex" || extension === ".evm") return "hex";
  let descriptor;
  const bytes = Buffer.alloc(64);
  let count = 0;
  try {
    descriptor = openSync(path, "r");
    count = readSync(descriptor, bytes, 0, bytes.length, 0);
  } catch {
    return "raw";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const text = bytes.subarray(0, count).toString("utf8").trim();
  return /^(?:0x)?[0-9a-fA-F\s]+$/u.test(text) &&
    text.replace(/0x|\s/gu, "").length >= 2
    ? "hex"
    : "raw";
}

export function commandArgv({
  id,
  target,
  output,
  question,
  root = repositoryRoot,
  execPath = process.execPath,
}) {
  const rea = join(root, "scripts/rea.mjs");
  const json = "--json";
  switch (id) {
    case "javascript-static": {
      const argv = [
        execPath,
        join(root, "ree.mjs"),
        "analyze",
        target,
        "--authorized",
        "--out",
        output,
        json,
      ];
      if (question) argv.push("--question", question);
      return argv;
    }
    case "pe-resources":
      return [execPath, rea, "inspect-pe-resources", target, json];
    case "wasm":
      return [execPath, rea, "inspect-wasm-artifact", target, json];
    case "evm":
      return [
        execPath,
        rea,
        "inspect-evm-interface",
        target,
        evmEncoding(target),
        json,
      ];
    case "android-package":
      return [execPath, rea, "inspect-android-package", target, json];
    case "android-apktool":
      return [execPath, rea, "decode-android-resources", target, json];
    case "elf-layout":
      return [execPath, rea, "inspect-binary-layout", target, json];
    case "macho":
      return [execPath, rea, "inspect-macho", target, json];
    case "objdump-headers":
      return [
        execPath,
        rea,
        "inspect-with-objdump",
        target,
        "file_headers",
        json,
      ];
    case "ghidra":
      return [execPath, rea, "inspect", target, "--provider", "ghidra", json];
    default:
      return null;
  }
}

export function routesForTarget({
  path,
  kind = null,
  facts = collectRouteFacts(),
  root = repositoryRoot,
} = {}) {
  const family = artifactFamily(path, kind);
  return assessRoutes(facts)
    .filter((route) => route.families.includes(family))
    .map((route) => ({
      ...route,
      family,
      argv:
        route.status === "ready"
          ? commandArgv({ id: route.id, target: path, output: "", root })
          : null,
    }));
}

export function bestReadyRoute(routes) {
  return routes.find((route) => route.status === "ready") ?? null;
}

export function routeById(routes, id) {
  return routes.find((route) => route.id === id) ?? null;
}
