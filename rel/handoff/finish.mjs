import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { plannedCoverage } from "../rebuild/coverage.mjs";
import { planProduct } from "../rebuild/scaffold.mjs";
import { readGeneratedArray, verifyRebuild } from "../rebuild/verify.mjs";
import { redactText } from "../secrets/redact.mjs";

export const FINISH_SCHEMA = "ree.finish.v1";

const FILE_CANDIDATES = [
  "src/routes.mjs",
  "src/server.mjs",
  "test/product.test.mjs",
  "coverage.json",
  "FEATURE_REPORT.md",
  "openapi.json",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, redactText(JSON.stringify(value, null, 2)) + "\n");
}

function endpointKey(method, path) {
  return `${String(method ?? "").toUpperCase()} ${path ?? ""}`.trim();
}

function ticketSlug(method, path) {
  const slug = `${method}-${path ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "operation";
}

function successCode(codes) {
  for (const code of codes ?? []) {
    const number = Number(code);
    if (Number.isInteger(number) && number >= 200 && number < 300)
      return number;
  }
  return null;
}

function excerptFor(endpoint, forbidden) {
  const excerpt = {
    method: endpoint?.method ?? null,
    path: typeof endpoint?.path === "string" ? endpoint.path : null,
    operation_id: endpoint?.operation_id ?? null,
    parameters: Array.isArray(endpoint?.parameters) ? endpoint.parameters : [],
    response_codes: Array.isArray(endpoint?.response_codes)
      ? endpoint.response_codes
      : [],
  };
  if (typeof endpoint?.body === "string") excerpt.body = endpoint.body;
  if (Array.isArray(endpoint?.fields) && endpoint.fields.length > 0)
    excerpt.fields = endpoint.fields;
  if (endpoint?.summary !== undefined) excerpt.summary = endpoint.summary;
  if (Array.isArray(endpoint?.citations))
    excerpt.citations = endpoint.citations;
  const omitted = [];
  for (const key of Object.keys(excerpt)) {
    if (key === "method" || key === "path" || key === "operation_id") continue;
    const text = JSON.stringify(excerpt[key]);
    if (forbidden.some((name) => name && text.includes(name))) {
      omitted.push(key);
      delete excerpt[key];
    }
  }
  if (omitted.length > 0) excerpt.omitted_fields = omitted;
  return excerpt;
}

function acceptanceTests(excerpt, reason) {
  const method = String(excerpt.method ?? "").toUpperCase();
  const path = excerpt.path ?? "(no path)";
  const name = `endpoint ${method} ${path}`;
  const success = successCode(excerpt.response_codes);
  const lines = [
    `Write a product test named "${name}".`,
    success === null
      ? "The spec excerpt has no 2xx response code. Do not invent a success status."
      : `Request ${method} ${path} and assert status ${success}, the success status on the spec excerpt.`,
  ];
  if (Array.isArray(excerpt.parameters) && excerpt.parameters.length > 0) {
    const names = excerpt.parameters
      .map((item) => (typeof item === "string" ? item : item?.name))
      .filter((item) => typeof item === "string");
    if (names.length > 0)
      lines.push(
        `Use the recorded parameters (${names.join(", ")}). Do not add parameters the excerpt does not name.`,
      );
  }
  if (excerpt.body === "json")
    lines.push(
      "Send a JSON object of the recorded fields. Do not add fields the excerpt does not name.",
    );
  else if (Array.isArray(excerpt.fields) && excerpt.fields.length > 0)
    lines.push(
      `Recorded fields: ${excerpt.fields
        .map((field) => field.name)
        .filter(Boolean)
        .join(", ")}.`,
    );
  lines.push(
    "The test must call fetch and assert the status. A test that does not request this path does not close the ticket.",
  );
  lines.push(`REE left this operation out because: ${reason}.`);
  return lines;
}

function filesToTouch(projectDir) {
  return FILE_CANDIDATES.filter((name) => existsSync(join(projectDir, name)));
}

function skippedOperations(spec) {
  const grouped = new Map();
  for (const item of planProduct(spec).skipped ?? []) {
    const key = endpointKey(item.method, item.path);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        method: String(item.method ?? "").toUpperCase(),
        path: item.path ?? null,
        operation_id: item.operation_id ?? null,
        reasons: [item.reason],
      });
      continue;
    }
    if (item.reason && !current.reasons.includes(item.reason))
      current.reasons.push(item.reason);
    if (!current.operation_id && item.operation_id)
      current.operation_id = item.operation_id;
  }
  return [...grouped.values()];
}

function findEndpoint(spec, operation) {
  return (spec.api?.endpoints ?? []).find(
    (endpoint) =>
      endpointKey(endpoint.method, endpoint.path) ===
      endpointKey(operation.method, operation.path),
  );
}

export function buildFinishTickets({ projectDir, forbidden = [] }) {
  const spec = readJson(join(projectDir, "behavior-spec.json"));
  const provenance = readJson(join(projectDir, "provenance.json"));
  const files = filesToTouch(projectDir);
  const used = new Set();
  const tickets = [];
  for (const operation of skippedOperations(spec)) {
    let id = ticketSlug(operation.method, operation.path);
    if (used.has(id)) {
      let suffix = 2;
      while (used.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    used.add(id);
    const endpoint = findEndpoint(spec, operation) ?? operation;
    const excerpt = excerptFor(endpoint, forbidden);
    const reason = operation.reasons.filter(Boolean).join("; ");
    tickets.push({
      schema_version: FINISH_SCHEMA,
      id,
      status: "open",
      build_id: provenance.build_id,
      operation: {
        method: operation.method,
        path: operation.path,
        operation_id: operation.operation_id,
      },
      spec_excerpt: excerpt,
      reason,
      acceptance_tests: acceptanceTests(excerpt, reason),
      files,
    });
  }
  return { buildId: provenance.build_id, tickets };
}

export function writeFinishTickets({ directory, projectDir, forbidden = [] }) {
  const built = buildFinishTickets({ projectDir, forbidden });
  const finishDir = join(directory, "finish");
  mkdirSync(finishDir, { recursive: true });
  const listed = [];
  for (const ticket of built.tickets) {
    const file = join("finish", `${ticket.id}.json`);
    writeJson(join(directory, file), ticket);
    listed.push({
      id: ticket.id,
      status: ticket.status,
      file,
      method: ticket.operation.method,
      path: ticket.operation.path,
      reason: ticket.reason,
    });
  }
  const index = {
    schema_version: FINISH_SCHEMA,
    role: "index",
    build_id: built.buildId,
    product_dir: relative(directory, resolve(projectDir)),
    open: listed.length,
    closed: 0,
    tickets: listed,
  };
  writeJson(join(directory, "finish.json"), index);
  return { index, tickets: built.tickets };
}

function endpointResults(verify) {
  const passed = new Set();
  const failed = new Set();
  const output = `${verify.stdout ?? ""}\n${verify.stderr ?? ""}`;
  for (const line of output.split("\n")) {
    const ok = /^ok \d+ - (.*)$/u.exec(line.trim());
    const notOk = /^not ok \d+ - (.*)$/u.exec(line.trim());
    const name = (ok ?? notOk)?.[1]?.replace(/ # .*$/u, "") ?? "";
    if (!name.startsWith("endpoint ")) continue;
    const key = name.slice("endpoint ".length);
    if (ok) passed.add(key);
    else failed.add(key);
  }
  return { passed, failed };
}

function testProves(source, key) {
  const name = `endpoint ${key}`;
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(name, from);
    if (at < 0) return false;
    const next = source.indexOf("\ntest(", at + name.length);
    const body = source.slice(at, next === -1 ? source.length : next);
    if (body.includes("fetch(") && body.includes("assert")) return true;
    from = at + name.length;
  }
  return false;
}

function readRoutes(projectDir) {
  try {
    return readGeneratedArray(
      readFileSync(join(projectDir, "src/routes.mjs"), "utf8"),
      "routes",
    );
  } catch {
    return [];
  }
}

const ASSERTED_ACTIONS = new Set([
  "create",
  "list",
  "read",
  "replace",
  "merge",
  "remove",
  "login",
  "logout",
  "filter",
  "inventory",
]);

export function operationClosed({
  operation,
  routes,
  passed,
  failed,
  testSource,
}) {
  const key = endpointKey(operation.method, operation.path);
  if (!passed.has(key) || failed.has(key)) return false;
  const route = routes.find(
    (item) => endpointKey(item.method, item.path) === key,
  );
  if (!route) return false;
  if (testProves(testSource, key)) return true;
  return route.declared === true && ASSERTED_ACTIONS.has(route.action);
}

function loadTickets(directory) {
  const indexPath = join(directory, "finish.json");
  if (!existsSync(indexPath)) return [];
  const index = readJson(indexPath);
  return (index.tickets ?? []).map((item) =>
    readJson(join(directory, item.file)),
  );
}

function measureEndpoints({
  spec,
  routes,
  passed,
  failed,
  testSource,
  tickets,
}) {
  const byKey = new Map(
    tickets.map((ticket) => [
      endpointKey(ticket.operation.method, ticket.operation.path),
      ticket,
    ]),
  );
  let built = 0;
  for (const endpoint of spec.api?.endpoints ?? []) {
    const key = endpointKey(endpoint.method, endpoint.path);
    const ticket = byKey.get(key);
    if (ticket) {
      if (
        operationClosed({
          operation: ticket.operation,
          routes,
          passed,
          failed,
          testSource,
        })
      )
        built += 1;
      continue;
    }
    const declared = routes.some(
      (route) => endpointKey(route.method, route.path) === key,
    );
    if (declared && passed.has(key) && !failed.has(key)) built += 1;
  }
  const total = spec.api?.endpoints?.length ?? 0;
  return {
    built,
    not_built: total - built,
    total,
    ratio: total === 0 ? null : built / total,
    source: FINISH_SCHEMA,
  };
}

function handoffChildren(dir) {
  const root = join(dir, "handoff");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(root, entry.name, "handoff.json")),
    )
    .map((entry) => join(root, entry.name));
}

export function resolveFinishLayout(dir) {
  const abs = resolve(dir);
  if (existsSync(join(abs, "handoff.json"))) {
    const indexPath = join(abs, "finish.json");
    if (!existsSync(indexPath))
      throw new Error(
        "This handoff has no finish.json. Run handoff so the not-built operations are ticketed.",
      );
    const index = readJson(indexPath);
    const productDir = resolve(abs, index.product_dir ?? "");
    if (!existsSync(join(productDir, "behavior-spec.json")))
      throw new Error("finish.json does not point at the product directory.");
    return { handoffDir: abs, productDir };
  }
  if (existsSync(join(abs, "behavior-spec.json"))) {
    const provenance = readJson(join(abs, "provenance.json"));
    const sibling = resolve(abs, "..", "handoff", provenance.build_id);
    if (!existsSync(join(sibling, "handoff.json")))
      throw new Error(
        "This product has no handoff next to it. Run handoff before finish.",
      );
    return resolveFinishLayout(sibling);
  }
  const children = handoffChildren(abs);
  if (children.length === 1) return resolveFinishLayout(children[0]);
  if (children.length > 1)
    throw new Error(
      "This directory has more than one handoff. Pass the product directory or one handoff directory.",
    );
  throw new Error(
    "Use finish DIR for a product directory, a handoff directory, or a pipeline output directory.",
  );
}

export function finishProduct(dir) {
  const layout = resolveFinishLayout(dir);
  const spec = readJson(join(layout.productDir, "behavior-spec.json"));
  let tickets = loadTickets(layout.handoffDir);
  if (!existsSync(join(layout.handoffDir, "finish.json"))) {
    writeFinishTickets({
      directory: layout.handoffDir,
      projectDir: layout.productDir,
      forbidden: [spec.target?.name].filter(Boolean),
    });
    tickets = loadTickets(layout.handoffDir);
  }
  const verify = verifyRebuild(layout.productDir);
  const routes = readRoutes(layout.productDir);
  const testPath = join(layout.productDir, "test/product.test.mjs");
  const testSource = existsSync(testPath) ? readFileSync(testPath, "utf8") : "";
  const results = endpointResults(verify);
  const updated = tickets.map((ticket) => {
    const closed = operationClosed({
      operation: ticket.operation,
      routes,
      passed: results.passed,
      failed: results.failed,
      testSource,
    });
    const next = { ...ticket, status: closed ? "closed" : "open" };
    if (closed) next.closed_by = "endpoint test passed";
    else delete next.closed_by;
    return next;
  });
  for (const ticket of updated) {
    const file = join("finish", `${ticket.id}.json`);
    writeJson(join(layout.handoffDir, file), ticket);
  }
  const index = {
    schema_version: FINISH_SCHEMA,
    role: "index",
    build_id:
      updated[0]?.build_id ??
      readJson(join(layout.productDir, "provenance.json")).build_id,
    product_dir: relative(layout.handoffDir, layout.productDir),
    open: updated.filter((ticket) => ticket.status === "open").length,
    closed: updated.filter((ticket) => ticket.status === "closed").length,
    tickets: updated.map((ticket) => ({
      id: ticket.id,
      status: ticket.status,
      file: join("finish", `${ticket.id}.json`),
      method: ticket.operation.method,
      path: ticket.operation.path,
      reason: ticket.reason,
    })),
  };
  writeJson(join(layout.handoffDir, "finish.json"), index);
  const coveragePath = join(layout.productDir, "coverage.json");
  const endpoints = measureEndpoints({
    spec,
    routes,
    passed: results.passed,
    failed: results.failed,
    testSource,
    tickets: updated,
  });
  if (existsSync(coveragePath)) {
    const coverage = readJson(coveragePath);
    coverage.endpoints = endpoints;
    writeJson(coveragePath, coverage);
  }
  return {
    schema_version: FINISH_SCHEMA,
    product_dir: layout.productDir,
    handoff_dir: layout.handoffDir,
    open: updated.filter((ticket) => ticket.status === "open"),
    closed: updated.filter((ticket) => ticket.status === "closed"),
    coverage: endpoints,
    verify: {
      schema_version: verify.schema_version,
      exit_code: verify.exit_code,
      implemented: verify.implemented,
      unimplemented: verify.unimplemented,
      failed: verify.failed,
      total: verify.total,
    },
    planned: plannedCoverage(planProduct(spec), spec.features?.length ?? 0)
      .endpoints,
  };
}

export function finishLine(result) {
  const lines = [
    `Open finish tickets: ${result.open.length}.`,
    `Closed finish tickets: ${result.closed.length}.`,
  ];
  for (const ticket of result.open) {
    lines.push(
      `${ticket.operation.method} ${ticket.operation.path}: ${ticket.reason}`,
    );
  }
  if (result.open.length === 0)
    lines.push("No not-built operation is still open.");
  lines.push(
    `Verify implemented ${result.verify.implemented} of ${result.verify.total}. Failed ${result.verify.failed}.`,
  );
  const coverage = result.coverage;
  lines.push(
    `Endpoint coverage: ${coverage.built} built, ${coverage.not_built} not built, ${coverage.total} total.`,
  );
  return lines.join("\n");
}
