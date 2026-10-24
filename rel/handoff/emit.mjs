import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { collectGaps, gapLines } from "../gaps/report.mjs";
import { improvementLines, publicImprovements } from "../improve/collect.mjs";
import { parseScoutTarget } from "../opportunities/parse.mjs";

export const BLAST_SCHEMA = "ree.blast.handoff.v1";
export const GUARD_SCHEMA = "ree.guard.submission.v1";
export const VAULT_SCHEMA = "ree.vault.manifest.v1";
export const SCALE_SCHEMA = "ree.scale.handoff.v1";
export const BOX_SHARED = "/home/box/shared";

function approvalFlags(approvals = {}) {
  return {
    launch: approvals.launch === true,
    guard: approvals.guard === true,
    blast: approvals.blast === true,
    scale: approvals.scale === true,
    vault: approvals.vault === true,
  };
}

export function blastDirectory({ buildId, override, boxRoot = BOX_SHARED }) {
  if (!buildId || !/^bld_[a-f0-9]{16}$/u.test(buildId))
    throw new Error("build id must look like bld_ and 16 hex characters.");
  if (override) return join(override, buildId);
  if (existsSync(boxRoot) && statSync(boxRoot).isDirectory())
    return join(boxRoot, "ree-to-blast", buildId);
  throw new Error(
    "This machine has no " +
      boxRoot +
      " directory. Pass --blast-dir. On the box the path is " +
      join(BOX_SHARED, "ree-to-blast", buildId) +
      ".",
  );
}

function weaknessesFromScout(scout) {
  if (!scout) return { weaknesses: [], dropped: 0 };
  const parsed = parseScoutTarget(scout);
  if (!parsed.ok) throw new Error("Scout record on the handoff was rejected.");
  let dropped = 0;
  const weaknesses = [];
  for (const item of parsed.target.weaknesses) {
    if (!item.evidence_urls[0]) {
      dropped += 1;
      continue;
    }
    weaknesses.push({
      type: item.type,
      summary: item.summary,
      source_url: item.evidence_urls[0],
      evidence_urls: item.evidence_urls,
      fetched_at: parsed.target.found_at,
    });
  }
  return { weaknesses, dropped, target_name: parsed.target.target_name };
}

function customerQuotes(spec) {
  return spec.limitations
    .filter((item) => item.statement?.attributed_quote && item.statement.text)
    .map((item) => ({
      text: item.statement.text,
      source_url: item.citations[0]?.url ?? null,
      fetched_at: item.citations[0]?.fetched_at ?? null,
    }))
    .filter((item) => item.source_url && item.fetched_at);
}

function pricingFrom(spec, scout) {
  if (scout) {
    const parsed = parseScoutTarget(scout);
    if (parsed.ok)
      return {
        plans: parsed.target.pricing.plans,
        model: parsed.target.pricing.model,
        sources: [
          {
            url: parsed.target.pricing.source_url,
            fetched_at: parsed.target.found_at,
          },
        ],
      };
  }
  return {
    plans: spec.pricing.plans.map((plan) => ({
      name: plan.name,
      display: plan.price?.display ?? null,
      source_url: plan.citations[0]?.url ?? null,
      fetched_at: plan.citations[0]?.fetched_at ?? null,
    })),
    model: null,
    sources: spec.pricing.plans.map((plan) => ({
      url: plan.citations[0]?.url ?? null,
      fetched_at: plan.citations[0]?.fetched_at ?? null,
    })),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Guard submission package. Writing it does not call Guard.
 * approval_requested records that a person asked to submit.
 */
export function buildGuardSubmission({
  projectDir,
  verify,
  repo = {},
  now = new Date(),
  approvalRequested = false,
}) {
  const provenance = readJson(join(projectDir, "provenance.json"));
  const spec = readJson(join(projectDir, "behavior-spec.json"));
  const manifest = readJson(join(projectDir, "package.json"));
  const lock = readJson(join(projectDir, "package-lock.json"));
  return {
    schema_version: GUARD_SCHEMA,
    submitted_at: now.toISOString(),
    sign_off: "not-submitted",
    approval_requested: approvalRequested === true,
    note: "Guard was not called. The submission package is ready for a person to send.",
    repo: {
      url: repo.url ?? null,
      branch: repo.branch ?? null,
      sha: repo.sha ?? null,
    },
    behavior_spec: spec,
    provenance,
    dependencies: { manifest, lockfile: lock },
    build: {
      steps: ["npm test"],
      env_var_names: [],
    },
    test_results: {
      schema_version: verify.schema_version,
      exit_code: verify.exit_code,
      implemented: verify.implemented,
      unimplemented: verify.unimplemented,
      failed: verify.failed,
      not_run: verify.not_run,
      total: verify.total,
      ratio: verify.ratio,
      features: verify.features,
    },
    third_party: [
      {
        name: "REE rebuild generator",
        license: "MIT",
        notice: "Copyright (c) 2026 morluto. See the REE repository LICENSE.",
      },
    ],
    secrets_included: false,
  };
}

/**
 * Write Guard, Blast, Scale, and Vault files.
 * Blast is not notified. Scale is not called. Vault is not copied. Guard is not called.
 * Approval flags record intent. dry_run stays true.
 */
export const REQUEST_SCHEMA = "ree.handoff.request.v1";

function publicPicks(picks, verify) {
  const source = Array.isArray(picks)
    ? picks
    : (verify.features ?? []).filter((feature) => feature.match === "pass");
  return source
    .filter((pick) => pick.match === undefined || pick.match === "pass")
    .map((pick) => ({
      id:
        typeof pick.id === "string" && pick.id.startsWith("pick_")
          ? pick.id
          : null,
      finding_id: pick.finding_id ?? null,
      feature_id: pick.feature_id ?? pick.id ?? null,
      name: pick.name ?? null,
      route: pick.route ?? null,
    }));
}

export function handoffRequest({
  to,
  buildId,
  productName,
  picks,
  approvalRequested,
  note,
}) {
  return {
    schema_version: REQUEST_SCHEMA,
    to,
    called: false,
    dry_run: true,
    build_id: buildId,
    product_name: productName,
    approval_requested: approvalRequested === true,
    picks,
    note,
  };
}

export function emitHandoff({
  projectDir,
  verify,
  scout = null,
  blastDir,
  repo = {},
  now = new Date(),
  approvals = {},
  picks = null,
}) {
  const asked = approvalFlags(approvals);
  const pickRows = publicPicks(picks, verify);
  const provenance = readJson(join(projectDir, "provenance.json"));
  const spec = readJson(join(projectDir, "behavior-spec.json"));
  const directory = blastDirectory({
    buildId: provenance.build_id,
    override: blastDir,
  });
  const scoutFacts = weaknessesFromScout(scout);
  const quotes = customerQuotes(spec);
  const forbidden = [spec.target.name, scoutFacts.target_name].filter(Boolean);
  const gaps = collectGaps({ projectDir, forbidden });
  const improvementsPath = join(projectDir, "improvements.json");
  const improvements = existsSync(improvementsPath)
    ? readJson(improvementsPath)
    : null;
  const shownImprovements = publicImprovements(improvements, forbidden);
  const summary =
    "Clean-room HTTP product. Each feature gets a data model, write rules, and CRUD routes. A path with one {name} segment gets get, update, and delete on the parent collection. Login, logout, findBy filters, and inventory counts are built when declared. Any other path template, or a method outside GET, POST, PUT, PATCH, and DELETE, is left out, with a reason. Stripe checkout stays off until an existing test key and price id are set. Market scores appear only when a Scout record supplied them.";
  for (const name of forbidden) {
    if (summary.includes(name) || provenance.product_name.includes(name))
      throw new Error("Customer-facing fields include a competitor name.");
  }
  const guard = buildGuardSubmission({
    projectDir,
    verify,
    repo,
    now,
    approvalRequested: asked.guard,
  });
  guard.picks = pickRows;
  const handoff = {
    schema_version: BLAST_SCHEMA,
    build_id: provenance.build_id,
    dry_run: true,
    notified_blast: false,
    launch_approved: asked.launch,
    blast_approval_requested: asked.blast,
    product_summary: summary,
    behavior_spec: spec,
    competitor_weaknesses: scoutFacts.weaknesses,
    feature_match: {
      implemented: verify.implemented,
      unimplemented: verify.unimplemented,
      failed: verify.failed,
      not_run: verify.not_run,
      total: verify.total,
      ratio: verify.ratio,
      meaning:
        "implemented counts features whose HTTP route tests passed. unimplemented features were not built. failed means a route test failed.",
    },
    differentiators: shownImprovements.items.map((item) => item.id),
    improvements: shownImprovements,
    repo: { url: repo.url ?? null },
    demo: null,
    customer: {
      who: null,
      problem: null,
      review_quotes: quotes,
    },
    pricing: pricingFrom(spec, scout),
    clean_room: {
      similarity: spec.similarity,
      statement: spec.clean_room_statement,
      original_code_viewed: false,
      original_code_copied: false,
    },
    guard: {
      sign_off: "not-submitted",
      legal_flags: [],
    },
    works_now: verify.features
      .filter((feature) => feature.match === "pass" && feature.route)
      .map(
        (feature) =>
          `${feature.route.method} ${feature.route.path} returns ${feature.route.success_status}.`,
      ),
    missing: [
      ...(verify.implemented === 0
        ? ["No feature could be built as HTTP CRUD, so no route was built."]
        : []),
      ...verify.features
        .filter((feature) => feature.match === "unimplemented")
        .map((feature) => `Unimplemented feature id ${feature.id}.`),
      ...verify.features
        .filter((feature) => feature.match === "fail")
        .map((feature) => `Route test failed for feature id ${feature.id}.`),
      ...verify.features
        .filter((feature) => feature.match === "not-run")
        .map((feature) => `Feature id ${feature.id} was not tested.`),
      "Guard sign-off.",
      "Tony launch approval.",
      ...(scoutFacts.dropped
        ? ["A Scout weakness had no evidence URL and was omitted."]
        : []),
    ],
    setup: {
      steps: verify.implemented > 0 ? ["npm test", "npm start"] : ["npm test"],
      passing_tests: verify.features
        .filter(
          (feature) =>
            feature.match === "pass" || feature.match === "unimplemented",
        )
        .map((feature) => feature.test_name),
    },
    risks: [
      "This handoff is a dry run.",
      "Unimplemented feature ids were not built.",
      "Guard has not returned PASS, CONDITIONAL PASS, or FAIL.",
    ],
    customer_facing_names_omitted: true,
    picks: pickRows,
    gaps,
  };
  const vault = {
    schema_version: VAULT_SCHEMA,
    name: provenance.product_name,
    version: "0.0.0-dry-run",
    stripe: { product_id: null, price_ids: [] },
    cost_sources: [],
    guard: "not-submitted",
    approved_for_vault_copy: false,
    approval_requested: asked.vault,
    paths: {
      code: projectDir,
      spec: join(projectDir, "behavior-spec.json"),
      evidence: null,
      provenance: join(projectDir, "provenance.json"),
      blast: directory,
    },
    env_var_names: [],
    secrets: "not-included",
    note: "Vault copy waits for Guard PASS. This file is the finance and artifact manifest only. approved_for_vault_copy stays false until a copy happens, and this writer does not copy.",
  };
  const scale = {
    schema_version: SCALE_SCHEMA,
    build_id: provenance.build_id,
    dry_run: true,
    notified_scale: false,
    approved: asked.scale,
    product_name: provenance.product_name,
    package: "product.tgz",
    note: "Scale was not called. This file is the handoff only.",
    picks: pickRows,
  };
  const requests = {
    guard: handoffRequest({
      to: "guard",
      buildId: provenance.build_id,
      productName: provenance.product_name,
      picks: pickRows,
      approvalRequested: asked.guard,
      note: "Guard was not called. This file is the request a person can send.",
    }),
    blast: handoffRequest({
      to: "blast",
      buildId: provenance.build_id,
      productName: provenance.product_name,
      picks: pickRows,
      approvalRequested: asked.blast,
      note: "Blast was not notified. This file is the request a person can send.",
    }),
    scale: handoffRequest({
      to: "scale",
      buildId: provenance.build_id,
      productName: provenance.product_name,
      picks: pickRows,
      approvalRequested: asked.scale,
      note: "Scale was not called. This file is the request a person can send.",
    }),
  };
  const readme = [
    `# ${provenance.product_name}`,
    "",
    "Dry run. This handoff is not a launch.",
    "",
    summary,
    "",
    "## Setup",
    "",
    "```sh",
    "npm test",
    ...(verify.implemented > 0 ? ["npm start"] : []),
    "```",
    "",
    `Routes whose tests passed: ${verify.implemented} of ${verify.total}.`,
    verify.implemented > 0
      ? "Those routes run in this package."
      : "No route test passed, so this handoff is not claiming a running feature.",
    `Unimplemented features: ${verify.unimplemented}.`,
    verify.unimplemented > 0
      ? "Unimplemented features are marked in the product and are not routes."
      : "No spec feature was left unimplemented.",
    `Failed route tests: ${verify.failed}.`,
    "",
    "Guard sign-off: not submitted. Guard was not called.",
    "Scale was not called.",
    "Vault was not copied.",
    "requests/guard.json, requests/blast.json, and requests/scale.json are the requests. Those systems were not called.",
    `Picks included with this handoff: ${pickRows.length}.`,
    asked.launch
      ? "Launch approval was recorded. This is still a dry run."
      : "Launch approval was not recorded.",
    "Competitor names are omitted from this file.",
    "",
    ...improvementLines(improvements, forbidden),
    ...gapLines(gaps),
  ].join("\n");
  for (const name of forbidden) {
    if (readme.includes(name))
      throw new Error("Blast README includes a competitor name: " + name);
  }
  mkdirSync(join(directory, "guard"), { recursive: true });
  mkdirSync(join(directory, "vault"), { recursive: true });
  mkdirSync(join(directory, "scale"), { recursive: true });
  mkdirSync(join(directory, "requests"), { recursive: true });
  writeFileSync(
    join(directory, "handoff.json"),
    JSON.stringify(handoff, null, 2) + "\n",
  );
  writeFileSync(join(directory, "README.md"), readme);
  writeFileSync(
    join(directory, "guard/submission.json"),
    JSON.stringify(guard, null, 2) + "\n",
  );
  writeFileSync(
    join(directory, "vault/manifest.json"),
    JSON.stringify(vault, null, 2) + "\n",
  );
  writeFileSync(
    join(directory, "scale/manifest.json"),
    JSON.stringify(scale, null, 2) + "\n",
  );
  for (const [name, document] of Object.entries(requests)) {
    writeFileSync(
      join(directory, "requests", name + ".json"),
      JSON.stringify(document, null, 2) + "\n",
    );
  }
  return { directory, handoff, guard, vault, scale, requests, gaps };
}
