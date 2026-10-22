import { OutsideInError } from "./errors.mjs";

export function resolveSummarizer(input) {
  const choice = input.summarizerChoice ?? null;
  if (choice && choice !== "none") {
    throw new OutsideInError(
      "Remote model calls are refused. Outside-in has no built-in model provider. The deterministic extractor runs without one. A programmatic caller may pass a local summarizer object.",
      "SUMMARIZER_REFUSED",
    );
  }
  const summarizer = input.summarizer;
  if (summarizer == null) return null;
  if (
    typeof summarizer !== "object" ||
    typeof summarizer.id !== "string" ||
    typeof summarizer.summarize !== "function"
  ) {
    throw new OutsideInError("A summarizer must be an object with id and summarize().", "USAGE");
  }
  return summarizer;
}

export function unusedLlm() {
  return {
    used: false,
    provider: null,
    ree_remote_calls: "not-performed",
    transport: "none",
    summary: null,
    error: null,
  };
}

export async function applySummarizer(summarizer, spec) {
  if (!summarizer) return unusedLlm();
  try {
    const result = await summarizer.summarize({
      target: spec.target,
      features: spec.features,
      workflows: spec.workflows,
      api: spec.api,
      pricing: spec.pricing,
      integrations: spec.integrations,
      limitations: spec.limitations,
      changes: spec.changes,
    });
    const text = typeof result === "string" ? result : result?.text;
    if (typeof text !== "string" || text.length === 0 || text.length > 4000) {
      return {
        used: false,
        provider: summarizer.id,
        ree_remote_calls: "not-performed",
        transport: "caller-supplied",
        summary: null,
        error: "summarizer-failed",
      };
    }
    return {
      used: true,
      provider: summarizer.id,
      ree_remote_calls: "not-performed",
      transport: "caller-supplied",
      summary: text,
      error: null,
    };
  } catch {
    return {
      used: false,
      provider: summarizer.id,
      ree_remote_calls: "not-performed",
      transport: "caller-supplied",
      summary: null,
      error: "summarizer-failed",
    };
  }
}
