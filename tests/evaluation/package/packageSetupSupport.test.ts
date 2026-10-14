import { describe, expect, it } from "vitest";

import { packageSetupSupport } from "../../../scripts/verify-package-discovery.mjs";
import { parseLinuxDistribution } from "../../../src/application/LinuxHopper.js";

const osRelease = (fields: Record<string, string>) =>
  parseLinuxDistribution(
    Object.entries(fields)
      .map(([key, value]) => `${key}="${value}"`)
      .join("\n"),
  );

/** A Debian-family host REA supports that the Hopper package never tests. */
const KALI = osRelease({ ID: "kali", VERSION_ID: "2026.3", ID_LIKE: "debian" });
const UBUNTU_24 = osRelease({ ID: "ubuntu", VERSION_ID: "24.04" });

const checks = ({ node = true, host = true } = {}) => [
  { name: "node", ok: node },
  { name: "host", ok: host },
];

describe("packaged setup support derivation", () => {
  it("keeps an installer-untested REA-supported distribution out of the automated Hopper path", () => {
    // The doctor host check passes on Kali, so reading installer applicability
    // from it promised an automated install the packaged setup never offers.
    expect(
      packageSetupSupport(checks(), {
        platform: "linux",
        linuxDistribution: KALI,
      }),
    ).toEqual({
      supportedSetupHost: true,
      hopperReadinessRequired: true,
      hopperSetupSupported: false,
    });
  });

  it("follows the distribution's own applicability, not host readiness", () => {
    expect(
      packageSetupSupport(checks({ host: false }), {
        platform: "linux",
        linuxDistribution: UBUNTU_24,
      }),
    ).toEqual({
      supportedSetupHost: true,
      hopperReadinessRequired: false,
      hopperSetupSupported: true,
    });
  });

  it("keeps unreadable Linux applicability unknown", () => {
    expect(
      packageSetupSupport(checks(), { platform: "linux" }).hopperSetupSupported,
    ).toBeUndefined();
  });

  it("uses the owner's macOS predicate and excludes Windows", () => {
    expect(
      packageSetupSupport(checks(), { platform: "darwin" })
        .hopperSetupSupported,
    ).toBe(true);
    expect(
      packageSetupSupport(checks({ host: false }), { platform: "darwin" })
        .hopperSetupSupported,
    ).toBe(false);
    expect(
      packageSetupSupport([], { platform: "darwin" }).hopperSetupSupported,
    ).toBeUndefined();
    expect(
      packageSetupSupport(checks(), { platform: "win32" }).hopperSetupSupported,
    ).toBe(false);
  });

  it("reports agent setup support from the node check alone", () => {
    expect(
      packageSetupSupport(checks({ node: false }), {
        platform: "linux",
        linuxDistribution: UBUNTU_24,
      }),
    ).toEqual({
      supportedSetupHost: false,
      hopperReadinessRequired: true,
      hopperSetupSupported: true,
    });
  });
});
