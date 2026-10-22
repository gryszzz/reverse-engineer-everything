import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { emitHandoff } from "../handoff/emit.mjs";
import { ingestSpec } from "../opportunities/board.mjs";
import { analyzeOutsideIn } from "../outside-in/analyze.mjs";
import { scaffoldRebuild } from "../rebuild/scaffold.mjs";
import { verifyRebuild } from "../rebuild/verify.mjs";

const SOURCE_ONLY =
  "This target has no request.json. Source-only targets are not a product spec yet, so pipeline did not invent one.";

function publicVerify(verify) {
  return {
    schema_version: verify.schema_version,
    exit_code: verify.exit_code,
    signal: verify.signal,
    features: verify.features,
    implemented: verify.implemented,
    unimplemented: verify.unimplemented,
    failed: verify.failed,
    not_run: verify.not_run,
    total: verify.total,
    ratio: verify.ratio,
    quote_test_passed: verify.quote_test_passed,
  };
}

/**
 * Analyze an owned outside-in fixture, rebuild the HTTP features,
 * verify them, pack the product, and write a dry-run board handoff.
 * Blast is not notified. Guard is not called. Vault is not copied.
 */
export async function runProductPipeline({
  target,
  outDir,
  productName = null,
  now = new Date(),
}) {
  if (!target || !outDir)
    throw new Error("Use pipeline TARGET --out DIR [--name NAME].");
  const fixture = resolve(target);
  if (!existsSync(fixture) || !statSync(fixture).isDirectory())
    throw new Error("pipeline TARGET must be a directory.");
  const requestPath = join(fixture, "request.json");
  if (!existsSync(requestPath)) throw new Error(SOURCE_ONLY);
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  const name = productName?.trim() || "REE Product";
  const analysisDir = join(outDir, "analysis");
  const productDir = join(outDir, "product");
  const boardDir = join(outDir, "board");
  const result = await analyzeOutsideIn({
    ...request,
    fixtureDir: fixture,
    outDir: analysisDir,
    now: () => now,
  });
  if (result.exitCode !== 0) {
    return {
      code: result.exitCode,
      product_name: name,
      analysis_dir: analysisDir,
      spec_status: result.spec.status,
      message: `Outside-in status is ${result.spec.status}. Pipeline did not rebuild a product from a refused spec.`,
      dry_run: true,
    };
  }
  const built = scaffoldRebuild({
    spec: result.spec,
    productName: name,
    outDir: productDir,
    now,
  });
  const verify = verifyRebuild(productDir);
  ingestSpec(boardDir, result.spec, now);
  const emitted = emitHandoff({
    projectDir: productDir,
    verify,
    blastDir: join(outDir, "handoff"),
    now,
  });
  return {
    code: verify.exit_code === 0 ? 0 : 1,
    product_name: name,
    analysis_dir: analysisDir,
    spec_status: result.spec.status,
    build_id: built.build_id,
    product_dir: productDir,
    package_path: built.package_path,
    board_dir: boardDir,
    handoff_dir: emitted.directory,
    implemented: verify.implemented,
    unimplemented: verify.unimplemented,
    failed: verify.failed,
    verify: publicVerify(verify),
    dry_run: true,
    notified_blast: false,
    guard_sign_off: "not-submitted",
    approved_for_vault_copy: false,
  };
}
