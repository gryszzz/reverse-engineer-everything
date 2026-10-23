import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyTarget } from "../intake.mjs";
import { evidenceFacts } from "../studio/theater.mjs";

const MAX_BEHAVIORS = 8;

export function analyzerDecision(path) {
  const detected = classifyTarget(path);
  if (
    detected.kind === "javascript" &&
    (detected.input_type === "directory" ||
      String(detected.target ?? "")
        .toLowerCase()
        .endsWith(".asar"))
  ) {
    return { run: true, detected };
  }
  if (
    [
      "native",
      "android",
      "ios",
      "wasm",
      "managed",
      "firmware",
      "java",
    ].includes(detected.kind)
  ) {
    return {
      run: false,
      detected,
      reason: `${detected.label} needs its REA provider. This read did not run that provider and did not execute the file.`,
    };
  }
  return { run: false, detected, reason: null };
}

export function behaviorsMarkdown(behaviors) {
  const used = [];
  const skipped = [];
  const lines = ["# Recorded behaviors", ""];
  for (const item of behaviors ?? []) {
    const name = String(item?.behavior ?? "")
      .replace(/\s+/gu, " ")
      .trim();
    if (!name || name.length > 80 || name.includes("`")) {
      skipped.push({
        target: name.slice(0, 40) || "(blank)",
        reason:
          "The behavior name was not a short label, so it was not copied.",
      });
      continue;
    }
    if (used.includes(name)) continue;
    if (used.length >= MAX_BEHAVIORS) {
      skipped.push({
        target: name,
        reason: `Past the ${MAX_BEHAVIORS} behavior limit.`,
      });
      continue;
    }
    used.push(name);
    lines.push(
      `## ${name}`,
      "",
      "Static analysis recorded this behavior. Source text was not copied.",
      "",
    );
  }
  return { markdown: used.length ? lines.join("\n") : "", used, skipped };
}

export async function analyzeAuthorizedTarget({ target, outDir }) {
  const runtime = join(
    new URL("../../dist/cli-runtime/cli.js", import.meta.url).pathname,
  );
  if (!existsSync(runtime)) {
    return {
      skipped:
        "Built REA runtime is missing. Run npm ci && npm run build:cached. No file was executed.",
    };
  }
  try {
    const { planStaticAnalysis, runStaticAnalysis } =
      await import("../analyze-static.mjs");
    const destination = join(outDir, "evidence");
    const plan = planStaticAnalysis(target, destination, true);
    await runStaticAnalysis(plan);
    const evidence = JSON.parse(
      readFileSync(join(plan.output, "evidence.json"), "utf8"),
    );
    const facts = evidenceFacts(evidence);
    return {
      evidence_id: evidence.evidence_id ?? null,
      behaviors: facts.behaviors.map((item) => ({ behavior: item.behavior })),
    };
  } catch (error) {
    return {
      skipped:
        error instanceof Error
          ? error.message
          : "Static analysis did not produce evidence.",
    };
  }
}
