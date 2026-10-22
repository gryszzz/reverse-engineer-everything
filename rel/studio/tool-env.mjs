import { allowlistedEnv } from "./experiment.mjs";

const TOOL_KEYS = [
  "REA_WABT_BIN_DIRECTORY",
  "REA_JADX_MCP_JAR",
  "REA_PWNTOOLS_PYTHON",
  "REA_APKTOOL_COMMAND",
  "GHIDRA_INSTALL_DIR",
  "JAVA_HOME",
];

/** Child environment for an engine route. Tool paths are forwarded; secrets are not. */
export function engineChildEnv(env = process.env) {
  const child = allowlistedEnv();
  for (const key of TOOL_KEYS) {
    if (typeof env[key] === "string" && env[key] !== "") child[key] = env[key];
  }
  child.REA_LOG_LEVEL = "silent";
  return child;
}
