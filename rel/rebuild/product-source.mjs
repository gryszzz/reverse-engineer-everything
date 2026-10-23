const PAGE_CLIENT = `
document.addEventListener("click", function (event) {
  var button = event.target.closest("button[data-method]");
  if (!button) return;
  var section = button.closest("section");
  var method = button.getAttribute("data-method");
  var idInput = section.querySelector("input[name=id]");
  var id = idInput && idInput.value ? idInput.value : "";
  var path = section.getAttribute("data-path");
  var template = section.getAttribute("data-item");
  var param = section.getAttribute("data-param");
  var useItem = button.getAttribute("data-item") === "1";
  if (useItem && template && param && id)
    path = template.split("{" + param + "}").join(encodeURIComponent(id));
  var url = new URL(path, location.origin);
  if (!useItem && id && method !== "POST" && method !== "GET")
    url.searchParams.set("id", id);
  var options = { method: method };
  if (method !== "GET") {
    var payload = {};
    var inputs = section.querySelectorAll("input[data-field]");
    for (var index = 0; index < inputs.length; index += 1)
      payload[inputs[index].name] = inputs[index].value;
    options.headers = { "content-type": "application/json" };
    options.body = JSON.stringify(payload);
  }
  fetch(url, options).then(function (response) {
    return response.text().then(function (text) {
      showResult(section, response.status, text);
    });
  });
});
function showResult(section, status, text) {
  var node = section.querySelector("[data-status]");
  var records = section.querySelector("[data-records]");
  var body = null;
  try { body = JSON.parse(text); } catch (error) { body = null; }
  if (!body || typeof body !== "object") {
    node.className = "status bad";
    node.textContent = String(status) + " The response was not a record.";
    records.textContent = "";
    return;
  }
  if (body.error === "rule") {
    node.className = "status bad";
    node.textContent = (body.field || "A field") + " failed the " + (body.rule || "write") + " rule.";
    return;
  }
  if (body.error) {
    node.className = "status bad";
    node.textContent = String(status) + " " + body.error;
    records.textContent = "";
    return;
  }
  if (body.deleted === true) {
    node.className = "status ok";
    node.textContent = "Deleted.";
    records.textContent = "";
    return;
  }
  var items = Array.isArray(body.items) ? body.items : body.id ? [body] : null;
  if (!items) {
    node.className = "status ok";
    node.textContent = String(status) + " Saved.";
    records.textContent = "";
    return;
  }
  if (body.id) {
    var idInput = section.querySelector("input[name=id]");
    if (idInput) idInput.value = body.id;
  }
  node.className = "status ok";
  node.textContent = items.length
    ? String(items.length) + (items.length === 1 ? " record." : " records.")
    : "No records yet.";
  records.innerHTML = renderTable(items);
}
function renderTable(items) {
  if (!items.length) return '<p class="empty">No records yet.</p>';
  var keys = [];
  for (var i = 0; i < items.length; i += 1) {
    var names = Object.keys(items[i]);
    for (var j = 0; j < names.length; j += 1)
      if (keys.indexOf(names[j]) < 0) keys.push(names[j]);
  }
  var html = "<table><thead><tr>";
  for (var c = 0; c < keys.length; c += 1)
    html += "<th>" + escapeText(keys[c]) + "</th>";
  html += "</tr></thead><tbody>";
  for (var r = 0; r < items.length; r += 1) {
    html += "<tr>";
    for (var k = 0; k < keys.length; k += 1) {
      var value = items[r][keys[k]];
      html += "<td>" + escapeText(value == null ? "" : String(value)) + "</td>";
    }
    html += "</tr>";
  }
  return html + "</tbody></table>";
}
function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
`;

export const SERVER_SOURCE = `import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { routes } from "./routes.mjs";

const PRODUCT_NAME = %%PRODUCT_NAME%%;

export function createApp(dataDir) {
  const root = dataDir || process.env.REE_PRODUCT_DATA || process.cwd();
  const dataFile = join(root, "data", "store.json");
  const loaded = readStore(dataFile);
  if (!loaded.ok) throw new Error("data/store.json could not be read.");
  const stores = loaded.stores;
  function commit(response, status, body) {
    try {
      writeStore(dataFile, stores);
    } catch {
      send(response, 500, { error: "store" });
      return;
    }
    send(response, status, body);
  }
  return createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      send(response, 400, { error: "bad-url" });
      return;
    }
    readBody(request).then((body) => {
      if (body === null) {
        send(response, 400, { error: "payload" });
        return;
      }
      const jsonFields = jsonObject(request, body);
      if (jsonFields === false) {
        send(response, 400, { error: "payload" });
        return;
      }
      const bodyParams = jsonFields
        ? new URLSearchParams()
        : new URLSearchParams(body);
      if (
        request.method === "GET" &&
        url.pathname === "/" &&
        !routes.some((item) => item.method === "GET" && item.path === "/")
      ) {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(page());
        return;
      }
      const located = locate(request.method, url.pathname);
      if (located.bad) {
        send(response, 400, { error: "bad-url" });
        return;
      }
      if (!located.route) {
        send(response, located.known ? 405 : 404, {
          error: located.known ? "method" : "not-found",
        });
        return;
      }
      const route = located.route;
      const store = bucket(stores, route.resource || route.path);
      const recordId = located.pathId || url.searchParams.get("id");
      if (route.action === "read") {
        if (!recordId) {
          send(response, 404, { error: "not-found" });
          return;
        }
        const found = store.items.find((item) => item.id === recordId);
        if (!found) {
          send(response, 404, { error: "not-found" });
          return;
        }
        send(response, route.success_status, found);
        return;
      }
      if (route.action === "list") {
        if (recordId) {
          const found = store.items.find((item) => item.id === recordId);
          if (!found) {
            send(response, 404, { error: "not-found" });
            return;
          }
          send(response, route.success_status, found);
          return;
        }
        send(response, route.success_status, {
          items: store.items,
          model: route.model,
          rules: route.rules,
        });
        return;
      }
      if (route.action === "remove") {
        if (recordId) {
          const index = store.items.findIndex((item) => item.id === recordId);
          if (index < 0) {
            send(response, 404, { error: "not-found" });
            return;
          }
          store.items.splice(index, 1);
          commit(response, route.success_status, { deleted: true });
          return;
        }
        store.items.length = 0;
        commit(response, route.success_status, { deleted: true });
        return;
      }
      const fields = fieldsFrom(route, url, bodyParams, jsonFields);
      const id = recordId;
      if ((route.action === "replace" || route.action === "merge") && id) {
        const found = store.items.find((item) => item.id === id);
        if (!found) {
          send(response, 404, { error: "not-found" });
          return;
        }
        const problem = checkRules(route, fields, store.items, id);
        if (problem) {
          send(response, 400, problem);
          return;
        }
        for (const name of route.parameters) found[name] = fields[name];
        commit(response, route.success_status, found);
        return;
      }
      const problem = checkRules(route, fields, store.items, null);
      if (problem) {
        send(response, 400, problem);
        return;
      }
      const record = { id: String(store.next) };
      store.next += 1;
      for (const name of route.parameters) record[name] = fields[name];
      store.items.push(record);
      commit(response, route.success_status, record);
    }).catch(() => {
      if (!response.headersSent) send(response, 500, { error: "failed" });
    });
  });
}

function jsonObject(request, body) {
  const type = String(request.headers["content-type"] ?? "");
  if (!type.toLowerCase().includes("application/json")) return null;
  if (!String(body).trim()) return null;
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    return value;
  } catch {
    return false;
  }
}

function locate(method, pathname) {
  const exact = routes.find(
    (item) => item.method === method && item.path === pathname,
  );
  if (exact) return { route: exact, pathId: null, known: true };
  for (const item of routes) {
    if (item.method !== method || !item.path_param) continue;
    const matched = matchTemplate(item, pathname);
    if (matched.bad) return { route: null, bad: true, known: true };
    if (matched.value !== null)
      return { route: item, pathId: matched.value, known: true };
  }
  const known = routes.some(
    (item) =>
      item.path === pathname ||
      (item.path_param && matchTemplate(item, pathname).value !== null),
  );
  return { route: null, pathId: null, known };
}

function matchTemplate(route, pathname) {
  const token = "{" + route.path_param + "}";
  const pieces = route.path.split(token);
  if (pieces.length !== 2) return { value: null };
  if (!pathname.startsWith(pieces[0])) return { value: null };
  const rest = pathname.slice(pieces[0].length);
  const tail = pieces[1];
  let raw = rest;
  if (tail) {
    if (!rest.endsWith(tail)) return { value: null };
    raw = rest.slice(0, rest.length - tail.length);
  }
  if (!raw || raw.includes("/")) return { value: null };
  try {
    return { value: decodeURIComponent(raw) };
  } catch {
    return { bad: true, value: null };
  }
}

function readStore(dataFile) {
  if (!existsSync(dataFile)) return { ok: true, stores: new Map() };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(dataFile, "utf8"));
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false };
  const stores = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { ok: false };
    if (!Array.isArray(value.items) || !Number.isInteger(value.next))
      return { ok: false };
    stores.set(key, { items: value.items, next: value.next });
  }
  return { ok: true, stores };
}

function writeStore(dataFile, stores) {
  const plain = {};
  for (const [key, value] of stores)
    plain[key] = { items: value.items, next: value.next };
  mkdirSync(dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, JSON.stringify(plain) + "\\n");
}

function bucket(stores, path) {
  const current = stores.get(path);
  if (current) return current;
  const created = { items: [], next: 1 };
  stores.set(path, created);
  return created;
}

function fieldsFrom(route, url, bodyParams, jsonFields) {
  const fields = {};
  for (const name of route.parameters) {
    if (
      jsonFields &&
      Object.prototype.hasOwnProperty.call(jsonFields, name)
    ) {
      const value = jsonFields[name];
      fields[name] =
        value === null || value === undefined ? null : String(value);
    } else if (url.searchParams.has(name))
      fields[name] = url.searchParams.get(name);
    else if (bodyParams.has(name)) fields[name] = bodyParams.get(name);
    else fields[name] = null;
  }
  return fields;
}

function checkRules(route, fields, items, ignoreId) {
  for (const name of route.parameters) {
    const value = fields[name];
    const blank = value === null || String(value).trim() === "";
    if (route.rules.includes("required") && blank)
      return { error: "rule", rule: "required", field: name };
    if (
      route.rules.includes("max-length") &&
      typeof value === "string" &&
      value.length > 80
    )
      return { error: "rule", rule: "max-length", field: name };
    if (
      route.rules.includes("unique") &&
      typeof value === "string" &&
      value.trim() !== "" &&
      items.some((item) => item.id !== ignoreId && item[name] === value)
    )
      return { error: "rule", rule: "unique", field: name };
  }
  return null;
}

function readBody(request) {
  return new Promise((resolveBody) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65536) tooBig = true;
      else chunks.push(chunk);
    });
    request.on("end", () => {
      resolveBody(tooBig ? null : Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", () => resolveBody(""));
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function markFrom(name) {
  const parts = String(name).split(/\\s+/).filter(Boolean);
  const letters = (parts[0] ? parts[0].charAt(0) : "R") + (parts[1] ? parts[1].charAt(0) : "");
  return letters.toUpperCase();
}

function titleFrom(path) {
  const parts = String(path).split("/").filter(Boolean);
  const last = (parts[parts.length - 1] || "Records").replace(/[{}]/g, "");
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function ruleText(rules) {
  const labels = (rules ?? []).map((rule) => {
    if (rule === "max-length") return "80 characters at most";
    return rule;
  });
  return labels.join(", ") || "none";
}

const PAGE_STYLE = [
  ":root{color-scheme:dark;--bg:#101114;--surface:#17181c;--line:rgba(255,255,255,.08);--text:#f3f4f6;--muted:#9aa1ab;--accent:#7aa2ff;--ink:#0d1118;--ok:#6fbf96;--bad:#e08580}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
  ".top{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:16px 28px;border-bottom:1px solid var(--line);background:var(--surface)}",
  ".brand{display:flex;gap:12px;align-items:center}",
  ".mark{margin:0;width:36px;height:36px;display:grid;place-items:center;border-radius:9px;background:var(--accent);color:var(--ink);font-size:12px;font-weight:700}",
  "h1{font-size:16px;margin:0}h2{font-size:20px;margin:0}",
  ".quiet{color:var(--muted);margin:0;font-size:13px}",
  "main{max-width:880px;margin:0 auto;padding:28px 20px 48px;display:grid;gap:16px}",
  "section{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px}",
  ".head{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-bottom:14px}",
  ".fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}",
  "label{display:grid;gap:6px;font-size:13px;color:var(--muted)}",
  "input{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px}",
  ".actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}",
  "button{font:inherit;color:var(--text);background:transparent;border:1px solid var(--line);border-radius:8px;padding:8px 12px;cursor:pointer}",
  "button.primary{background:var(--accent);color:var(--ink);border-color:transparent;font-weight:650}",
  ".status{min-height:1.2em;margin:0 0 8px}.status.bad{color:var(--bad)}.status.ok{color:var(--ok)}",
  "table{width:100%;border-collapse:collapse}",
  "th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:14px}",
  "th{color:var(--muted);font-size:12px;font-weight:600}",
  ".empty{color:var(--muted)}",
  "code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}",
].join("");

function page() {
  const groups = [];
  for (const route of routes) {
    const key = route.resource || route.path;
    let group = null;
    for (let index = 0; index < groups.length; index += 1) {
      if (groups[index].key === key) group = groups[index];
    }
    if (!group) {
      group = { key, routes: [] };
      groups.push(group);
    }
    group.routes.push(route);
  }
  const sections = groups.map((group) => {
    let sample = group.routes[0];
    let collection = null;
    let item = null;
    for (const route of group.routes) {
      if (route.path_param) {
        if (!item) item = route;
      } else if (!collection) {
        collection = route.path;
        sample = route;
      }
    }
    if (!collection) collection = item ? item.collection : sample.path;
    const fields = (sample.model ?? []).filter((name) => name !== "id");
    const rules = ruleText(sample.rules);
    const inputs = fields
      .map(
        (name) =>
          '<label>' +
          escapeHtml(name) +
          ' <input name="' +
          escapeHtml(name) +
          '" data-field="1" autocomplete="off"></label>',
      )
      .join("");
    const itemAttr = item
      ? '" data-item="' +
        escapeHtml(item.path) +
        '" data-param="' +
        escapeHtml(item.path_param)
      : "";
    const verb = (label, method, primary, onItem) =>
      '<button type="button"' +
      (primary ? ' class="primary"' : "") +
      ' data-method="' +
      method +
      '"' +
      (onItem ? ' data-item="1"' : "") +
      ">" +
      label +
      "</button>";
    const open = item ? verb("Open", "GET", false, true) : "";
    const change = item
      ? verb("Update", "PUT", false, true) +
        verb("Patch", "PATCH", false, true) +
        verb("Delete", "DELETE", false, true)
      : verb("Update", "PUT", false, false) +
        verb("Patch", "PATCH", false, false) +
        verb("Delete", "DELETE", false, false);
    const itemLine = item
      ? '<p class="quiet">One record <code>' +
        escapeHtml(item.path) +
        "</code></p>"
      : "";
    return (
      '<section data-path="' +
      escapeHtml(collection) +
      itemAttr +
      '"><div class="head"><div><h2>' +
      escapeHtml(titleFrom(collection)) +
      '</h2><p class="quiet"><code>' +
      escapeHtml(collection) +
      "</code></p></div>" +
      itemLine +
      '</div><div class="fields">' +
      inputs +
      '<label>id <input name="id" autocomplete="off"></label></div><p class="quiet">Rules: ' +
      escapeHtml(rules) +
      '.</p><div class="actions">' +
      verb("List", "GET", true, false) +
      verb("Create", "POST", true, false) +
      open +
      change +
      '</div><p class="status" data-status role="status"></p><div class="records" data-records></div></section>'
    );
  });
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
    escapeHtml(PRODUCT_NAME) +
    "</title><style>" +
    PAGE_STYLE +
    '</style></head><body><header class="top"><div class="brand"><p class="mark">' +
    escapeHtml(markFrom(PRODUCT_NAME)) +
    '</p><div><h1 data-product="' +
    escapeHtml(PRODUCT_NAME) +
    '">' +
    escapeHtml(PRODUCT_NAME) +
    '</h1><p class="quiet">A local record book.</p></div></div><p class="quiet">Saved on this machine.</p></header><main>' +
    sections.join("") +
    "</main><script>" +
    PAGE_SCRIPT +
    "</script></body></html>"
  );
}

const PAGE_SCRIPT = ${JSON.stringify(PAGE_CLIENT)};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function listen(port = 0, hostname = "127.0.0.1", dataDir) {
  const server = createApp(dataDir);
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

export function serverSource(productName) {
  return SERVER_SOURCE.replaceAll(
    "%%PRODUCT_NAME%%",
    JSON.stringify(String(productName)),
  );
}

export const TEST_SOURCE = `import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { behaviors } from "../src/behaviors.mjs";
import { routes } from "../src/routes.mjs";
import { listen } from "../src/server.mjs";

const spec = JSON.parse(
  readFileSync(new URL("../behavior-spec.json", import.meta.url), "utf8"),
);

async function call(base, route, value, id) {
  let path = route.path;
  if (route.path_param && id)
    path = path.replace(
      "{" + route.path_param + "}",
      encodeURIComponent(id),
    );
  const url = new URL(base + path);
  if (id && !route.path_param) url.searchParams.set("id", id);
  const headers = {};
  let payload;
  if (value !== null && route.body === "json") {
    payload = {};
    for (const name of route.parameters) payload[name] = value;
    headers["content-type"] = "application/json";
  } else if (value !== null) {
    for (const name of route.parameters) url.searchParams.set(name, value);
  }
  return fetch(url, {
    method: route.method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

for (const behavior of behaviors) {
  if (behavior.status === "implemented") {
    test("feature " + behavior.id, async () => {
      const primary = routes.find((item) => item.key === behavior.handler);
      assert.ok(primary, behavior.id);
      const owned = routes.filter((item) => item.resource === primary.resource);
      const prefer = (action) =>
        owned.find((item) => item.action === action && item.path_param) ??
        owned.find((item) => item.action === action);
      const create = owned.find((item) => item.action === "create") ?? primary;
      const list = owned.find((item) => item.action === "list");
      const update = prefer("replace");
      const merge = prefer("merge");
      const remove = prefer("remove");
      const dataDir = mkdtempSync(join(tmpdir(), "ree-product-"));
      const server = await listen(0, "127.0.0.1", dataDir);
      try {
        const base = "http://127.0.0.1:" + server.address().port;
        const page = await fetch(base + "/");
        assert.equal(
          page.headers.get("content-type"),
          "text/html; charset=utf-8",
        );
        const html = await page.text();
        const marker = primary.path_param
          ? 'data-item="' + primary.path + '"'
          : 'data-path="' + primary.path + '"';
        assert.equal(html.includes(marker), true, primary.path);
        assert.equal(html.includes("application/json"), true);
        assert.match(html, /data-product="/);
        const created = await call(base, create, "sample");
        assert.equal(created.status, create.success_status);
        const body = await created.json();
        assert.equal(typeof body.id, "string");
        for (const name of create.parameters)
          assert.equal(body[name], "sample");
        if (list) {
          const listed = await call(base, list, null);
          assert.equal(listed.status, list.success_status);
          const payload = await listed.json();
          assert.ok(Array.isArray(payload.items));
          assert.ok(Array.isArray(payload.model));
          assert.ok(payload.items.some((item) => item.id === body.id));
        }
        const saved = JSON.parse(
          readFileSync(join(dataDir, "data", "store.json"), "utf8"),
        );
        assert.ok(
          Object.values(saved).some(
            (bucket) =>
              Array.isArray(bucket.items) &&
              bucket.items.some((item) => item.id === body.id),
          ),
        );
        const revived = await listen(0, "127.0.0.1", dataDir);
        try {
          if (list) {
            const kept = await (
              await call(
                "http://127.0.0.1:" + revived.address().port,
                list,
                null,
              )
            ).json();
            assert.ok(kept.items.some((item) => item.id === body.id));
          }
        } finally {
          await new Promise((resolveClose) => revived.close(resolveClose));
        }
        const read = owned.find((item) => item.action === "read");
        if (read) {
          const opened = await call(base, read, null, body.id);
          assert.equal(opened.status, read.success_status);
          assert.equal((await opened.json()).id, body.id);
          const missing = await call(base, read, null, "missing-id");
          assert.equal(missing.status, 404);
        }
        if (create.rules.includes("unique")) {
          const again = await call(base, create, "sample");
          assert.equal(again.status, 400);
          assert.equal((await again.json()).rule, "unique");
        }
        if (create.rules.includes("required") && create.parameters.length) {
          const bare = await call(base, create, null);
          assert.equal(bare.status, 400);
          assert.equal((await bare.json()).rule, "required");
        }
        if (create.rules.includes("max-length") && create.parameters.length) {
          const tooLong = await call(base, create, "x".repeat(81));
          assert.equal(tooLong.status, 400);
          assert.equal((await tooLong.json()).rule, "max-length");
        }
        if (update) {
          const next = await call(base, update, "edited", body.id);
          assert.equal(next.status, update.success_status);
          const updated = await next.json();
          assert.equal(updated.id, body.id);
          for (const name of update.parameters)
            assert.equal(updated[name], "edited");
        }
        if (merge) {
          const next = await call(base, merge, "merged", body.id);
          assert.equal(next.status, merge.success_status);
          const updated = await next.json();
          assert.equal(updated.id, body.id);
        }
        if (remove) {
          const gone = await call(base, remove, null, body.id);
          assert.equal(gone.status, remove.success_status);
          assert.equal((await gone.json()).deleted, true);
          if (list) {
            const after = await (await call(base, list, null)).json();
            assert.equal(
              after.items.some((item) => item.id === body.id),
              false,
            );
          }
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
    if (feature.name && feature.name.length >= 12) quotes.push(feature.name);
  }
  for (const limitation of spec.limitations) {
    if (limitation.statement?.text && limitation.statement.text.length >= 12)
      quotes.push(limitation.statement.text);
  }
  for (const quote of quotes) assert.equal(source.includes(quote), false, quote);
});
`;
