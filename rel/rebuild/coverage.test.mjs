import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  CLEAN_ROOM_STATEMENT,
  SCHEMA_VERSION,
  USER_AGENT,
} from "../outside-in/constants.mjs";
import { extractOpenApi } from "../outside-in/extract-openapi.mjs";
import { coverageDecision } from "./coverage.mjs";
import { measureDeskCoverage } from "./coverage-gate.mjs";
import { planProduct, scaffoldRebuild } from "./scaffold.mjs";
import { savedRecords } from "./saved-records.mjs";

function row(id, name, match) {
  return { id, name, match, route: null };
}

test("feature coverage fails under 80 percent", () => {
  const decision = coverageDecision({
    features: [
      row("feature:a", "A", "pass"),
      row("feature:b", "B", "pass"),
      row("feature:c", "C", "pass"),
      row("feature:d", "D", "unimplemented"),
      row("feature:e", "E", "unimplemented"),
    ],
  });
  assert.equal(decision.passed, false);
  assert.equal(decision.ratio, 0.6);
  assert.equal(decision.left_out, 2);
  const exact = coverageDecision({
    features: [
      row("feature:a", "A", "pass"),
      row("feature:b", "B", "pass"),
      row("feature:c", "C", "pass"),
      row("feature:d", "D", "pass"),
      row("feature:e", "E", "unimplemented"),
    ],
  });
  assert.equal(exact.passed, true);
  assert.equal(exact.ratio, 0.8);
});

test("the owned desk fixture stays at or above 80 percent", async () => {
  const measured = await measureDeskCoverage();
  let dataDir;
  try {
    assert.equal(measured.verify.exit_code, 0, measured.verify.stderr);
    assert.ok(measured.spec.features.length >= 5);
    assert.equal(
      measured.decision.passed,
      true,
      JSON.stringify(measured.decision),
    );
    assert.ok(measured.decision.ratio >= 0.8);
    const byName = Object.fromEntries(
      measured.decision.features.map((feature) => [feature.name, feature]),
    );
    assert.equal(byName["Shared boards"].status, "implemented");
    assert.equal(byName["Create a board"].status, "implemented");
    assert.equal(byName["Pin a note"].status, "implemented");
    assert.equal(byName["Invite a member"].status, "implemented");
    assert.equal(byName["Archive a board"].status, "implemented");
    assert.equal(byName["Open a board"].status, "implemented");
    assert.equal(byName["Open a board"].reason, null);
    assert.equal(measured.verify.total, 6);
    assert.equal(measured.verify.implemented, 6);
    assert.equal(measured.verify.unimplemented, 0);
    assert.equal(measured.verify.failed, 0);
    assert.equal(byName["Open a board"].route.path, "/boards/{id}");
    const source = ["behaviors.mjs", "routes.mjs", "server.mjs"]
      .map((name) => readFileSync(join(measured.product, "src", name), "utf8"))
      .join("\n");
    assert.equal(source.includes("Desk Ledger"), false);
    assert.equal(source.includes("Open a board"), false);
    assert.equal(source.includes("People can open one board together."), false);
    assert.match(source, /listBoards/);
    assert.equal(source.includes("/boards/{id}"), true);
    assert.match(source, /"body": "json"/);
    const { listen: start } = await import(
      pathToFileURL(join(measured.product, "src/server.mjs")).href
    );
    dataDir = mkdtempSync(join(tmpdir(), "ree-desk-store-"));
    const server = await start(0, "127.0.0.1", dataDir);
    try {
      const port = server.address().port;
      const listed = await fetch(`http://127.0.0.1:${port}/boards`);
      assert.equal(listed.status, 200);
      assert.ok(Array.isArray((await listed.json()).items));
      const created = await fetch(
        `http://127.0.0.1:${port}/boards?boardName=alpha`,
        { method: "POST" },
      );
      assert.equal(created.status, 201);
      const createdBody = await created.json();
      assert.equal(createdBody.boardName, "alpha");
      const saved = savedRecords(dataDir);
      assert.ok(saved.some((item) => item.id === createdBody.id));
      const opened = await fetch(
        `http://127.0.0.1:${port}/boards/${createdBody.id}`,
      );
      assert.equal(opened.status, 200);
      assert.equal((await opened.json()).id, createdBody.id);
      const missing = await fetch(`http://127.0.0.1:${port}/boards/missing-id`);
      assert.equal(missing.status, 404);
      const jsonCreated = await fetch(`http://127.0.0.1:${port}/boards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ boardName: "beta" }),
      });
      assert.equal(jsonCreated.status, 201);
      const beta = await jsonCreated.json();
      assert.equal(beta.boardName, "beta");
      const changed = await fetch(
        `http://127.0.0.1:${port}/boards/${beta.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ boardName: "gamma" }),
        },
      );
      assert.equal(changed.status, 200);
      assert.equal((await changed.json()).boardName, "gamma");
      const removed = await fetch(
        `http://127.0.0.1:${port}/boards/${beta.id}`,
        { method: "DELETE" },
      );
      assert.equal(removed.status, 200);
      assert.equal((await removed.json()).deleted, true);
      const gone = await fetch(`http://127.0.0.1:${port}/boards/${beta.id}`);
      assert.equal(gone.status, 404);
      const badJson = await fetch(`http://127.0.0.1:${port}/boards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      assert.equal(badJson.status, 400);
      assert.equal((await badJson.json()).error, "payload");
      const shared = await fetch(
        `http://127.0.0.1:${port}/shared-boards?label=alpha`,
        { method: "POST" },
      );
      assert.equal(shared.status, 201);
      const duplicate = await fetch(
        `http://127.0.0.1:${port}/shared-boards?label=alpha`,
        { method: "POST" },
      );
      assert.equal(duplicate.status, 400);
      assert.equal((await duplicate.json()).rule, "unique");
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
      const html = await page.text();
      assert.match(html, /data-records/);
      assert.match(html, /data-product="Desk Kit"/);
      assert.equal(html.includes("Desk Ledger"), false);
      assert.equal(html.includes("<h1>Product</h1>"), false);
      assert.equal(html.includes("<h1>Records</h1>"), false);
      assert.equal(html.includes("Model:"), false);
      assert.match(html, /data-path="\/boards"/);
      assert.match(html, /data-item="\/boards\/\{id\}"/);
      assert.match(html, /application\/json/);
      assert.match(html, /data-path="\/shared-boards"/);
      assert.match(html, /Saved in SQLite/);
      const report = JSON.parse(
        readFileSync(join(measured.product, "capabilities.json"), "utf8"),
      );
      assert.match(report.note, /not a percentage/);
      const status = Object.fromEntries(
        report.capabilities.map((item) => [item.id, item.status]),
      );
      assert.equal(status.storage, "implemented");
      assert.equal(status.relations, "left-out");
      assert.equal(status.search, "left-out");
      assert.equal(status.auth, "left-out");
      assert.equal(status.roles, "left-out");
      assert.equal(status.webhooks, "left-out");
      assert.equal(status.pricing, "left-out");
      assert.equal(status.ui, "implemented");
      assert.equal(status.openapi, "implemented");
      assert.equal(status.deploy, "implemented");
      assert.equal(existsSync(join(measured.product, "openapi.json")), true);
      const docker = readFileSync(join(measured.product, "Dockerfile"), "utf8");
      const render = readFileSync(
        join(measured.product, "render.yaml"),
        "utf8",
      );
      assert.match(docker, /0\.0\.0\.0/);
      assert.equal(docker.includes("sk_live_"), false);
      assert.equal(docker.includes("sk_test_"), false);
      assert.equal(render.includes("sk_live_"), false);
      assert.equal(render.includes("sk_test_"), false);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  } finally {
    rmSync(measured.work, { recursive: true, force: true });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }
});

test("one id segment is built and a longer template is left out", () => {
  const plan = planProduct({
    target: { name: "Example" },
    features: [
      { id: "feature:open", name: "Open" },
      { id: "feature:nested", name: "Nested" },
    ],
    limitations: [],
    api: {
      endpoints: [
        {
          method: "POST",
          path: "/boards",
          operation_id: "create",
          summary: { text: "Create" },
          parameters: ["boardName"],
          body: "json",
          response_codes: ["201"],
        },
        {
          method: "GET",
          path: "/boards/{id}",
          operation_id: "open",
          summary: { text: "Open" },
          parameters: [],
          response_codes: ["200"],
        },
        {
          method: "GET",
          path: "/boards/{id}/notes/{note}",
          operation_id: "nested",
          summary: { text: "Nested" },
          parameters: [],
          response_codes: ["200"],
        },
      ],
    },
  });
  const open = plan.behaviors.find((item) => item.id === "feature:open");
  const nested = plan.behaviors.find((item) => item.id === "feature:nested");
  assert.equal(open.status, "implemented");
  const read = plan.routes.find((route) => route.action === "read");
  assert.equal(read.path, "/boards/{id}");
  assert.equal(read.path_param, "id");
  assert.equal(
    read.resource,
    plan.routes.find((route) => route.path === "/boards").resource,
  );
  assert.equal(nested.status, "unimplemented");
  assert.equal(
    plan.leftOut.find((item) => item.id === "feature:nested").reason,
    "path template is not expanded",
  );
  const create = plan.routes.find(
    (route) => route.method === "POST" && route.path === "/boards",
  );
  assert.equal(create.body, "json");
  assert.deepEqual(create.parameters, ["boardName"]);
});

test("JSON body properties are read and a schema ref stays unknown", () => {
  const parsed = extractOpenApi(`
openapi: 3.0.3
info: { title: Notes, version: "1" }
paths:
  /notes:
    post:
      operationId: createNote
      parameters:
        - name: title
          in: query
          required: true
          schema: { type: string }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                title: { type: string }
                note: { type: string }
  /refs:
    post:
      operationId: createRef
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Note"
`);
  const notes = parsed.endpoints.find((item) => item.path === "/notes");
  const refs = parsed.endpoints.find((item) => item.path === "/refs");
  assert.equal(notes.body, "json");
  assert.deepEqual(notes.parameters, ["title", "note"]);
  assert.equal(notes.fields[0].name, "title");
  assert.equal(notes.fields[0].required, true);
  assert.equal(notes.fields[0].type, "string");
  assert.equal(notes.unresolvedBody, 0);
  assert.equal(refs.body, null);
  assert.equal(refs.unresolvedBody, 1);
  assert.deepEqual(refs.parameters, []);
});

test("a local schema ref becomes fields and a missing ref stays unknown", () => {
  const parsed = extractOpenApi(`
openapi: 3.0.3
info: { title: Pets, version: "1" }
paths:
  /pet:
    post:
      operationId: addPet
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Pet"
      responses:
        "200":
          description: ok
components:
  schemas:
    Pet:
      type: object
      required: [name, photoUrls]
      properties:
        name: { type: string }
        status:
          type: string
          enum: [available, pending, sold]
        photoUrls:
          type: array
          items: { type: string }
`);
  const pet = parsed.endpoints.find((item) => item.path === "/pet");
  assert.equal(pet.body, "json");
  assert.equal(pet.unresolvedBody, 0);
  assert.deepEqual(
    pet.fields.map((field) => [field.name, field.required, field.type]),
    [
      ["name", true, "string"],
      ["status", false, "string"],
      ["photoUrls", true, "array"],
    ],
  );
  assert.deepEqual(pet.fields[1].enum, ["available", "pending", "sold"]);
});

test("record routes keep schema fields, key by username, and skip action endpoints", async () => {
  const citation = {
    url: "https://pets.example/openapi.json",
    fetched_at: "2026-10-22T00:00:00.000Z",
    role: "docs",
  };
  const endpoint = (method, path, operationId, extra = {}) => ({
    method,
    path,
    operation_id: operationId,
    parameters: extra.parameters ?? [],
    response_codes: extra.codes ?? ["200"],
    citations: [citation],
    ...(extra.fields
      ? { body: extra.body ?? "json", fields: extra.fields }
      : {}),
  });
  const petFields = [
    { name: "name", required: true, type: "string" },
    {
      name: "status",
      required: false,
      type: "string",
      enum: ["available", "pending", "sold"],
    },
    { name: "photoUrls", required: true, type: "array" },
  ];
  const spec = {
    schema_version: SCHEMA_VERSION,
    clean_room: true,
    clean_room_statement: CLEAN_ROOM_STATEMENT,
    mode: "outside-in",
    status: "completed",
    generated_at: "2026-10-22T00:00:00.000Z",
    target: { name: "Ledger", urls: ["https://pets.example/openapi.json"] },
    collector: {
      name: "ree-outside-in",
      version: "1",
      user_agent: USER_AGENT,
      platform: "test",
      headless_browser: false,
      authentication: "none",
      source_acquisition: "public-http-get",
    },
    llm: {
      used: false,
      provider: null,
      ree_remote_calls: "not-performed",
      transport: "none",
      summary: null,
      error: null,
    },
    sources: [
      {
        url: citation.url,
        role: "docs",
        status: 200,
        content_type: "application/json",
        fetched_at: citation.fetched_at,
        sha256: "ab".repeat(32),
        bytes: 4,
        robots: { allowed: true, rule: null },
        cache: { hit: false },
      },
    ],
    refusals: [],
    features: [],
    workflows: [],
    api: {
      style: "openapi",
      servers: [],
      auth: [],
      rate_limits: [],
      unknowns: [],
      endpoints: [
        endpoint("POST", "/pet", "addPet", {
          parameters: ["name", "status", "photoUrls"],
          fields: petFields,
        }),
        endpoint("PUT", "/pet", "updatePet", {
          parameters: ["name", "status", "photoUrls"],
          fields: petFields,
        }),
        endpoint("GET", "/pet/{petId}", "getPetById", {
          parameters: ["petId"],
        }),
        endpoint("POST", "/pet/{petId}", "updatePetWithForm", {
          parameters: ["name", "status"],
        }),
        endpoint("DELETE", "/pet/{petId}", "deletePet", {
          parameters: ["petId"],
        }),
        endpoint("GET", "/pet/findByStatus", "findPetsByStatus", {
          parameters: ["status"],
        }),
        endpoint("POST", "/pet/{petId}/uploadImage", "uploadFile", {
          parameters: ["petId"],
        }),
        endpoint("GET", "/store/inventory", "getInventory"),
        endpoint("POST", "/user", "createUser", {
          parameters: ["username", "email"],
          fields: [
            { name: "username", required: false, type: "string" },
            { name: "email", required: false, type: "string" },
          ],
        }),
        endpoint("GET", "/user/login", "loginUser"),
        endpoint("GET", "/user/logout", "logoutUser"),
        endpoint("GET", "/user/{username}", "getUserByName", {
          parameters: ["username"],
        }),
        endpoint("PUT", "/user/{username}", "updateUser", {
          parameters: ["username", "email"],
          fields: [
            { name: "username", required: false, type: "string" },
            { name: "email", required: false, type: "string" },
          ],
        }),
        endpoint("DELETE", "/user/{username}", "deleteUser", {
          parameters: ["username"],
        }),
      ],
    },
    pricing: { plans: [], unknowns: [] },
    integrations: [],
    limitations: [],
    changes: [],
    omitted: [],
    similarity: { threshold: 80, quote_max: 160, flagged: false, findings: [] },
    coverage: { examined_urls: [citation.url], unknowns: [] },
  };
  const plan = planProduct(spec);
  const skipped = new Map(
    plan.skipped.map((item) => [`${item.method} ${item.path}`, item.reason]),
  );
  assert.equal(
    skipped.get("GET /user/login"),
    "action endpoint is not a record collection",
  );
  assert.equal(
    skipped.get("GET /user/logout"),
    "action endpoint is not a record collection",
  );
  assert.equal(
    skipped.get("GET /store/inventory"),
    "action endpoint is not a record collection",
  );
  assert.equal(
    skipped.get("GET /pet/findByStatus"),
    "action endpoint is not a record collection",
  );
  assert.equal(
    skipped.get("POST /pet/{petId}/uploadImage"),
    "path template is not expanded",
  );
  const userRead = plan.routes.find(
    (route) => route.method === "GET" && route.path === "/user/{username}",
  );
  assert.equal(userRead.path_param, "username");
  assert.equal(
    plan.routes.some((route) => route.path === "/user/login"),
    false,
  );
  const out = mkdtempSync(join(tmpdir(), "ree-pet-model-"));
  const dataDir = mkdtempSync(join(tmpdir(), "ree-pet-data-"));
  try {
    scaffoldRebuild({
      spec,
      productName: "Harbor Kit",
      outDir: out,
      pack: false,
    });
    const report = readFileSync(join(out, "FEATURE_REPORT.md"), "utf8");
    assert.match(report, /POST \/pet\/\{petId\}\/uploadImage/);
    assert.match(report, /Not built:/);
    const ran = await runGenerated(out);
    assert.equal(ran.status, 0, ran.stderr || ran.stdout);
    assert.match(ran.stdout, /endpoint POST \/pet/);
    const { listen } = await import(
      pathToFileURL(join(out, "src/server.mjs")).href
    );
    const server = await listen(0, "127.0.0.1", dataDir);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const created = await fetch(base + "/pet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "fido",
          status: "available",
          photoUrls: ["https://pets.example/fido.png"],
        }),
      });
      assert.equal(created.status, 200, await created.clone().text());
      const pet = await created.json();
      assert.equal(pet.name, "fido");
      assert.equal(pet.status, "available");
      assert.deepEqual(pet.photoUrls, ["https://pets.example/fido.png"]);
      const empty = await fetch(base + "/pet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(empty.status, 400);
      assert.equal((await empty.json()).rule, "required");
      const partial = await fetch(base + "/pet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "fido", status: "available" }),
      });
      assert.equal(partial.status, 400);
      assert.equal((await partial.json()).field, "photoUrls");
      const replaced = await fetch(base + "/pet?id=" + pet.id, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "fido",
          status: "sold",
          photoUrls: ["https://pets.example/fido.png"],
        }),
      });
      assert.equal(replaced.status, 200, await replaced.clone().text());
      const updated = await replaced.json();
      assert.equal(updated.id, pet.id);
      assert.equal(updated.name, "fido");
      assert.equal(updated.status, "sold");
      assert.deepEqual(updated.photoUrls, ["https://pets.example/fido.png"]);
      const opened = await fetch(base + "/pet/" + pet.id);
      assert.equal(opened.status, 200);
      assert.equal((await opened.json()).status, "sold");
      const removed = await fetch(base + "/pet/" + pet.id, {
        method: "DELETE",
      });
      assert.equal(removed.status, 200);
      assert.equal((await removed.json()).deleted, true);
      const user = await fetch(base + "/user", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "ada" }),
      });
      assert.equal(user.status, 200, await user.clone().text());
      const account = await user.json();
      assert.equal(account.username, "ada");
      const byName = await fetch(base + "/user/ada");
      assert.equal(byName.status, 200);
      assert.equal((await byName.json()).id, account.id);
      const renamed = await fetch(base + "/user/ada", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "ada@example.com" }),
      });
      assert.equal(renamed.status, 200, await renamed.clone().text());
      const accountUpdated = await renamed.json();
      assert.equal(accountUpdated.username, "ada");
      assert.equal(accountUpdated.email, "ada@example.com");
      assert.equal(
        (await (await fetch(base + "/user/ada")).json()).email,
        "ada@example.com",
      );
      const blankUser = await fetch(base + "/user", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(blankUser.status, 200);
      const upload = await fetch(base + "/pet/" + pet.id + "/uploadImage", {
        method: "POST",
      });
      assert.equal(upload.status, 404);
      const login = await fetch(base + "/user/login");
      assert.equal(login.status, 404);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function runGenerated(dir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST") || key === "NODE_CHANNEL_FD")
      delete env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "test/product.test.mjs"], {
      cwd: dir,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
