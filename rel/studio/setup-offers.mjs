import { digestValue } from "./experiment.mjs";
import { studioError } from "./errors.mjs";

const APKTOOL_ARGV = ["brew", "install", "apktool"];

/**
 * The only install command the studio will run.
 * It does not install Homebrew, Java, Ghidra, WABT, JADX, or Python packages.
 */
export function setupOffers({
  platform = process.platform,
  brew = false,
  apktoolReady = false,
} = {}) {
  let unavailable = null;
  if (platform !== "darwin")
    unavailable =
      "This command is a macOS Homebrew install. It is not run on this host. REE does not install Homebrew.";
  else if (!brew)
    unavailable = "Homebrew is not on PATH. REE does not install Homebrew.";
  else if (apktoolReady)
    unavailable = "apktool is already available. There is nothing to install.";
  const offer = {
    id: "apktool",
    argv: APKTOOL_ARGV,
    command_digest: digestValue({ id: "apktool", argv: APKTOOL_ARGV }),
    available: unavailable === null,
    unavailable_reason: unavailable,
    changes:
      "Runs exactly `brew install apktool` so decode-android-resources can resolve apktool on PATH.",
    does_not:
      "Does not install Homebrew, Java, JADX, or Ghidra, and does not set REA_JADX_MCP_JAR. A successful install does not make the JADX package route ready.",
  };
  return {
    offers: [offer],
    guidance: [
      {
        id: "wabt",
        text: "WebAssembly stays not-configured until REA_WABT_BIN_DIRECTORY is an absolute directory of WABT 1.0.42. REA does not install WABT. brew install wabt does not set that variable or prove the version.",
      },
      {
        id: "jadx",
        text: "Android package inspection stays not-configured until REA_JADX_MCP_JAR is the absolute path of a caller-supplied jadx-headless-mcp 0.7.1 JAR. REA does not download it. A Homebrew jadx binary is a different tool.",
      },
      {
        id: "pwntools",
        text: "ELF layout stays not-configured until REA_PWNTOOLS_PYTHON is an absolute Python with the pinned packages. REA never installs Python or packages.",
      },
      {
        id: "ghidra",
        text: "Ghidra stays not-configured until GHIDRA_INSTALL_DIR is an extracted release. REE does not install Ghidra, IDA, or Hopper.",
      },
    ],
  };
}

/** Return the approved argv, or throw before any process is started. */
export function approveSetup({ offerId, approved, commandDigest, catalog }) {
  if (approved !== true)
    throw studioError(
      "Setup requires approved: true for the exact command shown.",
      403,
    );
  const offer = catalog.offers.find((item) => item.id === offerId);
  if (!offer) throw studioError("Unknown setup offer.", 404);
  if (commandDigest !== offer.command_digest)
    throw studioError(
      "The command changed. Review the exact argv again before approving.",
      409,
    );
  if (!offer.available) throw studioError(offer.unavailable_reason, 409);
  return offer.argv;
}
