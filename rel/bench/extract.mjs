import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownedDocsBodies } from "../ingest/docs.mjs";
import { evidenceTimeline } from "../studio/theater.mjs";

const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function modulePath(node) {
  if (node?.identity?.namespace !== "source-module") return null;
  const key = node.identity.key;
  if (typeof key !== "string" || !key.includes(":")) return null;
  return key.slice(key.lastIndexOf(":") + 1);
}

function problemsForFact(parentId, evidence, location) {
  const problems = [];
  if (!EVIDENCE_ID.test(parentId ?? ""))
    problems.push("parent evidence id is missing");
  if (!evidence || typeof evidence !== "object")
    return [...problems, "fact evidence is missing"];
  if (!["observed", "inferred", "derived"].includes(evidence.state))
    problems.push(`state ${String(evidence.state)} is not a retained fact`);
  const digest = evidence.artifact?.sha256;
  if (evidence.artifact?.available !== true || !SHA256.test(digest ?? ""))
    problems.push("artifact digest is missing");
  if (location?.available !== true) problems.push("source location is missing");
  if (
    evidence.authority === "static-relationship-inference" &&
    evidence.state !== "inferred"
  )
    problems.push("static relationship is not marked inferred");
  if (evidence.state === "inferred") {
    if (!["high", "medium", "low"].includes(evidence.confidence))
      problems.push("inferred fact has no high, medium, or low confidence");
    if (
      !Array.isArray(evidence.limitations) ||
      evidence.limitations.length === 0
    )
      problems.push("inferred fact has no limitation");
  }
  if (Array.isArray(evidence.evidence_ids)) {
    for (const id of evidence.evidence_ids) {
      if (!EVIDENCE_ID.test(id))
        problems.push(`evidence id ${String(id)} is invalid`);
    }
  }
  return problems;
}

function semanticEvidence(record, node) {
  const contexts = record.normalized_result?.semantic_graph?.evidence_contexts;
  const context = (contexts ?? []).find(
    (item) => item.context_id === node.evidence?.context_id,
  );
  return {
    evidence: context ?? null,
    location: node.evidence?.location ?? null,
    missingContext: context == null,
  };
}

/** Findings REE can read from one analyze-javascript-application Evidence record. */
export function javascriptFindings(record) {
  const parentId = record?.evidence_id;
  const graph = record?.normalized_result?.graph;
  const semantic = record?.normalized_result?.semantic_graph;
  const nodes = new Map(
    (graph?.nodes ?? []).map((node) => [node.node_id, node]),
  );
  const semanticNodes = new Map(
    (semantic?.nodes ?? []).map((node) => [node.node_id, node]),
  );
  const findings = {
    module: [],
    function: [],
    import: [],
    call: [],
    endpoint: [],
    string: [],
    behavior: [],
  };
  const provenance = [];
  const seen = new Set();
  const add = (type, key, evidence, location) => {
    if (!key || seen.has(`${type}\0${key}`)) return;
    seen.add(`${type}\0${key}`);
    const problems = problemsForFact(parentId, evidence, location);
    findings[type].push(key);
    if (problems.length > 0) provenance.push({ type, key, problems });
  };

  for (const node of graph?.nodes ?? []) {
    const path = modulePath(node);
    if (!path) continue;
    const observation = node.observations?.[0];
    add("module", path, observation?.evidence, observation?.evidence?.location);
  }

  for (const edge of graph?.edges ?? []) {
    if (edge.relation !== "imports") continue;
    if (edge.properties?.resolution_status !== "resolved") continue;
    const from = modulePath(nodes.get(edge.source_node_id));
    const to = edge.properties?.resolved_path;
    if (!from || typeof to !== "string") continue;
    if (edge.evidence?.state === "observed")
      provenance.push({
        type: "import",
        key: `${from}->${to}`,
        problems: ["static import is marked observed"],
      });
    add("import", `${from}->${to}`, edge.evidence, edge.evidence?.location);
  }

  for (const node of semantic?.nodes ?? []) {
    const resolved = semanticEvidence(record, node);
    if (resolved.missingContext)
      provenance.push({
        type: node.kind,
        key: node.label ?? node.node_id,
        problems: ["semantic evidence context is missing"],
      });
    if (node.kind === "function" && node.properties?.name) {
      add(
        "function",
        `${node.identity.module_path}:${node.properties.name}`,
        resolved.evidence,
        resolved.location,
      );
    }
    if (node.kind === "literal" && typeof node.properties?.value === "string") {
      add(
        "string",
        node.properties.value,
        resolved.evidence,
        resolved.location,
      );
    }
    if (
      node.kind === "expression" &&
      typeof node.properties?.behavior === "string" &&
      typeof node.properties?.detail === "string"
    ) {
      const owner = node.function_node_id
        ? semanticNodes.get(node.function_node_id)
        : null;
      const ownerName = owner?.properties?.name;
      const module = owner?.identity?.module_path;
      if (typeof ownerName === "string" && typeof module === "string") {
        const key = `${module}:${ownerName} ${node.properties.behavior} ${node.properties.detail}`;
        if (resolved.evidence?.state === "observed")
          provenance.push({
            type: "behavior",
            key,
            problems: ["behavior is marked observed"],
          });
        add("behavior", key, resolved.evidence, resolved.location);
      }
    }
  }

  for (const relation of semantic?.relations ?? []) {
    if (relation.relation !== "calls" || relation.resolution !== "resolved")
      continue;
    const site = semanticNodes.get(relation.source_node_id);
    const callee = semanticNodes.get(relation.target_node_id);
    const caller = site?.function_node_id
      ? semanticNodes.get(site.function_node_id)
      : null;
    if (!caller?.properties?.name || !callee?.properties?.name) continue;
    const callerEvidence = semanticEvidence(record, caller);
    add(
      "call",
      `${caller.identity.module_path}:${caller.properties.name}->${callee.identity.module_path}:${callee.properties.name}`,
      callerEvidence.evidence,
      site?.evidence?.location,
    );
  }

  const notes = [];
  const linkedCallSites = new Set(
    (semantic?.relations ?? [])
      .filter(
        (relation) =>
          relation.relation === "calls" && relation.resolution === "resolved",
      )
      .map((relation) => relation.source_node_id),
  );
  const unresolvedImports = (semantic?.nodes ?? []).filter(
    (node) =>
      node.kind === "call-site" &&
      typeof node.properties?.imported_specifier === "string" &&
      !linkedCallSites.has(node.node_id),
  ).length;
  if (unresolvedImports > 0)
    notes.push(
      `${unresolvedImports} imported call sites stayed unresolved. External modules, re-exports, and ambiguous exports are not call edges.`,
    );
  const stats = record?.normalized_result?.statistics;
  const sourceModules = findings.module.length;
  if (stats?.modules === 0 && sourceModules > 0)
    notes.push(
      "statistics.modules is 0. That field counts bundler registrations, not source modules.",
    );
  const timeline = evidenceTimeline(record).find(
    (event) => event.phase === "statistics",
  );
  if (
    sourceModules > 0 &&
    timeline &&
    !timeline.message.includes(`${sourceModules} source modules`)
  )
    provenance.push({
      type: "module",
      key: "timeline",
      problems: ["timeline source-module count disagrees with Evidence"],
    });

  return { findings, provenance, notes };
}

function quoteText(quote) {
  return quote && typeof quote.text === "string" ? quote.text : null;
}

function sourceBodies(fixtureDir) {
  const manifest = JSON.parse(
    readFileSync(join(fixtureDir, "manifest.json"), "utf8"),
  );
  const bodies = new Map();
  for (const [url, entry] of Object.entries(manifest.responses ?? {})) {
    if (typeof entry.file !== "string") continue;
    bodies.set(url, readFileSync(join(fixtureDir, entry.file), "utf8"));
  }
  return bodies;
}

function cited(spec, citation, bodies) {
  const problems = [];
  if (!citation || typeof citation.url !== "string")
    return ["citation url is missing"];
  const source = (spec.sources ?? []).find((item) => item.url === citation.url);
  if (!source) problems.push(`citation ${citation.url} has no source record`);
  else if (!SHA256.test(source.sha256 ?? ""))
    problems.push(`source ${citation.url} has no sha256`);
  else {
    const body = bodies.get(citation.url);
    if (body == null) problems.push(`fixture has no body for ${citation.url}`);
    else if (createHash("sha256").update(body).digest("hex") !== source.sha256)
      problems.push(
        `source sha256 does not match the fixture body for ${citation.url}`,
      );
  }
  if (Number.isNaN(Date.parse(citation.fetched_at ?? "")))
    problems.push("citation fetched_at is not a time");
  return problems;
}

function textInBody(bodies, url, text) {
  const body = bodies.get(url) ?? "";
  return body.includes(text);
}

/** Findings from an outside-in behavior spec, checked against the fixture bytes. */
export function outsideInFindings(spec, fixtureDir, options = {}) {
  const bodies = options.bodies ?? sourceBodies(fixtureDir);
  const findings = {
    module: [],
    function: [],
    import: [],
    call: [],
    endpoint: [],
    string: [],
    behavior: [],
    resource: [],
  };
  const provenance = [];
  const seen = new Set();
  const add = (type, key, problems) => {
    if (!key || seen.has(`${type}\0${key}`)) return;
    seen.add(`${type}\0${key}`);
    findings[type].push(key);
    if (problems.length > 0) provenance.push({ type, key, problems });
  };
  if (spec?.llm?.ree_remote_calls !== "not-performed")
    provenance.push({
      type: "behavior",
      key: "llm",
      problems: ["outside-in recorded a remote model call"],
    });

  for (const feature of spec?.features ?? []) {
    const citation = feature.citations?.[0];
    const problems = cited(spec, citation, bodies);
    if (feature.name && !textInBody(bodies, citation?.url, feature.name))
      problems.push("feature name is not in the cited document");
    const quote = quoteText(feature.quote);
    if (quote && !textInBody(bodies, citation?.url, quote))
      problems.push("feature quote is not in the cited document");
    add("behavior", feature.name, problems);
    if (quote) {
      add("string", quote, problems);
      add("behavior", quote, problems);
    }
  }
  for (const endpoint of spec?.api?.endpoints ?? []) {
    const citation = endpoint.citations?.[0];
    const problems = cited(spec, citation, bodies);
    const key = [
      endpoint.method,
      endpoint.path,
      endpoint.operation_id,
      ...(endpoint.parameters ?? []),
    ].join(" ");
    const summary = quoteText(endpoint.summary);
    if (summary && !textInBody(bodies, citation?.url, summary))
      problems.push("endpoint summary is not in the cited document");
    if (endpoint.method && !textInBody(bodies, citation?.url, endpoint.path))
      problems.push("endpoint path is not in the cited document");
    add("endpoint", key, problems);
    if (summary) add("string", summary, problems);
    for (const parameter of endpoint.parameters ?? []) {
      if (!textInBody(bodies, citation?.url, parameter))
        problems.push(`parameter ${parameter} is not in the cited document`);
      add("string", parameter, problems);
    }
    if (options.resources && endpoint.path)
      add("resource", endpoint.path, problems);
  }
  if (options.pricing) addPlanFindings(spec, bodies, add);
  return { findings, provenance, notes: [] };
}

function addPlanFindings(spec, bodies, add) {
  for (const plan of spec?.pricing?.plans ?? []) {
    const citation = plan.citations?.[0];
    const problems = cited(spec, citation, bodies);
    if (plan.name && !textInBody(bodies, citation?.url, plan.name))
      problems.push("pricing tier name is not in the cited document");
    add("behavior", plan.name, problems);
    const price = plan.price?.display;
    if (price && !textInBody(bodies, citation?.url, price))
      problems.push("pricing tier price is not in the cited document");
    if (price) add("string", price, problems);
  }
}

/** Docs-directory ingest, checked against the owned files those URLs name. */
export function ingestDocsFindings(spec, docsDir) {
  return outsideInFindings(spec, docsDir, {
    bodies: ownedDocsBodies(docsDir),
    resources: true,
    pricing: true,
  });
}

function isFunctionSymbol(type) {
  // The layout schema allows a name or the ELF integer. The pwntools provider emits "STT_FUNC".
  return type === "STT_FUNC" || type === 2;
}

/** Function symbols and bounded file-backed string literals from inspect-binary-layout Evidence. */
export function elfFindings(record) {
  const layout = record?.normalized_result;
  const findings = {
    module: [],
    function: [],
    import: [],
    call: [],
    endpoint: [],
    string: [],
    behavior: [],
  };
  const provenance = [];
  const parentId = record?.evidence_id;
  if (!EVIDENCE_ID.test(parentId ?? ""))
    provenance.push({
      type: "function",
      key: "evidence",
      problems: ["binary layout Evidence id is missing"],
    });
  const digest = layout?.artifact?.sha256;
  if (!SHA256.test(digest ?? ""))
    provenance.push({
      type: "function",
      key: "artifact",
      problems: ["binary layout artifact sha256 is missing"],
    });
  for (const symbol of layout?.symbols ?? []) {
    if (!isFunctionSymbol(symbol.type)) continue;
    const name = symbol.name?.display;
    if (!name) continue;
    findings.function.push(name);
    if (symbol.name?.location == null || symbol.location == null)
      provenance.push({
        type: "function",
        key: name,
        problems: ["function symbol has no byte location"],
      });
  }
  const notes = [];
  if (!Array.isArray(layout?.strings))
    notes.push(
      "inspect-binary-layout did not return a strings array, so rodata text is not a finding.",
    );
  else
    for (const literal of layout.strings) {
      if (typeof literal?.value !== "string" || literal.value.length === 0)
        continue;
      findings.string.push(literal.value);
      if (literal.location?.offset == null || literal.location?.bytes == null)
        provenance.push({
          type: "string",
          key: literal.value,
          problems: ["string literal has no file offset"],
        });
    }
  return { findings, provenance, notes };
}

function emptyFindings() {
  return {
    module: [],
    function: [],
    import: [],
    call: [],
    endpoint: [],
    string: [],
    behavior: [],
    resource: [],
  };
}

function evidenceProblems(record) {
  const problems = [];
  if (!EVIDENCE_ID.test(record?.evidence_id ?? ""))
    problems.push("evidence id is missing");
  if (!["observed", "derived", "inferred"].includes(record?.confidence))
    problems.push("evidence confidence is missing");
  const digest = record?.normalized_result?.artifact?.sha256;
  if (!SHA256.test(digest ?? "")) problems.push("artifact sha256 is missing");
  return problems;
}

function limitationNote(record, fallback) {
  const seen = new Set();
  const lines = [];
  for (const line of [
    ...(record?.normalized_result?.limitations ?? []),
    ...(record?.limitations ?? []),
  ]) {
    if (typeof line !== "string" || line.length === 0 || seen.has(line))
      continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join(" ") || fallback;
}

function identityKey(identity) {
  if (identity?.kind === "id") return String(identity.id);
  if (identity?.kind === "name") return JSON.stringify(identity.name);
  return "unknown";
}

/** Go compiler, module, and dependency identities from inspect-go-binary Evidence. */
export function goFindings(record) {
  const findings = emptyFindings();
  const provenance = [];
  const layout = record?.normalized_result;
  const shared = evidenceProblems(record);
  const info = layout?.build_info ?? null;
  const notes = [];
  if (info === null) {
    notes.push(
      limitationNote(
        record,
        "partial: inspect-go-binary returned no build info and no limitation.",
      ),
    );
    if (shared.length > 0)
      provenance.push({ type: "module", key: "evidence", problems: shared });
    return { findings, provenance, notes };
  }
  if (typeof info.module?.path === "string" && info.module.path.length > 0)
    findings.module.push(info.module.path);
  if (
    typeof info.module?.main?.path === "string" &&
    info.module.main.path.length > 0
  )
    findings.module.push(info.module.main.path);
  if (typeof info.go_version === "string" && info.go_version.length > 0)
    findings.string.push(info.go_version);
  for (const dependency of info.module?.dependencies ?? []) {
    if (typeof dependency?.path !== "string" || dependency.path.length === 0)
      continue;
    const version =
      typeof dependency.version === "string" ? dependency.version : "";
    findings.import.push(`${dependency.path} ${version}`.trim());
  }
  for (const field of ["version_location", "module_location"]) {
    const range = info[field];
    if (range?.offset == null || range?.bytes == null)
      shared.push(`${field} has no file range`);
  }
  if (shared.length > 0)
    provenance.push({
      type: "module",
      key: info.module?.path ?? "go",
      problems: shared,
    });
  return { findings, provenance, notes };
}

/** Cargo-auditable packages from inspect-rust-binary Evidence. */
export function rustFindings(record) {
  const findings = emptyFindings();
  const provenance = [];
  const layout = record?.normalized_result;
  const shared = evidenceProblems(record);
  const metadata = layout?.auditable_metadata ?? null;
  const notes = [];
  if (metadata === null) {
    notes.push(
      limitationNote(
        record,
        "partial: inspect-rust-binary returned no dependency section and no limitation.",
      ),
    );
    if (shared.length > 0)
      provenance.push({ type: "module", key: "evidence", problems: shared });
    return { findings, provenance, notes };
  }
  const packages = metadata.packages ?? [];
  for (const pkg of packages) {
    if (typeof pkg?.name === "string" && typeof pkg?.version === "string")
      findings.module.push(`${pkg.name} ${pkg.version}`);
  }
  for (const edge of metadata.dependency_edges ?? []) {
    const from = packages[edge?.from_index];
    const to = packages[edge?.to_index];
    if (typeof from?.name === "string" && typeof to?.name === "string")
      findings.import.push(`${from.name}->${to.name}`);
  }
  if (metadata.file_offset == null || metadata.section_bytes == null)
    shared.push("dependency section has no file range");
  const commit = layout?.rustc_commit ?? null;
  if (commit !== null) {
    if (commit.evidence_kind !== "inferred")
      shared.push("rustc commit must stay inferred");
    for (const hash of commit.hashes ?? []) {
      if (typeof hash?.hash !== "string") continue;
      findings.string.push(hash.hash);
      if (hash.file_offset == null)
        shared.push("rustc hash has no file offset");
    }
  }
  if (shared.length > 0)
    provenance.push({
      type: "module",
      key: packages[0]?.name ?? "rust",
      problems: shared,
    });
  return { findings, provenance, notes };
}

/** Resource identities from inspect-pe-resources Evidence. */
export function peResourceFindings(record) {
  const findings = emptyFindings();
  const provenance = [];
  const layout = record?.normalized_result;
  const shared = evidenceProblems(record);
  const notes = [];
  if (!Array.isArray(layout?.resources))
    notes.push(
      "partial: inspect-pe-resources did not return a resources array.",
    );
  for (const resource of layout?.resources ?? []) {
    const key = [resource?.type, resource?.name, resource?.language]
      .map(identityKey)
      .join("/");
    findings.resource.push(key);
    const range = resource?.payload?.location;
    const digest = resource?.payload?.sha256;
    const problems = [];
    if (range?.offset == null || range?.bytes == null)
      problems.push("resource payload has no file range");
    if (!SHA256.test(digest ?? ""))
      problems.push("resource payload sha256 is missing");
    if (problems.length > 0)
      provenance.push({ type: "resource", key, problems });
  }
  if (shared.length > 0)
    provenance.push({ type: "resource", key: "evidence", problems: shared });
  return { findings, provenance, notes };
}
