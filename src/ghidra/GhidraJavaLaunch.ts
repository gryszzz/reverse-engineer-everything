import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { dirname, join } from "node:path";
import { execFileOutput } from "../process/ExecFileOutput.js";

/** JVM option environments remove quotes, including quotes inside an option. */
const jvmEnvironmentArguments = (value: string): readonly string[] => {
  const arguments_: string[] = [];
  let argument = "";
  let quote: "'" | '"' | undefined;
  for (const character of value) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else argument += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/u.test(character)) {
      if (argument !== "") arguments_.push(argument);
      argument = "";
    } else argument += character;
  }
  if (quote !== undefined)
    throw new Error(
      "Invalid quoted Ghidra LaunchSupport JVM environment option",
    );
  if (argument !== "") arguments_.push(argument);
  return arguments_;
};

const rejectJvmPlatformOverrides = (arguments_: readonly string[]): void => {
  if (
    arguments_.some((argument) => /^-Dos\.(?:arch|name)(?:=|$)/u.test(argument))
  )
    throw new Error(
      "Ghidra LaunchSupport may not override os.arch or os.name; the native decompiler was validated for the inspected JVM platform.",
    );
};

/** Launch coordinates obtained from Ghidra's own release configuration helper. */
export const ghidraJavaLaunch = async (options: {
  readonly platform: NodeJS.Platform;
  readonly analyzeHeadlessPath: string;
  readonly javaHome?: string;
  readonly javaVmName?: string;
  readonly homeRoot: string;
  readonly tempRoot: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onStderr: (mode: "-envvars" | "-vmargs", stderr: string) => void;
}): Promise<{
  readonly command: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}> => {
  const supportRoot = dirname(options.analyzeHeadlessPath);
  const installRoot = dirname(supportRoot);
  const selectedJavaHome = options.javaHome ?? options.environment.JAVA_HOME;
  const command =
    selectedJavaHome === undefined
      ? options.platform === "win32"
        ? "java.exe"
        : "java"
      : join(
          selectedJavaHome,
          "bin",
          options.platform === "win32" ? "java.exe" : "java",
        );
  const isolatedProperties = [
    `-Duser.home=${options.homeRoot}`,
    `-Djava.io.tmpdir=${options.tempRoot}`,
  ];
  const supportArguments = [
    ...isolatedProperties,
    // Only identified HotSpot VMs have these unified-logging semantics. OpenJ9
    // uses different -Xlog behavior; missing VM identity must stay unknown.
    ...(/^(?:OpenJDK|Java HotSpot\(TM\)) (?:64-Bit )?(?:Server|Client|Zero) VM$/u.test(
      options.javaVmName ?? "",
    )
      ? ["-Xlog:disable", "-Xlog:all=warning:stderr"]
      : []),
    "-cp",
    join(supportRoot, "LaunchSupport.jar"),
    "LaunchSupport",
    installRoot,
  ];
  const environment = {
    ...snapshotEnvironment(options.environment, options.platform),
  };
  const configuredEnvironment = await execFileOutput(
    command,
    [...supportArguments, "-envvars"],
    {
      env: environment,
      // Wait for the helper's exit on abort so a cancelled or timed-out
      // startup never leaves the probe running without an owning process.
      stopSignal: "SIGTERM",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  options.onStderr("-envvars", configuredEnvironment.stderr);
  for (const line of configuredEnvironment.stdout.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    const sourceKey = line.slice(0, separator);
    const key =
      options.platform === "win32" ? sourceKey.toUpperCase() : sourceKey;
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
      throw new Error(
        `Invalid Ghidra LaunchSupport environment entry: ${line}`,
      );
    if ((environment[key] ?? "") === "")
      environment[key] = line.slice(separator + 1);
  }
  // The merged environment becomes the analysis JVM's environment, and the
  // JVM applies these options variables automatically. An injected
  // -Dos.arch/-Dos.name there selects an unvalidated native directory without
  // appearing in vmArguments, so reject the effective values as well.
  for (const key of [
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
  ] as const) {
    rejectJvmPlatformOverrides(jvmEnvironmentArguments(environment[key] ?? ""));
  }
  const configuredArguments = await execFileOutput(
    command,
    [...supportArguments, "-vmargs"],
    {
      env: environment,
      // Wait for the helper's exit on abort so a cancelled or timed-out
      // startup never leaves the probe running without an owning process.
      stopSignal: "SIGTERM",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  options.onStderr("-vmargs", configuredArguments.stderr);
  const vmArguments = configuredArguments.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== "");
  if (
    vmArguments.some(
      (argument) => !argument.startsWith("-") || argument.includes("\0"),
    )
  )
    throw new Error("Invalid Ghidra LaunchSupport JVM argument");
  rejectJvmPlatformOverrides(vmArguments);
  return {
    command,
    environment,
    arguments: [
      ...vmArguments,
      ...(options.platform === "darwin" ? ["-Xdock:name=Ghidra-Headless"] : []),
      `-Xmx${environment.GHIDRA_HEADLESS_MAXMEM || environment.GHIDRA_MAXMEM || "2G"}`,
      "-XX:ParallelGCThreads=2",
      "-XX:CICompilerCount=2",
      "-Djava.awt.headless=true",
      ...isolatedProperties,
      "-showversion",
      "-cp",
      join(installRoot, "Ghidra", "Framework", "Utility", "lib", "Utility.jar"),
      "ghidra.Ghidra",
      "ghidra.app.util.headless.AnalyzeHeadless",
      ...options.arguments,
    ],
  };
};
