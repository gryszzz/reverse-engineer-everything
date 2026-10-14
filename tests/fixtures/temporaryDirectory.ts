import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { onTestFinished } from "vitest";

import { removeTestWorkspace } from "../support/workspace/workspaceFixture.js";

const TEMPORARY_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*-$/u;

/**
 * Creates an empty canonical temporary directory owned by the current Vitest
 * case.
 *
 * This deliberately does not build a workspace first. It used to call
 * `createTestWorkspace`, which creates `home` and `xdg/{config,cache}`, then
 * immediately delete two of them so callers would receive an empty root. Every
 * caller therefore paid three `mkdir` calls and two `rm` calls per temporary
 * directory for scaffolding it never used. Callers that do need a home or XDG
 * tree should call `createTestWorkspace` directly.
 */
export const createTestTempDirectory = async (
  prefix: string,
): Promise<string> => {
  if (!TEMPORARY_PREFIX.test(prefix) || prefix.length > 80) {
    throw new TypeError(
      "Test temporary directory prefixes must be safe basenames ending in '-'",
    );
  }

  const canonicalDirectory = await realpath(
    await mkdtemp(join(await realpath(tmpdir()), prefix)),
  );
  onTestFinished(async () => {
    await removeTestWorkspace(canonicalDirectory);
  });
  return canonicalDirectory;
};
