import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeOutsideIn } from "../outside-in/analyze.mjs";
import { OutsideInError } from "../outside-in/errors.mjs";
import { allowedFixtureHost, classifyUrl } from "../outside-in/policy.mjs";
import { digestValue } from "./experiment.mjs";
import { studioError } from "./errors.mjs";
import { newId } from "./projects.mjs";
import { appendTimeline } from "./theater.mjs";

const PLAIN = {
  "private-host": "That host is not a public address. Nothing was fetched.",
  "source-or-binary":
    "This link does not support a rebuild. Outside-in does not fetch source or binary filenames.",
  "credentials-in-url":
    "Links must not contain credentials. Nothing was fetched.",
  "unsupported-scheme": "Links must use https. Nothing was fetched.",
  "disallowed-url": "That link is not a URL. Nothing was fetched.",
};

const UNSUPPORTED =
  "This page does not support a rebuild. No feature was recovered from the public document, and none was invented.";

/**
 * Describe the public read before any request.
 * The digest covers this description. Approval must match it.
 */
export function planStudioOutsideIn(input) {
  const text = cleanInput(input);
  const url = publicDocumentUrl(text);
  const robots = new URL("/robots.txt", url.origin);
  const plan = {
    kind: "outside-in",
    input: text,
    available: true,
    unavailable_reason: null,
    executes: false,
    requests: [
      {
        url: robots.href,
        limit_bytes: 65_536,
        timeout_ms: 30_000,
        purpose: "robots.txt",
        exact: true,
      },
      {
        url: url.href,
        limit_bytes: 512_000,
        timeout_ms: 30_000,
        purpose: "public document",
        exact: true,
      },
    ],
    git: null,
    destination: "outside-in cache outside this checkout",
    note: "REE reads this public URL and its robots.txt. Requests are rate-limited. There is no login, no protection bypass, and the page is not executed.",
  };
  const body = {
    kind: plan.kind,
    input: plan.input,
    requests: plan.requests,
    git: null,
    executes: false,
  };
  return { ...plan, plan_digest: digestValue(body) };
}

export async function runStudioOutsideIn({ store, projectId, body }) {
  if (body?.authorized !== true)
    throw studioError("Confirm authorization before analysis.", 403);
  const plan = planStudioOutsideIn(body?.input);
  if (body?.approved !== true)
    throw studioError("Check the box to approve this fetch.", 403);
  if (body?.plan_digest !== plan.plan_digest)
    throw studioError("Review the exact fetch plan before it runs.", 409);
  const url = new URL(plan.input);
  const outDir = join(store.directory(projectId), "outside-in", newId("oi_"));
  let result;
  try {
    result = await analyzeOutsideIn({
      target: { name: "REE public read", urls: [url.href] },
      outDir,
      summarizerChoice: "none",
      minIntervalMs: allowedFixtureHost(url) ? 0 : undefined,
    });
  } catch (error) {
    if (error instanceof OutsideInError) throw studioError(error.message, 400);
    throw error;
  }
  const spec = result.spec;
  const features = Array.isArray(spec.features) ? spec.features : [];
  const rebuild = features.length > 0 && spec.status !== "refused";
  const note = rebuild
    ? "Features were recovered from the public document. Review them, then rebuild. Quotes are not copied."
    : refusalNote(spec);
  const statements = findingStatements(spec, url.href);
  const unknowns = [
    ...(Array.isArray(spec.coverage?.unknowns) ? spec.coverage.unknowns : []),
    ...(Array.isArray(spec.refusals)
      ? spec.refusals.map((item) => item.detail || item.reason)
      : []),
  ]
    .filter((item) => typeof item === "string" && item.length > 0)
    .slice(0, 8);
  writeTimeline(outDir, url, features);
  const run = {
    id: newId("run_"),
    kind: "outside-in",
    status: "completed",
    artifact_id: null,
    evidence_id: null,
    question: null,
    output_dir: outDir,
    narrative: { statements, unknowns, limitations: [note] },
    outside_in: {
      status: spec.status,
      input: plan.input,
      feature_count: features.length,
      refusal_count: Array.isArray(spec.refusals) ? spec.refusals.length : 0,
      rebuild,
      note,
    },
    events: [],
  };
  const project = store.update(projectId, (current) => {
    current.runs.push(run);
    return current;
  });
  return { project, run_id: run.id, note };
}

export function draftOutsideInRun(run) {
  const spec = readOutsideInSpec(run);
  const features = (spec.features ?? []).map((feature) => ({
    id: feature.id,
    name: feature.name,
    detail: typeof feature.detail === "string" ? feature.detail : "",
    checked: true,
  }));
  const note =
    features.length === 0
      ? (run.outside_in?.note ?? UNSUPPORTED)
      : (run.outside_in?.note ??
        "Features were recovered from the public document. Review them, then rebuild.");
  return {
    spec,
    features,
    endpoints: (spec.api?.endpoints ?? []).map((item) => ({
      method: item.method,
      path: item.path,
      operation_id: item.operation_id ?? null,
    })),
    note,
  };
}

export function readOutsideInSpec(run) {
  const path = join(run.output_dir, "behavior-spec.json");
  try {
    const spec = JSON.parse(readFileSync(path, "utf8"));
    if (!spec || !Array.isArray(spec.features))
      throw studioError(UNSUPPORTED, 400);
    return spec;
  } catch (error) {
    if (error?.status) throw error;
    throw studioError(UNSUPPORTED, 400);
  }
}

function cleanInput(input) {
  if (typeof input !== "string" || input.trim() === "" || input.length > 2000)
    throw studioError("Paste one public https URL.");
  return input.trim();
}

function publicDocumentUrl(text) {
  const classified = classifyUrl(text);
  if (!classified.ok)
    throw studioError(
      PLAIN[classified.reason] ??
        "That link cannot be read as a public document. Nothing was fetched.",
    );
  if (
    classified.url.protocol !== "https:" &&
    !allowedFixtureHost(classified.url)
  )
    throw studioError("Public links must use https. Nothing was fetched.");
  return classified.url;
}

function refusalNote(spec) {
  const refusal = (spec.refusals ?? []).find(
    (item) => typeof item?.detail === "string" && item.detail.length > 0,
  );
  if (refusal) return `This page does not support a rebuild. ${refusal.detail}`;
  return UNSUPPORTED;
}

function findingStatements(spec, pageUrl) {
  const features = Array.isArray(spec.features) ? spec.features : [];
  if (features.length > 0)
    return features.slice(0, 24).map((feature) => ({
      text: [feature.name, feature.detail]
        .filter(Boolean)
        .join(". ")
        .slice(0, 400),
      evidence_id: null,
      path: feature.citations?.[0]?.url ?? pageUrl,
    }));
  return (spec.refusals ?? []).slice(0, 8).map((item) => ({
    text: item.detail || item.reason || UNSUPPORTED,
    evidence_id: null,
    path: item.url ?? pageUrl,
  }));
}

function writeTimeline(outDir, url, features) {
  appendTimeline(outDir, {
    source: "outside-in",
    phase: "robots",
    message: `Read robots.txt for ${url.origin}.`,
  });
  appendTimeline(outDir, {
    source: "outside-in",
    phase: "document",
    message: `Fetched ${url.href}.`,
    file: url.hostname,
  });
  for (const feature of features.slice(0, 12)) {
    appendTimeline(outDir, {
      source: "outside-in",
      phase: "feature",
      message: String(feature.name ?? "Feature"),
      file: String(feature.name ?? "Feature").slice(0, 80),
    });
  }
}
