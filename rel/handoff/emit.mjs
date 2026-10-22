import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseScoutTarget } from "../opportunities/parse.mjs";

export const BLAST_SCHEMA = "ree.blast.handoff.v1";
export const GUARD_SCHEMA = "ree.guard.submission.v1";
export const VAULT_SCHEMA = "ree.vault.manifest.v1";
export const BOX_SHARED = "/home/box/shared";

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
 * Write Guard, Blast, and Vault files.
 * Blast is not notified. Vault is not copied. Guard is not called.
 * dry_run stays true until a caller passes a Guard PASS and that is still not a launch.
 */
export function emitHandoff({
  projectDir,
  verify,
  scout = null,
  blastDir,
  repo = {},
  now = new Date(),
}) {
  const provenance = readJson(join(projectDir, "provenance.json"));
  const spec = readJson(join(projectDir, "behavior-spec.json"));
  const manifest = readJson(join(projectDir, "package.json"));
  const lock = readJson(join(projectDir, "package-lock.json"));
  const directory = blastDirectory({
    buildId: provenance.build_id,
    override: blastDir,
  });
  const scoutFacts = weaknessesFromScout(scout);
  const quotes = customerQuotes(spec);
  const forbidden = [spec.target.name, scoutFacts.target_name].filter(Boolean);
  const summary =
    "Clean-room scaffold. Feature declarations come from a public behavior spec. Market scores appear only when a Scout record supplied them.";
  for (const name of forbidden) {
    if (summary.includes(name) || provenance.product_name.includes(name))
      throw new Error("Customer-facing fields include a competitor name.");
  }
  const guard = {
    schema_version: GUARD_SCHEMA,
    submitted_at: now.toISOString(),
    sign_off: "not-submitted",
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
      accounted: verify.accounted,
      missing: verify.missing,
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
  const handoff = {
    schema_version: BLAST_SCHEMA,
    build_id: provenance.build_id,
    dry_run: true,
    notified_blast: false,
    product_summary: summary,
    behavior_spec: spec,
    competitor_weaknesses: scoutFacts.weaknesses,
    feature_match: {
      accounted: verify.accounted,
      missing: verify.missing,
      total: verify.total,
      ratio: verify.ratio,
      meaning:
        "Ratio of spec features declared in the scaffold. Not a running-product match.",
    },
    differentiators: [],
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
    works_now:
      verify.accounted > 0
        ? ["Declared feature ids are listed in src/behaviors.mjs."]
        : [],
    missing: [
      "Running product behavior.",
      "Guard sign-off.",
      "Tony launch approval.",
      ...(scoutFacts.dropped
        ? ["A Scout weakness had no evidence URL and was omitted."]
        : []),
    ],
    setup: {
      steps: ["npm test"],
      passing_tests: verify.features
        .filter((feature) => feature.match === "accounted")
        .map((feature) => feature.test_name),
    },
    risks: [
      "This handoff is a dry run.",
      "Declaration match is not evidence the feature works.",
      "Guard has not returned PASS, CONDITIONAL PASS, or FAIL.",
    ],
    customer_facing_names_omitted: true,
  };
  const vault = {
    schema_version: VAULT_SCHEMA,
    name: provenance.product_name,
    version: "0.0.0-dry-run",
    stripe: { product_id: null, price_ids: [] },
    cost_sources: [],
    guard: "not-submitted",
    approved_for_vault_copy: false,
    paths: {
      code: projectDir,
      spec: join(projectDir, "behavior-spec.json"),
      evidence: null,
      provenance: join(projectDir, "provenance.json"),
      blast: directory,
    },
    env_var_names: [],
    secrets: "not-included",
    note: "Vault copy waits for Guard PASS. This file is the finance and artifact manifest only.",
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
    "```",
    "",
    `Declared features accounted: ${verify.accounted} of ${verify.total}.`,
    "A declaration is not a running feature.",
    "",
    "Guard sign-off: not submitted.",
    "Competitor names are omitted from this file.",
    "",
  ].join("\n");
  for (const name of forbidden) {
    if (readme.includes(name))
      throw new Error("Blast README includes a competitor name: " + name);
  }
  mkdirSync(join(directory, "guard"), { recursive: true });
  mkdirSync(join(directory, "vault"), { recursive: true });
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
  return { directory, handoff, guard, vault };
}
