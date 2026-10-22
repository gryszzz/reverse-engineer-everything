import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidBehaviorSpec } from "../outside-in/validate.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const REBUILD_SCHEMA = "ree.rebuild.provenance.v1";

const SERVER_SOURCE = `import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { routes } from "./routes.mjs";

export function createApp() {
  const stores = new Map();
  return createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      send(response, 400, { error: "bad-url" });
      return;
    }
    const route = routes.find(
      (item) => item.method === request.method && item.path === url.pathname,
    );
    if (!route) {
      const known = routes.some((item) => item.path === url.pathname);
      send(response, known ? 405 : 404, {
        error: known ? "method" : "not-found",
      });
      return;
    }
    const store = stores.get(route.path) ?? [];
    stores.set(route.path, store);
    if (route.method === "GET") {
      send(response, route.success_status, { items: store });
      return;
    }
    if (route.method === "DELETE") {
      store.length = 0;
      send(response, route.success_status, { deleted: true });
      return;
    }
    const record = { id: String(store.length + 1) };
    for (const name of route.parameters) {
      record[name] = url.searchParams.has(name)
        ? url.searchParams.get(name)
        : null;
    }
    store.push(record);
    send(response, route.success_status, record);
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function listen(port = 0, hostname = "127.0.0.1") {
  const server = createApp();
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => resolveListen(server));
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("PORT must be an integer from 0 to 65535.");
    process.exit(2);
  }
  const server = createApp();
  server.listen(port, "127.0.0.1", () => {
    console.log("listening http://127.0.0.1:" + server.address().port);
  });
}
`;

const TEST_SOURCE = `import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { behaviors } from "../src/behaviors.mjs";
import { routes } from "../src/routes.mjs";
import { listen } from "../src/server.mjs";

const spec = JSON.parse(
  readFileSync(new URL("../behavior-spec.json", import.meta.url), "utf8"),
);

for (const behavior of behaviors) {
  if (behavior.status === "implemented") {
    test("feature " + behavior.id, async () => {
      const route = routes.find((item) => item.key === behavior.handler);
      assert.ok(route, behavior.id);
      const server = await listen(0);
      try {
        const port = server.address().port;
        const url = new URL("http://127.0.0.1:" + port + route.path);
        for (const name of route.parameters) url.searchParams.set(name, "sample");
        const response = await fetch(url, { method: route.method });
        assert.equal(response.status, route.success_status);
        const body = await response.json();
        if (route.method === "GET") assert.ok(Array.isArray(body.items));
        else if (route.method === "DELETE") assert.equal(body.deleted, true);
        else {
          assert.equal(typeof body.id, "string");
          for (const name of route.parameters)
            assert.equal(body[name], "sample");
        }
      } finally {
        await new Promise((resolveClose) => server.close(resolveClose));
      }
    });
  } else {
    test("unimplemented " + behavior.id, () => {
      assert.equal(behavior.status, "unimplemented");
      assert.equal(behavior.handler, null);
      assert.equal(
        routes.some((route) => route.key === behavior.id),
        false,
      );
    });
  }
}

test("source does not contain spec quotes", () => {
  const names = readdirSync(new URL("../src/", import.meta.url));
  let source = "";
  for (const name of names) {
    if (!name.endsWith(".mjs")) continue;
    source += readFileSync(new URL("../src/" + name, import.meta.url), "utf8");
  }
  const quotes = [];
  for (const feature of spec.features) {
    if (feature.quote?.text && feature.quote.text.length >= 12)
      quotes.push(feature.quote.text);
  }
  for (const limitation of spec.limitations) {
    if (limitation.statement?.text && limitation.statement.text.length >= 12)
      quotes.push(limitation.statement.text);
  }
  for (const quote of quotes) assert.equal(source.includes(quote), false, quote);
});
`;

const LICENSE_TEXT = `MIT License

Copyright (c) 2026 morluto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

This package was generated by REE as a clean-room product from a behavior spec.
REA, the upstream analysis engine, is Copyright (c) 2026 morluto and is
MIT licensed. Original target code was not viewed and was not copied.
This file is not the target's license.
`;

const NOTICE_TEXT = `REE product notice

Copyright (c) 2026 morluto

This package was generated by REE. REA, the upstream analysis engine, is
Copyright (c) 2026 morluto and is MIT licensed. See LICENSE.

Original target code was not viewed and was not copied.
This notice does not name the analyzed target.
`;

function assertOutsideRepo(directory) {
  const rel = relative(resolve(repoRoot), resolve(directory));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
    throw new Error("Choose a rebuild directory outside the REE repository.");
}

function quotesIn(spec) {
  const quotes = [];
  for (const feature of spec.features) {
    if (feature.quote?.text) quotes.push(feature.quote.text);
  }
  for (const limitation of spec.limitations) {
    if (limitation.statement?.text) quotes.push(limitation.statement.text);
  }
  return quotes.filter((text) => text.length >= 12);
}

function leaks(value, quotes) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return quotes.find((quote) => text.includes(quote)) ?? null;
}

function successStatus(method, codes) {
  const listed = [];
  for (const code of codes ?? []) {
    const value = Number(code);
    if (value === 200 || value === 201) listed.push(value);
  }
  const preferred = method === "POST" ? 201 : 200;
  if (listed.includes(preferred)) return preferred;
  if (listed.length > 0) return listed[0];
  return preferred;
}

function buildable(endpoint) {
  const method = String(endpoint?.method ?? "").toUpperCase();
  const path = endpoint?.path;
  if (!HTTP_METHODS.has(method))
    return { ok: false, reason: "method is not built" };
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("{"))
    return { ok: false, reason: "path template is not expanded" };
  return { ok: true, method, path };
}

function matchesFeature(feature, endpoint) {
  const built = buildable(endpoint);
  if (!built.ok || !feature?.name) return false;
  const summary = endpoint.summary?.text ?? null;
  const operationId = endpoint.operation_id ?? null;
  return (
    feature.name === summary ||
    (operationId !== null && feature.name === operationId)
  );
}

function parametersOf(endpoint) {
  const names = [];
  for (const name of endpoint.parameters ?? []) {
    if (typeof name === "string" && name && !names.includes(name))
      names.push(name);
  }
  return names;
}

/**
 * Decide which features become routes.
 * A feature is implemented only when its name equals one endpoint summary
 * or operation id, and that endpoint is GET, POST, PUT, PATCH, or DELETE
 * with a concrete path.
 */
export function planProduct(spec) {
  const quotes = quotesIn(spec);
  const endpoints = spec.api?.endpoints ?? [];
  const behaviors = [];
  const routes = [];
  const skipped = [];
  const omitted = [];
  for (const endpoint of endpoints) {
    const built = buildable(endpoint);
    if (!built.ok) {
      skipped.push({
        method: String(endpoint.method ?? ""),
        path: typeof endpoint.path === "string" ? endpoint.path : null,
        operation_id: endpoint.operation_id ?? null,
        reason: built.reason,
      });
    }
  }
  for (const feature of spec.features) {
    if (leaks(feature.id, quotes)) {
      omitted.push(feature.id);
      continue;
    }
    const endpoint = endpoints.find((item) => matchesFeature(feature, item));
    if (!endpoint) {
      behaviors.push({
        id: feature.id,
        status: "unimplemented",
        handler: null,
      });
      continue;
    }
    const built = buildable(endpoint);
    const route = {
      key: "r" + routes.length,
      method: built.method,
      path: built.path,
      operation_id: endpoint.operation_id ?? null,
      parameters: parametersOf(endpoint),
      success_status: successStatus(built.method, endpoint.response_codes),
    };
    if (leaks(route, quotes)) {
      behaviors.push({
        id: feature.id,
        status: "unimplemented",
        handler: null,
      });
      skipped.push({
        method: route.method,
        path: route.path,
        operation_id: null,
        reason: "structural fields repeated a spec quote",
      });
      continue;
    }
    const existing = routes.find(
      (item) =>
        item.method === route.method &&
        item.path === route.path &&
        item.operation_id === route.operation_id,
    );
    const key = existing ? existing.key : route.key;
    if (!existing) routes.push({ ...route, key });
    behaviors.push({ id: feature.id, status: "implemented", handler: key });
  }
  const unmatched = endpoints.filter((endpoint) => {
    if (!buildable(endpoint).ok) return false;
    return !spec.features.some((feature) => matchesFeature(feature, endpoint));
  });
  return { behaviors, routes, skipped, unmatched, omitted };
}

function routeLine(route) {
  const params = route.parameters.length
    ? ` Query parameters: ${route.parameters.join(", ")}.`
    : "";
  const operation = route.operation_id
    ? ` Operation id: ${route.operation_id}.`
    : "";
  return `- ${route.method} ${route.path} returns ${route.success_status}.${params}${operation}`;
}

function endpointLine(endpoint) {
  const method = String(endpoint.method ?? "").toUpperCase();
  const operation = endpoint.operation_id ? ` (${endpoint.operation_id})` : "";
  return `- ${method} ${endpoint.path}${operation}`;
}

function readmeText(productName, plan) {
  const lines = [
    `# ${productName}`,
    "",
    "Clean-room HTTP product generated by REE from a behavior spec.",
    "Original target code was not viewed and was not copied.",
    "This package does not use the target's name or branding.",
    "",
    "## Run",
    "",
    "```sh",
    "npm test",
    "npm start",
    "```",
    "",
    "`npm test` runs the route tests.",
    "`npm start` listens on 127.0.0.1 port 8787, or `PORT` when that variable is set.",
    "",
    "## What runs",
    "",
  ];
  if (plan.routes.length === 0) {
    lines.push(
      "No feature name matched a GET, POST, PUT, PATCH, or DELETE endpoint, so no route was built.",
      "`npm start` still listens and answers 404.",
    );
  } else {
    lines.push(
      "The store is in memory and starts empty.",
      'GET returns `{ "items": [] }` with the success status.',
      "POST, PUT, and PATCH append a record with an id and the query parameters named in the spec.",
      'DELETE clears that path and returns `{ "deleted": true }`.',
      "The success status is 200 or 201 when the spec lists that code. Otherwise POST uses 201 and the other methods use 200.",
      "A path that was built for another method answers 405.",
      "",
      ...plan.routes.map(routeLine),
    );
  }
  lines.push("", "## Not built", "");
  const unimplemented = plan.behaviors.filter(
    (item) => item.status !== "implemented",
  );
  if (
    unimplemented.length === 0 &&
    plan.unmatched.length === 0 &&
    plan.skipped.length === 0
  )
    lines.push("Every spec feature has a route above.");
  else {
    if (unimplemented.length === 0)
      lines.push("Every spec feature has a route above.");
    else {
      lines.push(
        "These feature ids are marked unimplemented and are not routes:",
      );
      for (const item of unimplemented) lines.push(`- ${item.id}`);
    }
    if (plan.unmatched.length > 0) {
      lines.push(
        "",
        "Endpoints in the spec with no matching feature name were not built:",
      );
      for (const endpoint of plan.unmatched) lines.push(endpointLine(endpoint));
    }
    if (plan.skipped.length > 0) {
      lines.push("", "These endpoints were not built:");
      for (const item of plan.skipped) {
        lines.push(
          `- ${item.method || "(no method)"} ${item.path ?? "(no path)"}: ${item.reason}.`,
        );
      }
    }
  }
  lines.push(
    "",
    "## Not implemented",
    "",
    "GraphQL, workflows, a pricing checkout, integrations, authentication, and rate limits are not built.",
    "Features whose names are not an endpoint summary or operation id stay unimplemented.",
    "Path templates that contain `{` are not expanded.",
    "Methods other than GET, POST, PUT, PATCH, and DELETE are not built.",
    "",
    "See PRICING.md. Prices are not invented.",
    "",
  );
  return lines.join("\n");
}

function landingText(productName, plan) {
  const lines = [
    `# ${productName}`,
    "",
    "A clean-room HTTP product.",
    "Original target code was not viewed and was not copied.",
    "This page does not use another product's name.",
    "",
    "## What you can run",
    "",
  ];
  if (plan.routes.length === 0) {
    lines.push("No route was built. The server still starts and answers 404.");
  } else {
    lines.push(...plan.routes.map(routeLine));
  }
  const unimplemented = plan.behaviors.filter(
    (item) => item.status !== "implemented",
  );
  lines.push("", "## What is not included", "");
  if (unimplemented.length === 0)
    lines.push("Every spec feature has a route above.");
  else {
    lines.push("These feature ids were not built:");
    for (const item of unimplemented) lines.push(`- ${item.id}`);
  }
  lines.push(
    "",
    "There is no checkout. See PRICING.md. Prices are not invented.",
    "",
  );
  return lines.join("\n");
}

function pricingText(spec) {
  const plans = spec.pricing?.plans ?? [];
  if (plans.length === 0) {
    return [
      "# Pricing",
      "",
      "No pricing was in the spec and none was invented.",
      "",
    ].join("\n");
  }
  const lines = [
    "# Pricing",
    "",
    "These notes restate prices recorded in the behavior spec. They are not a checkout, and no price was invented.",
    "",
  ];
  for (const plan of plans) {
    const display = plan.price?.display ?? null;
    lines.push(
      `- ${plan.name}: ${display ?? "the spec named this plan and did not record a price."}`,
    );
    const citation = plan.citations?.[0];
    if (citation?.url) lines.push(`  Source: ${citation.url}`);
    if (citation?.fetched_at) lines.push(`  Fetched: ${citation.fetched_at}`);
  }
  lines.push("");
  return lines.join("\n");
}

function packageProduct(outDir) {
  const archive = join(outDir, "product.tgz");
  rmSync(archive, { force: true });
  const staging = join(
    tmpdir(),
    `ree-${basename(outDir)}-${randomBytes(4).toString("hex")}.tgz`,
  );
  const packed = spawnSync("tar", ["-czf", staging, "-C", outDir, "."], {
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    throw new Error(
      "Could not write product.tgz. " +
        (packed.stderr || packed.error?.message || "tar failed."),
    );
  }
  renameSync(staging, archive);
  return archive;
}

/**
 * Write a clean-room HTTP product from a behavior spec.
 * Original code is neither read nor copied.
 */
export function scaffoldRebuild({
  spec: input,
  productName,
  outDir,
  now = new Date(),
}) {
  if (typeof productName !== "string" || !productName.trim())
    throw new Error("A new product name is required.");
  const name = productName.trim();
  if (
    name.toLowerCase() ===
    String(input?.target?.name ?? "")
      .trim()
      .toLowerCase()
  )
    throw new Error(
      "The new product name must differ from the spec target name.",
    );
  const spec = assertValidBehaviorSpec(input);
  if (!outDir) throw new Error("An output directory is required.");
  assertOutsideRepo(outDir);
  const leaked = quotesIn(spec).find((quote) => name.includes(quote));
  if (leaked) throw new Error("The product name contains a spec quote.");
  const plan = planProduct(spec);
  const readme = readmeText(name, plan);
  const landing = landingText(name, plan);
  const brand = String(spec.target.name ?? "").trim();
  if (
    brand &&
    (readme.includes(brand) ||
      landing.includes(brand) ||
      NOTICE_TEXT.includes(brand))
  )
    throw new Error("Customer copy includes the spec target name.");
  const repeated = quotesIn(spec).find(
    (quote) =>
      readme.includes(quote) ||
      landing.includes(quote) ||
      NOTICE_TEXT.includes(quote),
  );
  if (repeated) throw new Error("Customer copy repeats a spec quote.");
  const specBytes = JSON.stringify(spec);
  const specSha = createHash("sha256").update(specBytes).digest("hex");
  const buildId = "bld_" + randomBytes(8).toString("hex");
  const provenance = {
    schema_version: REBUILD_SCHEMA,
    build_id: buildId,
    generated_at: now.toISOString(),
    product_name: name,
    spec_schema: spec.schema_version,
    spec_sha256: specSha,
    spec_target_recorded_in: "provenance.json",
    clean_room: true,
    clean_room_statement: spec.clean_room_statement,
    original_code_viewed: false,
    original_code_copied: false,
    similarity: spec.similarity,
    sources: spec.sources.map((source) => ({
      url: source.url,
      role: source.role,
      fetched_at: source.fetched_at,
      sha256: source.sha256,
    })),
    generator: "ree-rebuild",
    package_file: "product.tgz",
    implemented_feature_ids: plan.behaviors
      .filter((item) => item.status === "implemented")
      .map((item) => item.id),
    unimplemented_feature_ids: plan.behaviors
      .filter((item) => item.status !== "implemented")
      .map((item) => item.id),
    omitted_feature_ids: plan.omitted,
    generator_limits: [
      "A feature is implemented only when its name equals an endpoint summary or operation id.",
      "Methods: GET, POST, PUT, PATCH, DELETE. The store is in memory.",
      "GET lists items. POST, PUT, and PATCH append a record. DELETE clears that path.",
      "Path templates containing { are not expanded.",
      "GraphQL, workflows, pricing checkout, integrations, authentication, and rate limits are not built.",
    ],
  };
  const manifest = {
    name: slug(name),
    private: true,
    type: "module",
    description:
      "Clean-room HTTP product generated by REE. No original source was copied.",
    scripts: {
      test: "node --test",
      start: "node src/server.mjs",
    },
    license: "MIT",
  };
  const lock = {
    name: manifest.name,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: manifest.name, license: "MIT" } },
  };
  mkdirSync(join(outDir, "src"), { recursive: true });
  mkdirSync(join(outDir, "test"), { recursive: true });
  rmSync(join(outDir, "test/accounted.test.mjs"), { force: true });
  writeFileSync(
    join(outDir, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  writeFileSync(
    join(outDir, "package-lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
  );
  writeFileSync(join(outDir, "README.md"), readme);
  writeFileSync(join(outDir, "LANDING.md"), landing);
  writeFileSync(join(outDir, "LICENSE"), LICENSE_TEXT);
  writeFileSync(join(outDir, "NOTICE"), NOTICE_TEXT);
  writeFileSync(join(outDir, "PRICING.md"), pricingText(spec));
  writeFileSync(
    join(outDir, "src/behaviors.mjs"),
    [
      "// Generated by REE rebuild.",
      "// Ids, status, and handler keys only. Names and quotes are not stored.",
      "export const behaviors = " +
        JSON.stringify(plan.behaviors, null, 2) +
        ";",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(outDir, "src/routes.mjs"),
    [
      "// Generated by REE rebuild.",
      "// Method, path, operation id, parameter names, and status only.",
      "export const routes = " + JSON.stringify(plan.routes, null, 2) + ";",
      "",
    ].join("\n"),
  );
  writeFileSync(join(outDir, "src/server.mjs"), SERVER_SOURCE);
  writeFileSync(join(outDir, "test/product.test.mjs"), TEST_SOURCE);
  writeFileSync(
    join(outDir, "behavior-spec.json"),
    JSON.stringify(spec, null, 2) + "\n",
  );
  writeFileSync(
    join(outDir, "provenance.json"),
    JSON.stringify(provenance, null, 2) + "\n",
  );
  writeFileSync(
    join(outDir, "PROVENANCE.md"),
    [
      "# Provenance",
      "",
      provenance.clean_room_statement,
      "",
      "Original code viewed: no",
      "Original code copied: no",
      `Spec sha256: ${specSha}`,
      `Similarity flagged: ${spec.similarity.flagged ? "yes" : "no"}`,
      `Package file: ${provenance.package_file}`,
      "The tarball is added after these files are packed, so the archive does not contain product.tgz.",
      "",
      "Implemented feature ids:",
      ...(provenance.implemented_feature_ids.length
        ? provenance.implemented_feature_ids.map((id) => `- ${id}`)
        : ["- none"]),
      "",
      "Unimplemented feature ids:",
      ...(provenance.unimplemented_feature_ids.length
        ? provenance.unimplemented_feature_ids.map((id) => `- ${id}`)
        : ["- none"]),
      "",
      "Sources:",
      ...provenance.sources.map((item) => `- ${item.url} (${item.fetched_at})`),
      "",
    ].join("\n"),
  );
  const packagePath = packageProduct(outDir);
  return {
    build_id: buildId,
    out_dir: outDir,
    provenance,
    feature_count: spec.features.length,
    implemented_count: provenance.implemented_feature_ids.length,
    unimplemented_count: provenance.unimplemented_feature_ids.length,
    package_path: packagePath,
  };
}

function slug(name) {
  const value = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return value || "rebuild";
}
