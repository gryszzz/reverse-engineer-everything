import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

const category = (
  kind,
  label,
  meaning,
  capability,
  documentation,
  needs,
  next,
  basis,
) => ({
  kind,
  label,
  meaning,
  capability,
  documentation,
  needs,
  next,
  basis,
});

const CATALOG = {
  javascript: category(
    "javascript",
    "JavaScript / Electron",
    "Maps code, imports and application boundaries without starting the target.",
    "static-supported",
    "docs/javascript-artifact-reconstruction.md",
    ["Build the REE fork"],
    "Use the REA JavaScript application analysis workflow.",
    "JavaScript-style filename or project entries",
  ),
  native: category(
    "native",
    "Native executable or library",
    "Examines instructions, symbols and functions with a separately configured analysis engine.",
    "provider-required",
    "docs/native-investigation.md",
    [
      "Permission to inspect the file",
      "Installed Hopper, Ghidra or IDA compatible with the format",
    ],
    "Check provider availability, then investigate read-only.",
    "Recognized native executable signature or native extension",
  ),
  managed: category(
    "managed",
    "Possibly .NET / native library",
    "Inspects managed metadata when the assembly actually contains .NET metadata.",
    "verify-format",
    "docs/managed-code-analysis.md",
    [
      "Confirm PE/CLI metadata (a .dll extension is not proof)",
      "Native provider if not managed",
    ],
    "Try the read-only managed artifact inspection; use native diagnostics if it is not managed.",
    "Executable/library extension; .NET metadata not verified",
  ),
  android: category(
    "android",
    "Android application package",
    "Finds manifest, classes and resources through optional local tooling.",
    "provider-required",
    "docs/android-analysis.md",
    ["JDK and JADX for code inspection", "Authorized APK"],
    "Start with package inventory, then choose APK analysis tools.",
    "Android package extension",
  ),
  ios: category(
    "ios",
    "Apple application package",
    "Inventories app contents and may hand off binaries to native providers.",
    "provider-required",
    "docs/apple-application-analysis.md",
    [
      "Authorized application package",
      "Compatible analysis tools for native code",
    ],
    "Inventory the package first; native analysis is separate.",
    "Apple package extension",
  ),
  wasm: category(
    "wasm",
    "WebAssembly module",
    "Reads module structure and interfaces with a local WebAssembly toolchain.",
    "provider-required",
    "docs/wasm-artifacts.md",
    ["Compatible WABT tools for deeper inspection"],
    "Inspect the WASM artifact and keep unknowns explicit.",
    "WebAssembly header or extension",
  ),
  sqlite: category(
    "sqlite",
    "SQLite database",
    "Examines a local database snapshot, schema, indexes and bounded rows.",
    "static-supported",
    "docs/sqlite-databases.md",
    [
      "Use a copy/snapshot rather than a live database",
      "Compatible Node.js version",
    ],
    "Inspect a read-only snapshot, not an active application database.",
    "SQLite header or database extension",
  ),
  network: category(
    "network",
    "Saved network traffic",
    "Summarizes provided requests or packet captures; it does not intercept live traffic.",
    "provider-required",
    "docs/web-network-captures.md",
    ["Authorized recording", "Format-specific tools may be needed"],
    "Choose the HAR/packet analysis workflow for the actual capture format.",
    "Capture filename or packet signature",
  ),
  website: category(
    "website",
    "Website URL",
    "Can investigate page structure and observable runtime behavior using a browser.",
    "authorization-required",
    "docs/browser-observation.md",
    [
      "Explicit approval before any live browser/network access",
      "Chrome-family browser",
    ],
    "Start with an authorized, bounded browser observation. Preview makes no requests.",
    "HTTP(S) URL",
  ),
  firmware: category(
    "firmware",
    "Possible firmware or raw binary",
    "Can inventory and extract some firmware formats; arbitrary raw bytes need context.",
    "verify-format",
    "docs/firmware-analysis.md",
    [
      "Confirm format/architecture",
      "Linux toolchain such as Binwalk/Unblob when appropriate",
    ],
    "Classify the artifact before choosing an extraction or native analysis workflow.",
    "Generic firmware/binary extension",
  ),
  java: category(
    "java",
    "Java class or archive",
    "Recognizes a class file or JAR name. It does not decompile or run it.",
    "partial",
    "README.md",
    ["A later Java/JAR route", "Authorized class or archive"],
    "Java and JAR inspection is not scored yet. Nothing was decompiled.",
    "Java class magic or .class/.jar extension",
  ),
  ambiguous: category(
    "ambiguous",
    "Ambiguous container",
    "The leading bytes match more than one format, so no provider is selected.",
    "partial",
    "README.md",
    ["A thin slice or a .class extension"],
    "The preview will not guess between fat Mach-O and a Java class file.",
    "Shared magic without a decisive header",
  ),
  unknown: category(
    "unknown",
    "Unclassified target",
    "No trustworthy analysis route can be selected from the supplied evidence.",
    "unknown",
    "README.md",
    ["More format information"],
    "Identify the source and file format first. Do not execute an unknown target.",
    "No supported signature, extension or directory markers",
  ),
};

const SOURCE = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const NATIVE = new Set([".exe", ".so", ".dylib", ".elf", ".out"]);
const THIN_MACHO = new Set(["feedface", "feedfacf", "cffaedfe", "cefaedfe"]);
const KNOWN_MACHO_CPU = new Set([
  7, 0x01000007, 12, 0x0100000c, 0x0200000c, 18, 0x01000012,
]);

function engineCommand(command) {
  return `node scripts/rea.mjs ${command} TARGET --json`;
}

function nativeCommands(container) {
  const go = engineCommand("inspect-go-binary");
  const rust = engineCommand("inspect-rust-binary");
  if (container === "elf")
    return [go, rust, engineCommand("inspect-binary-layout")];
  if (container === "pe")
    return [engineCommand("inspect-pe-resources"), go, rust];
  if (container === "macho") return [go, rust, engineCommand("inspect-macho")];
  return [];
}

function nativeCoverage(container, managed) {
  if (container === "elf")
    return "measured for Go build info and Rust cargo-auditable packages on an owned ELF image. ELF layout is partial until REA_PWNTOOLS_PYTHON is set. Disassembly is partial and needs a configured native provider.";
  if (container === "pe" && managed)
    return "measured for PE resource identities, Go build info, and Rust packages. Partial for .NET: a .dll extension does not prove managed metadata, and this preview did not read a CLI header.";
  if (container === "pe")
    return "measured for PE resource identities, Go build info, and Rust packages. Decompilation is partial and is not performed.";
  if (container === "macho")
    return "measured for Go build info and Rust packages on a thin Mach-O image. inspect-macho is partial without otool and lipo, and on Linux it is unsupported.";
  return "partial. This fat Mach-O container is not one architecture. Select a thin slice before inspect-go-binary, inspect-rust-binary, or inspect-macho. Nothing was sliced.";
}

/** CAFEBABE is both fat Mach-O and a Java class. Do not guess from the magic alone. */
function cafeBabeKind(bytes, fileSize, extension) {
  if (extension === ".class" || extension === ".jar") return "java";
  if (bytes.length < 8) return "ambiguous";
  const magic = bytes.subarray(0, 4).toString("hex");
  const little = magic === "bebafeca" || magic === "bfbafeca";
  const count = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
  const wide = magic === "cafebabf" || magic === "bfbafeca";
  const tableEnd = 8 + count * (wide ? 32 : 20);
  const cpu =
    !little && !wide && bytes.length >= 12 ? bytes.readUInt32BE(8) : null;
  if (
    cpu != null &&
    KNOWN_MACHO_CPU.has(cpu) &&
    count > 0 &&
    count <= 32 &&
    tableEnd <= fileSize
  )
    return "macho-fat";
  const major = bytes.readUInt16BE(6);
  const minor = bytes.readUInt16BE(4);
  if (!little && minor === 0 && major >= 45 && major <= 69) return "java";
  if (count > 0 && count <= 32 && tableEnd <= fileSize) return "macho-fat";
  return "ambiguous";
}
const prefix = (bytes, signature) =>
  bytes.subarray(0, signature.length).equals(signature);

export function classifyTarget(raw) {
  if (typeof raw !== "string" || raw.trim() === "")
    throw new Error("Provide a target path or an HTTP(S) URL.");
  // Accept a URL only as a declared target. No network calls occur.
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (!url.hostname || url.username || url.password)
      throw new Error("Use a URL without embedded credentials.");
    return { target: raw, exists: null, ...CATALOG.website };
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw))
    throw new Error("Only HTTP(S) website URLs are supported by this preview.");
  const path = resolve(raw);
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Target not found: ${path}`);
    throw error;
  }
  if (stats.isSymbolicLink())
    throw new Error(
      "Symbolic links require explicit review of the resolved target; this preview does not follow them.",
    );
  let info;
  if (stats.isDirectory()) {
    const entries = new Set(readdirSync(path));
    const hasJs =
      entries.has("package.json") ||
      [...entries].some((name) => SOURCE.has(extname(name).toLowerCase()));
    info = hasJs ? CATALOG.javascript : CATALOG.unknown;
    return {
      target: path,
      exists: true,
      input_type: "directory",
      ...info,
      basis: hasJs
        ? "Directory contains package.json or a JavaScript source entry"
        : "Directory has no directly visible JavaScript entry or known manifest",
    };
  }
  if (!stats.isFile())
    throw new Error(
      "Only regular files and directories are accepted; special devices are not inspected.",
    );
  const ext = extname(basename(path)).toLowerCase();
  const fd = openSync(path, "r");
  const bytes = Buffer.alloc(32);
  let count = 0;
  try {
    count = readSync(fd, bytes, 0, bytes.length, 0);
  } finally {
    closeSync(fd);
  }
  const b = bytes.subarray(0, count);
  const hex = b.subarray(0, 4).toString("hex");
  let commands = null;
  let container = null;
  if (prefix(b, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    container = "elf";
    info = CATALOG.native;
    commands = nativeCommands("elf");
  } else if (prefix(b, Buffer.from([0x4d, 0x5a]))) {
    container = "pe";
    info = ext === ".dll" ? CATALOG.managed : CATALOG.native;
    commands = nativeCommands("pe");
  } else if (THIN_MACHO.has(hex)) {
    container = "macho";
    info = CATALOG.native;
    commands = nativeCommands("macho");
  } else if (["cafebabe", "cafebabf", "bebafeca", "bfbafeca"].includes(hex)) {
    const cafe = cafeBabeKind(b, stats.size, ext);
    if (cafe === "java") info = CATALOG.java;
    else if (cafe === "macho-fat") {
      container = "macho-fat";
      info = CATALOG.native;
      commands = [
        "Select a thin slice, then run inspect-go-binary, inspect-rust-binary, or inspect-macho on that slice.",
      ];
    } else info = CATALOG.ambiguous;
  } else if (prefix(b, Buffer.from([0x00, 0x61, 0x73, 0x6d])))
    info = CATALOG.wasm;
  else if (prefix(b, Buffer.from("SQLite format 3\0"))) info = CATALOG.sqlite;
  else if (ext === ".apk" || ext === ".aab") info = CATALOG.android;
  else if (ext === ".ipa" || ext === ".app") info = CATALOG.ios;
  else if (ext === ".wasm") info = CATALOG.wasm;
  else if (ext === ".db" || ext === ".sqlite" || ext === ".sqlite3")
    info = CATALOG.sqlite;
  else if (
    ["d4c3b2a1", "a1b2c3d4", "0a0d0d0a", "4d3cb2a1", "a1b23c4d"].includes(
      b.subarray(0, 4).toString("hex"),
    )
  )
    info = CATALOG.network;
  else if (
    ext === ".har" ||
    ext === ".pcap" ||
    ext === ".pcapng" ||
    ext === ".saz"
  )
    info = CATALOG.network;
  else if (ext === ".asar" || SOURCE.has(ext)) info = CATALOG.javascript;
  else if (ext === ".dll") info = CATALOG.managed;
  else if (NATIVE.has(ext)) info = CATALOG.native;
  else if (ext === ".class" || ext === ".jar" || ext === ".war")
    info = CATALOG.java;
  else if (ext === ".bin" || ext === ".rom" || ext === ".img")
    info = CATALOG.firmware;
  else info = CATALOG.unknown;
  let basis = info.basis;
  if (
    info === CATALOG.native &&
    (prefix(b, Buffer.from("MZ")) ||
      prefix(b, Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
  )
    basis = "Recognized PE/ELF header (not program behavior)";
  if (info === CATALOG.sqlite && prefix(b, Buffer.from("SQLite format 3\0")))
    basis = "Recognized SQLite header";
  if (info === CATALOG.wasm && prefix(b, Buffer.from([0, 97, 115, 109])))
    basis = "Recognized WebAssembly header";
  const coverage = container
    ? nativeCoverage(container, ext === ".dll")
    : info.kind === "javascript"
      ? "measured. The accuracy bench scores modules, functions, imports, calls, strings, and behaviors."
      : info.kind === "unknown"
        ? "unsupported. No format matched. Nothing was analyzed."
        : info.kind === "java"
          ? "partial. Java and JAR inspection is not scored yet. Nothing was decompiled."
          : info.kind === "ambiguous"
            ? "partial. The preview will not guess between fat Mach-O and a Java class file."
            : "partial. This format is recognized. It is not in the accuracy bench yet, and this preview did not analyze it.";
  return {
    target: path,
    exists: true,
    input_type: "file",
    ...info,
    basis,
    ...(container ? { container } : {}),
    ...(commands ? { commands } : {}),
    ...(coverage ? { coverage } : {}),
  };
}

export function renderPlan(plan, question = null) {
  const nextStep =
    plan.kind === "javascript"
      ? [
          "If you own or are authorized to inspect this target, run:",
          'node ree.mjs analyze TARGET --authorized --out NEW_DIR --question "YOUR QUESTION"',
          "Replace TARGET with the path above, choose a new output directory outside it and this checkout, and keep your investigation question.",
          "This route analyzes JavaScript/Electron source statically; it does not launch the target.",
        ].join("\n")
      : Array.isArray(plan.commands) && plan.commands.length > 0
        ? plan.commands.join("\n")
        : plan.next;
  const coverage =
    plan.coverage ??
    (plan.kind === "unknown"
      ? "unsupported. No format matched. Nothing was analyzed."
      : plan.kind === "javascript"
        ? "measured. The accuracy bench scores modules, functions, imports, calls, strings, and behaviors."
        : "partial. This format is recognized. It is not in the accuracy bench yet, and this preview did not analyze it.");
  const lines = [
    "REE  /  Investigation intake",
    `Target: ${plan.target}`,
    `Detected: ${plan.label}`,
    `Why: ${plan.basis}`,
    `Readiness: ${plan.capability}`,
    question
      ? `Question: ${question}`
      : "Question: What do you want to understand about this target?",
    "",
    "What REE can help with:",
    plan.meaning,
    "",
    "Next step:",
    nextStep,
    `Coverage: ${coverage}`,
    `Guide: ${plan.documentation}`,
    "Requirements / limitations:",
    ...plan.needs.map((need) => `- ${need}`),
    "",
    "Preview only. No target was executed, fetched, modified or analyzed.",
  ];
  return lines.join("\n");
}

export function availableCategories() {
  return Object.values(CATALOG).map(({ kind, label, capability }) => ({
    kind,
    label,
    capability,
  }));
}
