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
  if (
    prefix(b, Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    prefix(b, Buffer.from([0x4d, 0x5a])) ||
    [
      "feedface",
      "feedfacf",
      "cafebabe",
      "cffaedfe",
      "cefaedfe",
      "bebafeca",
    ].includes(b.subarray(0, 4).toString("hex"))
  )
    info = ext === ".dll" ? CATALOG.managed : CATALOG.native;
  else if (prefix(b, Buffer.from([0x00, 0x61, 0x73, 0x6d])))
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
  return { target: path, exists: true, input_type: "file", ...info, basis };
}

export function renderPlan(plan, question = null) {
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
    plan.next,
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
