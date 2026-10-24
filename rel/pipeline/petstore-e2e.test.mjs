import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runProductPipeline } from "./run.mjs";
import { startStudio } from "../studio/server.mjs";

const PETSTORE = "https://petstore3.swagger.io/api/v3/openapi.json";
const METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
];

test(
  "Petstore OpenAPI rebuilds fields, skips unrelated picks, and the studio offers a rebuild",
  { timeout: 240_000 },
  async () => {
    const response = await fetch(PETSTORE);
    assert.equal(response.status, 200, PETSTORE);
    const document = await response.json();
    const operations = operationCount(document);
    assert.ok(operations > 0, "the public document has operations");
    const home = mkdtempSync(join(tmpdir(), "ree-petstore-e2e-"));
    const board = join(home, "board");
    const out = join(home, "run");
    const dataDir = join(home, "data");
    mkdirSync(join(board, "picks"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writePick(board, "photo.json", {
      agent: "fixture",
      id: "photo-list",
      verdict: "build",
      reason: "Add a photo list to each record.",
      angle: "Photo list",
      date: "2026-10-22",
      url: "https://petstore3.swagger.io/ideas/photo-list",
    });
    for (const [file, id, reason, angle] of [
      ["billing.json", "billing", "Shopify billing needs a retry.", "Billing"],
      [
        "certs.json",
        "certs",
        "The certificate expires next week.",
        "Cert expiry",
      ],
      ["backup.json", "backup", "SaaS backup is missing.", "Backup"],
      [
        "status.json",
        "status",
        "Status pages should be public.",
        "Status pages",
      ],
    ]) {
      writePick(board, file, {
        agent: "fixture",
        id,
        verdict: "build",
        reason,
        angle,
        date: "2026-10-22",
        url: null,
      });
    }
    const studio = await startStudio({ dataDir: join(home, "studio") });
    try {
      const run = await runProductPipeline({
        target: PETSTORE,
        outDir: out,
        productName: "Harbor Kit",
        improveBoard: board,
        now: new Date("2026-10-23T00:00:00.000Z"),
      });
      assert.equal(run.code, 0, run.message);
      const spec = JSON.parse(
        readFileSync(join(out, "analysis/behavior-spec.json"), "utf8"),
      );
      assert.equal(spec.api.endpoints.length, operations);
      const improvements = JSON.parse(
        readFileSync(join(out, "improvements.json"), "utf8"),
      );
      assert.equal(improvements.items.length, 1);
      assert.equal(improvements.items[0].name, "Photo list");
      assert.equal(
        improvements.items[0].citation.fetched_at,
        "2026-10-22T00:00:00.000Z",
      );
      assert.equal(
        improvements.skipped.filter((item) =>
          String(item.reason).includes("does not match the target"),
        ).length >= 4,
        true,
      );
      const product = join(out, "product");
      const coverage = JSON.parse(
        readFileSync(join(product, "coverage.json"), "utf8"),
      );
      assert.equal(
        coverage.endpoints.built + coverage.endpoints.not_built,
        operations,
      );
      assert.ok(coverage.endpoints.not_built > 0);
      const report = readFileSync(join(product, "FEATURE_REPORT.md"), "utf8");
      assert.match(report, /Photo list/);
      const notBuilt = report.split("Not built:")[1] ?? "";
      assert.match(notBuilt, /uploadImage/);
      assert.match(notBuilt, /createWithList/);
      assert.match(notBuilt, /action endpoint is not a record collection/);
      assert.doesNotMatch(notBuilt, /\/user\/login/);
      assert.doesNotMatch(notBuilt, /\/user\/logout/);
      assert.doesNotMatch(notBuilt, /\/pet\/findByStatus/);
      assert.doesNotMatch(notBuilt, /\/pet\/findByTags/);
      assert.doesNotMatch(notBuilt, /\/store\/inventory/);
      const routes = readFileSync(join(product, "src/routes.mjs"), "utf8");
      assert.equal(routes.includes("/improve-"), false);
      assert.match(routes, /\/user\/login/);
      assert.match(routes, /\/user\/logout/);
      assert.match(routes, /\/pet\/findByStatus/);
      assert.match(routes, /\/pet\/findByTags/);
      assert.match(routes, /\/store\/inventory/);
      assert.match(routes, /\/user\/\{username\}/);
      const { routes: routeList } = await import(
        pathToFileURL(join(product, "src/routes.mjs")).href
      );
      const { listen } = await import(
        pathToFileURL(join(product, "src/server.mjs")).href
      );
      const create = routeList.find(
        (route) => route.method === "POST" && route.path === "/pet",
      );
      assert.ok(create);
      const server = await listen(0, "127.0.0.1", dataDir);
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const headers = await sessionHeaders(base, product);
        const payload = petPayload(document);
        const created = await fetch(base + "/pet", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        assert.equal(
          created.status,
          create.success_status,
          await created.clone().text(),
        );
        const pet = await created.json();
        for (const [name, value] of Object.entries(payload))
          assert.deepEqual(pet[name], value, name);
        const empty = await fetch(base + "/pet", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(empty.status, 400);
        assert.equal((await empty.json()).rule, "required");
        const next = { ...payload };
        if (typeof next.status === "string") next.status = "sold";
        else next.name = "kept-name";
        const replaced = await fetch(
          base + "/pet?id=" + encodeURIComponent(pet.id),
          {
            method: "PUT",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(next),
          },
        );
        assert.equal(replaced.status, 200, await replaced.clone().text());
        const updated = await replaced.json();
        assert.equal(updated.id, pet.id);
        for (const [name, value] of Object.entries(next))
          assert.deepEqual(updated[name], value, name);
        const opened = await fetch(
          base + "/pet/" + encodeURIComponent(pet.id),
          {
            headers,
          },
        );
        assert.equal(opened.status, 200);
        assert.deepEqual((await opened.json()).name, updated.name);
        const storedStatus =
          typeof updated.status === "string" ? updated.status : pet.status;
        const matched = await fetch(
          base +
            "/pet/findByStatus?status=" +
            encodeURIComponent(storedStatus ?? ""),
          { headers },
        );
        assert.equal(matched.status, 200, await matched.clone().text());
        assert.equal(
          (await matched.json()).items.some((item) => item.id === pet.id),
          true,
        );
        const stock = await fetch(base + "/store/inventory", { headers });
        assert.equal(stock.status, 200, await stock.clone().text());
        assert.equal(typeof (await stock.json()).counts, "object");
        const removed = await fetch(
          base + "/pet/" + encodeURIComponent(pet.id),
          {
            method: "DELETE",
            headers,
          },
        );
        assert.equal(removed.status, 200);
        assert.equal((await removed.json()).deleted, true);
        const createUser = routeList.find(
          (route) => route.method === "POST" && route.path === "/user",
        );
        const loginRoute = routeList.find(
          (route) => route.method === "GET" && route.path === "/user/login",
        );
        const logoutRoute = routeList.find(
          (route) => route.method === "GET" && route.path === "/user/logout",
        );
        assert.ok(createUser);
        assert.ok(loginRoute);
        assert.ok(logoutRoute);
        const signed = await fetch(base + "/user", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "ada",
            password: "long-secret",
            email: "ada@example.com",
          }),
        });
        assert.equal(
          signed.status,
          createUser.success_status,
          await signed.clone().text(),
        );
        assert.equal((await signed.json()).password_hash, undefined);
        const rejected = await fetch(
          base + "/user/login?username=ada&password=not-the-password",
        );
        assert.equal(rejected.status, 401);
        const loggedIn = await fetch(
          base + "/user/login?username=ada&password=long-secret",
        );
        assert.equal(
          loggedIn.status,
          loginRoute.success_status,
          await loggedIn.clone().text(),
        );
        const ada = await loggedIn.json();
        assert.equal(typeof ada.token, "string");
        const adaHeaders = { authorization: "Bearer " + ada.token };
        const visible = await fetch(base + "/user/ada", {
          headers: adaHeaders,
        });
        assert.equal(visible.status, 200);
        const revoked = await fetch(base + "/user/logout", {
          headers: adaHeaders,
        });
        assert.equal(revoked.status, logoutRoute.success_status);
        assert.equal((await revoked.json()).revoked, true);
        const closed = await fetch(base + "/user/ada", { headers: adaHeaders });
        assert.equal(closed.status, 401);
        const upload = await fetch(
          base + "/pet/" + encodeURIComponent(pet.id) + "/uploadImage",
          { method: "POST", headers },
        );
        assert.equal(upload.status, 404);
      } finally {
        await new Promise((resolveClose) => server.close(resolveClose));
      }
      console.log(
        JSON.stringify({
          operations,
          endpoints_built: coverage.endpoints.built,
          endpoints_not_built: coverage.endpoints.not_built,
          improvements: improvements.items.length,
          skipped: improvements.skipped.length,
        }),
      );
      const origin = studio.url.slice(0, -1);
      const api = async (path, body) => {
        const reply = await fetch(origin + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "content-type": "application/json",
            "x-ree-studio-token": studio.token,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const payload = await reply.json();
        if (!reply.ok) throw new Error(payload.error || reply.statusText);
        return payload;
      };
      const project = await api("/api/projects", {
        name: "Pets",
        question: "What can be rebuilt?",
        mode: "simple",
      });
      const plan = await api(`/api/projects/${project.id}/outside-in/plan`, {
        input: PETSTORE,
      });
      const started = await api(`/api/projects/${project.id}/outside-in`, {
        input: plan.input,
        approved: true,
        plan_digest: plan.plan_digest,
        authorized: true,
      });
      assert.match(started.note, /Endpoints were recovered/);
      assert.doesNotMatch(started.note, /does not support a rebuild/);
      assert.doesNotMatch(started.note, /No documentation URL was supplied/);
      const record = started.project.runs.at(-1);
      assert.equal(record.outside_in.rebuild, true);
      assert.equal(record.outside_in.endpoint_count, operations);
      const live = await api("/api/live-builds", {
        product_name: "Harbor Kit",
        project_id: project.id,
        run_id: record.id,
        feature_ids: [],
        improve_board: board,
      });
      const finished = await settle(api, live.live_id);
      assert.equal(finished.status, "verified", finished.error);
      assert.equal(finished.improvements.title, "What we do better");
      assert.equal(finished.improvements.items.length, 1);
      assert.equal(
        finished.improvements.items[0].quote,
        "Add a photo list to each record.",
      );
    } finally {
      studio.server.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

function operationCount(document) {
  let count = 0;
  for (const item of Object.values(document.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const method of METHODS) if (item[method]) count += 1;
  }
  return count;
}

function writePick(board, name, value) {
  writeFileSync(join(board, "picks", name), JSON.stringify(value) + "\n");
}

function petPayload(document) {
  const operation = document.paths?.["/pet"]?.post;
  const schema = operation?.requestBody?.content?.["application/json"]?.schema;
  const resolved = resolveSchema(document, schema);
  const required = new Set(resolved?.required ?? []);
  const payload = {};
  for (const [name, property] of Object.entries(resolved?.properties ?? {})) {
    if (!required.has(name) && name !== "status") continue;
    payload[name] = sampleProperty(
      resolveSchema(document, property) ?? property,
    );
  }
  if (payload.status === "available") payload.status = "pending";
  return payload;
}

function resolveSchema(document, schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (typeof schema.$ref !== "string") return schema;
  const parts = schema.$ref.replace(/^#\//, "").split("/");
  let node = document;
  for (const part of parts) node = node?.[part];
  return node;
}

async function sessionHeaders(base, product) {
  const { capabilities } = await import(
    pathToFileURL(join(product, "src/capabilities.mjs")).href
  );
  if (!capabilities.auth) return {};
  const email = "owner@example.com";
  const password = "long-secret";
  const registered = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(registered.status, 201);
  const logged = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(logged.status, 200);
  const body = await logged.json();
  return { authorization: "Bearer " + body.token };
}

function sampleProperty(schema) {
  if (Array.isArray(schema?.enum) && schema.enum.length > 0)
    return schema.enum[0];
  if (schema?.type === "array") return ["sample"];
  if (schema?.type === "integer") return 1;
  if (schema?.type === "number") return 1.5;
  if (schema?.type === "boolean") return true;
  if (schema?.type === "object") return { sample: true };
  return "sample";
}

async function settle(api, liveId) {
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    const snapshot = await api(`/api/live-builds/${liveId}`);
    if (snapshot.finished) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The build did not finish.");
}
