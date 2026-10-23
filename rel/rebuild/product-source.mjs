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
  var query = section.querySelector("input[name=q]");
  if (!useItem && method === "GET" && query && query.value)
    url.searchParams.set("q", query.value);
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

export const SERVER_SOURCE = `import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { capabilities } from "./capabilities.mjs";
import { routes } from "./routes.mjs";

const PRODUCT_NAME = %%PRODUCT_NAME%%;

export function createApp(dataDir) {
  const root = dataDir || process.env.REE_PRODUCT_DATA || process.cwd();
  const dataFile = join(root, "data", "store.sqlite");
  let db = null;
  let stores = new Map();
  if (capabilities.storage === "sqlite") {
    const opened = openStore(dataFile);
    if (!opened.ok) throw new Error("data/store.sqlite could not be opened.");
    const loaded = readStore(opened.db);
    if (!loaded.ok) throw new Error("data/store.sqlite could not be read.");
    db = opened.db;
    stores = loaded.stores;
  }
  function commit(response, status, body) {
    try {
      if (db) writeStore(db, stores);
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
        handleExtra(
          request,
          response,
          url,
          bodyParams,
          jsonFields,
          commit,
          stores,
        )
      )
        return;
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
      const session = currentUser(request, stores);
      if (!session.ok) {
        send(response, 401, { error: "auth" });
        return;
      }
      const store = bucket(stores, route.resource || route.path);
      const recordId = located.pathId || url.searchParams.get("id");
      if (route.action === "read") {
        if (!recordId) {
          send(response, 404, { error: "not-found" });
          return;
        }
        const found = store.items.find((item) =>
          sameRecord(item, recordId, route.path_param),
        );
        if (!found || !visible(found, session.user)) {
          send(response, 404, { error: "not-found" });
          return;
        }
        send(response, route.success_status, found);
        return;
      }
      if (route.action === "list") {
        if (recordId) {
          const found = store.items.find((item) =>
            sameRecord(item, recordId, route.path_param),
          );
          if (!found || !visible(found, session.user)) {
            send(response, 404, { error: "not-found" });
            return;
          }
          send(response, route.success_status, found);
          return;
        }
        send(response, route.success_status, {
          items: listItems(store.items, route, url, session.user),
          model: route.model,
          rules: route.rules,
        });
        return;
      }
      if (route.action === "remove") {
        if (recordId) {
          const index = store.items.findIndex((item) =>
            sameRecord(item, recordId, route.path_param),
          );
          if (index < 0 || !visible(store.items[index], session.user)) {
            send(response, 404, { error: "not-found" });
            return;
          }
          store.items.splice(index, 1);
          commit(response, route.success_status, { deleted: true });
          return;
        }
        if (capabilities.auth) {
          for (let index = store.items.length - 1; index >= 0; index -= 1) {
            if (visible(store.items[index], session.user))
              store.items.splice(index, 1);
          }
        } else store.items.length = 0;
        commit(response, route.success_status, { deleted: true });
        return;
      }
      const fields = fieldsFrom(route, url, bodyParams, jsonFields);
      const relation = relationProblem(stores, route, fields);
      if (relation) {
        send(response, 400, relation);
        return;
      }
      const id = recordId;
      if ((route.action === "replace" || route.action === "merge") && id) {
        const found = store.items.find((item) =>
          sameRecord(item, id, route.path_param),
        );
        if (!found || !visible(found, session.user)) {
          send(response, 404, { error: "not-found" });
          return;
        }
        const problem = checkRules(route, fields, store.items, found.id);
        if (problem) {
          send(response, 400, problem);
          return;
        }
        for (const name of writeNames(route)) {
          if (name === "id") continue;
          if (Object.prototype.hasOwnProperty.call(fields, name))
            found[name] = fields[name];
        }
        commit(response, route.success_status, found);
        return;
      }
      const problem = checkRules(route, fields, store.items, null);
      if (problem) {
        send(response, 400, problem);
        return;
      }
      let key = String(store.next);
      if (
        Object.prototype.hasOwnProperty.call(fields, "id") &&
        fields.id !== null &&
        String(fields.id).trim() !== ""
      )
        key = String(fields.id);
      const record = { id: key };
      store.next += 1;
      if (capabilities.auth) record.owner = session.user.id;
      for (const name of writeNames(route)) {
        if (name === "id") continue;
        if (Object.prototype.hasOwnProperty.call(fields, name))
          record[name] = fields[name];
      }
      store.items.push(record);
      commit(response, route.success_status, record);
    }).catch(() => {
      if (!response.headersSent) send(response, 500, { error: "failed" });
    });
  });
}

function handleExtra(request, response, url, bodyParams, jsonFields, commit, stores) {
  if (capabilities.pricing && request.method === "GET" && url.pathname === "/pricing") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pricingPage());
    return true;
  }
  if (capabilities.pricing && request.method === "POST" && url.pathname === "/checkout") {
    checkout(response, jsonFields, bodyParams);
    return true;
  }
  if (capabilities.auth && url.pathname === "/auth/register" && request.method === "POST") {
    registerAccount(response, url, bodyParams, jsonFields, commit, stores);
    return true;
  }
  if (capabilities.auth && url.pathname === "/auth/login" && request.method === "POST") {
    loginAccount(response, url, bodyParams, jsonFields, commit, stores);
    return true;
  }
  if (
    capabilities.auth &&
    capabilities.auth.mode === "magic" &&
    url.pathname === "/auth/magic" &&
    request.method === "POST"
  ) {
    magicAccount(response, url, bodyParams, jsonFields, commit, stores);
    return true;
  }
  if (capabilities.webhooks && url.pathname === "/webhooks") {
    if (capabilities.auth) {
      const session = currentUser(request, stores);
      if (!session.ok) {
        send(response, 401, { error: "auth" });
        return true;
      }
    }
    if (request.method === "GET") {
      const store = bucket(stores, "webhooks");
      send(response, 200, { items: store.items, delivered: false });
      return true;
    }
    if (request.method === "POST") {
      const store = bucket(stores, "webhooks");
      const record = {
        id: String(store.next),
        name: textValue("name", url, bodyParams, jsonFields) || "event",
        delivered: false,
      };
      store.next += 1;
      store.items.push(record);
      commit(response, 201, {
        ...record,
        note: "The event was stored locally. It was not sent.",
      });
      return true;
    }
  }
  return false;
}

function currentUser(request, stores) {
  if (!capabilities.auth) return { ok: true, user: null };
  const header = String(request.headers.authorization ?? "");
  const match = /^Bearer\\s+(\\S+)$/iu.exec(header);
  if (!match) return { ok: false };
  const sessions = bucket(stores, "auth:sessions");
  const session = sessions.items.find((item) => item.token === match[1]);
  if (!session) return { ok: false };
  const user = bucket(stores, "auth:users").items.find(
    (item) => item.id === session.user,
  );
  if (!user) return { ok: false };
  return { ok: true, user };
}

function visible(item, user) {
  if (!capabilities.auth) return true;
  if (!item?.owner || !user) return !capabilities.auth;
  if (item.owner === user.id) return true;
  return capabilities.roles === true && user.role === "admin";
}

function listItems(items, route, url, user) {
  let chosen = items.filter((item) => visible(item, user));
  if (!capabilities.search) return chosen;
  const q = url.searchParams.get("q");
  if (q) {
    const needle = q.toLowerCase();
    chosen = chosen.filter((item) =>
      (route.model ?? []).some((name) =>
        String(item[name] ?? "").toLowerCase().includes(needle),
      ),
    );
  }
  for (const name of route.model ?? []) {
    if (name === "id" || name === "owner") continue;
    if (name === "q" || name === "query" || name === "search") continue;
    if (name === "limit" || name === "offset" || name === "page") continue;
    if (!url.searchParams.has(name)) continue;
    const expected = url.searchParams.get(name);
    chosen = chosen.filter((item) => item[name] === expected);
  }
  const offset = countParam(url.searchParams.get("offset"));
  const limit = countParam(url.searchParams.get("limit"));
  if (offset === false || limit === false) return chosen;
  const start = offset ?? 0;
  if (limit === null) return start ? chosen.slice(start) : chosen;
  return chosen.slice(start, start + limit);
}

function countParam(value) {
  if (value === null || value === undefined || value === "") return null;
  if (!/^\\d+$/u.test(value)) return false;
  return Number(value);
}

function relationProblem(stores, route, fields) {
  for (const relation of capabilities.relations ?? []) {
    if (!route.parameters.includes(relation.field)) continue;
    const value = fields[relation.field];
    if (value === null || String(value).trim() === "") continue;
    const other = bucket(stores, relation.bucket);
    if (!other.items.some((item) => item.id === String(value)))
      return { error: "relation", field: relation.field };
  }
  return null;
}

function registerAccount(response, url, bodyParams, jsonFields, commit, stores) {
  const email = normalizeEmail(textValue("email", url, bodyParams, jsonFields));
  const password = textValue("password", url, bodyParams, jsonFields);
  if (!email.includes("@") || password.length < 8) {
    send(response, 400, { error: "account" });
    return;
  }
  const users = bucket(stores, "auth:users");
  if (users.items.some((item) => item.email === email)) {
    send(response, 400, { error: "account" });
    return;
  }
  const record = {
    id: String(users.next),
    email,
    password_hash: hashPassword(password),
    role: capabilities.roles && users.items.length === 0 ? "admin" : "member",
  };
  users.next += 1;
  users.items.push(record);
  commit(response, 201, publicUser(record));
}

function loginAccount(response, url, bodyParams, jsonFields, commit, stores) {
  const email = normalizeEmail(textValue("email", url, bodyParams, jsonFields));
  const password = textValue("password", url, bodyParams, jsonFields);
  const user = bucket(stores, "auth:users").items.find((item) => item.email === email);
  if (!user || !checkPassword(password, user.password_hash)) {
    send(response, 401, { error: "auth" });
    return;
  }
  const token = issueSession(stores, user.id);
  commit(response, 200, { token, user: publicUser(user) });
}

function magicAccount(response, url, bodyParams, jsonFields, commit, stores) {
  const email = normalizeEmail(textValue("email", url, bodyParams, jsonFields));
  if (!email.includes("@")) {
    send(response, 400, { error: "account" });
    return;
  }
  const users = bucket(stores, "auth:users");
  let user = users.items.find((item) => item.email === email);
  if (!user) {
    user = {
      id: String(users.next),
      email,
      password_hash: null,
      role: capabilities.roles && users.items.length === 0 ? "admin" : "member",
    };
    users.next += 1;
    users.items.push(user);
  }
  const token = issueSession(stores, user.id);
  commit(response, 200, {
    token,
    user: publicUser(user),
    note: "No mailer is configured. The token is local.",
  });
}

function issueSession(stores, userId) {
  const sessions = bucket(stores, "auth:sessions");
  const token = randomBytes(24).toString("hex");
  sessions.items.push({ id: String(sessions.next), token, user: userId });
  sessions.next += 1;
  return token;
}

function publicUser(user) {
  const copy = { id: user.id, email: user.email };
  if (capabilities.roles) copy.role = user.role;
  return copy;
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(String(password), salt, 32).toString("hex");
  return salt + ":" + hash;
}

function checkPassword(password, stored) {
  const parts = String(stored ?? "").split(":");
  if (parts.length !== 2) return false;
  const next = scryptSync(String(password), parts[0], 32);
  const have = Buffer.from(parts[1], "hex");
  if (have.length !== next.length) return false;
  return timingSafeEqual(have, next);
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function textValue(name, url, bodyParams, jsonFields) {
  if (jsonFields && Object.prototype.hasOwnProperty.call(jsonFields, name)) {
    const value = jsonFields[name];
    return value === null || value === undefined ? "" : String(value);
  }
  if (url.searchParams.has(name)) return url.searchParams.get(name) ?? "";
  if (bodyParams.has(name)) return bodyParams.get(name) ?? "";
  return "";
}

function checkout(response, jsonFields, bodyParams) {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (key.startsWith("sk_live_")) {
    send(response, 400, {
      error: "live-key",
      note: "Live Stripe keys are refused.",
    });
    return;
  }
  const plans = capabilities.pricing?.plans ?? [];
  if (!key.startsWith("sk_test_")) {
    send(response, 200, {
      configured: false,
      plans,
      note: "Checkout is not configured. Set STRIPE_SECRET_KEY to a test key.",
    });
    return;
  }
  const requested = jsonFields?.plan ?? bodyParams.get("plan");
  const plan =
    plans.find((item) => item.name === requested) ?? plans[0] ?? null;
  const amount = stripeCents(plan?.amount);
  if (!plan || amount === null) {
    send(response, 400, { error: "price" });
    return;
  }
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": String(plan.currency || "usd").toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(amount),
    "line_items[0][price_data][product_data][name]": plan.name,
    success_url: "https://example.com/pricing?status=success",
    cancel_url: "https://example.com/pricing?status=cancel",
  });
  fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + key,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  })
    .then(async (stripe) => {
      const payload = await stripe.json().catch(() => null);
      if (!stripe.ok) {
        send(response, 502, { error: "stripe", configured: true, mode: "test" });
        return;
      }
      send(response, 200, {
        configured: true,
        mode: "test",
        url: payload?.url ?? null,
      });
    })
    .catch(() => {
      if (!response.headersSent)
        send(response, 502, { error: "stripe", configured: true, mode: "test" });
    });
}

function stripeCents(amount) {
  if (typeof amount !== "string" || !/^\\d+(\\.\\d{1,2})?$/u.test(amount))
    return null;
  const parts = amount.split(".");
  const frac = (parts[1] ?? "").padEnd(2, "0");
  return Number(parts[0]) * 100 + Number(frac || 0);
}

function pricingPage() {
  const plans = capabilities.pricing?.plans ?? [];
  const cards = plans
    .map(
      (plan) =>
        "<article><h2>" +
        escapeHtml(plan.name) +
        "</h2><p>" +
        escapeHtml(plan.display || plan.amount || "Price recorded without a display amount.") +
        "</p></article>",
    )
    .join("");
  return (
    "<!doctype html><html lang=\\"en\\"><head><meta charset=\\"utf-8\\"><title>" +
    escapeHtml(PRODUCT_NAME) +
    " pricing</title><style>" +
    PAGE_STYLE +
    "</style></head><body><main><h1 data-pricing=\\"1\\">Pricing</h1><p class=\\"quiet\\">Test mode only. A live Stripe key is refused.</p>" +
    cards +
    "<form method=\\"post\\" action=\\"/checkout\\"><button type=\\"submit\\">Checkout</button></form></main></body></html>"
  );
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

function openStore(dataFile) {
  try {
    mkdirSync(dirname(dataFile), { recursive: true });
    const db = new DatabaseSync(dataFile);
    db.exec(
      "CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (bucket, id))",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS sequences (bucket TEXT PRIMARY KEY, next INTEGER NOT NULL)",
    );
    return { ok: true, db };
  } catch {
    return { ok: false };
  }
}

function readStore(db) {
  let rows;
  let sequences;
  try {
    rows = db.prepare("SELECT bucket, id, body FROM records").all();
    sequences = db.prepare("SELECT bucket, next FROM sequences").all();
  } catch {
    return { ok: false };
  }
  const stores = new Map();
  for (const row of rows) {
    let body;
    try {
      body = JSON.parse(row.body);
    } catch {
      return { ok: false };
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return { ok: false };
    bucket(stores, row.bucket).items.push(body);
  }
  for (const row of sequences) {
    if (!Number.isInteger(row.next)) return { ok: false };
    bucket(stores, row.bucket).next = row.next;
  }
  return { ok: true, stores };
}

function writeStore(db, stores) {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM records");
    db.exec("DELETE FROM sequences");
    const insert = db.prepare(
      "INSERT INTO records (bucket, id, body) VALUES (?, ?, ?)",
    );
    const sequence = db.prepare(
      "INSERT INTO sequences (bucket, next) VALUES (?, ?)",
    );
    for (const [key, value] of stores) {
      for (const item of value.items)
        insert.run(key, String(item.id), JSON.stringify(item));
      sequence.run(key, value.next);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* The failed transaction is already closed. */
    }
    throw error;
  }
}

function bucket(stores, path) {
  const current = stores.get(path);
  if (current) return current;
  const created = { items: [], next: 1 };
  stores.set(path, created);
  return created;
}

function sameRecord(item, recordId, param) {
  if (!recordId) return false;
  if (item.id === recordId) return true;
  if (
    param &&
    param !== "id" &&
    Object.prototype.hasOwnProperty.call(item, param) &&
    String(item[param]) === recordId
  )
    return true;
  return false;
}

function writeNames(route) {
  if (Array.isArray(route.fields) && route.fields.length)
    return route.fields.map((field) => field.name);
  return route.parameters;
}

function fieldsFrom(route, url, bodyParams, jsonFields) {
  if (Array.isArray(route.fields) && route.fields.length) {
    const fields = {};
    for (const field of route.fields) {
      const name = field.name;
      if (
        jsonFields &&
        Object.prototype.hasOwnProperty.call(jsonFields, name)
      )
        fields[name] = jsonFields[name];
      else if (url.searchParams.has(name))
        fields[name] = coerceQuery(field, url.searchParams.get(name));
      else if (bodyParams.has(name))
        fields[name] = coerceQuery(field, bodyParams.get(name));
    }
    return fields;
  }
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

function coerceQuery(field, raw) {
  if (raw === null) return null;
  if (field.type === "integer" || field.type === "number") {
    const number = Number(raw);
    return Number.isFinite(number) ? number : raw;
  }
  if (field.type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  return raw;
}

function checkRules(route, fields, items, ignoreId) {
  if (Array.isArray(route.fields) && route.fields.length)
    return checkSchema(route, fields, items, ignoreId);
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

function checkSchema(route, fields, items, ignoreId) {
  for (const field of route.fields) {
    const present = Object.prototype.hasOwnProperty.call(fields, field.name);
    const value = present ? fields[field.name] : undefined;
    const blank =
      !present ||
      value === null ||
      (typeof value === "string" && value.trim() === "");
    if (field.required && blank)
      return { error: "rule", rule: "required", field: field.name };
    if (!present || blank) continue;
    if (
      Array.isArray(field.enum) &&
      field.enum.length > 0 &&
      !field.enum.includes(value)
    )
      return { error: "rule", rule: "enum", field: field.name };
    if (!typeOk(field.type, value))
      return { error: "rule", rule: "type", field: field.name };
    if (
      route.rules.includes("unique") &&
      items.some((item) => item.id !== ignoreId && item[field.name] === value)
    )
      return { error: "rule", rule: "unique", field: field.name };
  }
  return null;
}

function typeOk(type, value) {
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return true;
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
    const search = capabilities.search
      ? '<label>Search <input name="q" autocomplete="off"></label>'
      : "";
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
      search +
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
    '</h1><p class="quiet">A local record book.</p></div></div><p class="quiet">' +
    (capabilities.storage === "sqlite"
      ? "Saved in SQLite on this machine."
      : "Nothing is stored.") +
    (capabilities.pricing ? ' <a href="/pricing">Pricing</a>' : "") +
    "</p></header><main>" +
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
  const hostname = process.env.HOST || "127.0.0.1";
  if (hostname !== "127.0.0.1" && hostname !== "0.0.0.0") {
    console.error("HOST must be 127.0.0.1 or 0.0.0.0.");
    process.exit(2);
  }
  server.listen(port, hostname, () => {
    console.log("listening http://" + hostname + ":" + server.address().port);
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { behaviors } from "../src/behaviors.mjs";
import { capabilities } from "../src/capabilities.mjs";
import { routes } from "../src/routes.mjs";
import { listen } from "../src/server.mjs";

const spec = JSON.parse(
  readFileSync(new URL("../behavior-spec.json", import.meta.url), "utf8"),
);

function sampleFor(field) {
  if (Array.isArray(field.enum) && field.enum.length > 0) return field.enum[0];
  if (field.type === "integer") return 1;
  if (field.type === "number") return 1.5;
  if (field.type === "boolean") return true;
  if (field.type === "array") return ["sample"];
  if (field.type === "object") return { sample: true };
  return "sample";
}

function expectedValue(route, name, overrides, fallback) {
  if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
  const field = (route.fields || []).find((item) => item.name === name);
  if (field) return sampleFor(field);
  return fallback;
}

async function call(base, route, value, id, headers = {}, overrides = {}) {
  let path = route.path;
  if (route.path_param && id)
    path = path.replace(
      "{" + route.path_param + "}",
      encodeURIComponent(id),
    );
  const url = new URL(base + path);
  if (id && !route.path_param) url.searchParams.set("id", id);
  const extra = { ...headers };
  let payload;
  if (value !== null && route.body === "json") {
    payload = {};
    for (const name of route.parameters) {
      if (name === "id") continue;
      payload[name] = expectedValue(route, name, overrides, value);
    }
    extra["content-type"] = "application/json";
  } else if (value !== null) {
    for (const name of route.parameters) {
      if (name === "id") continue;
      const chosen = expectedValue(route, name, overrides, value);
      url.searchParams.set(name, chosen);
    }
  }
  return fetch(url, {
    method: route.method,
    headers: extra,
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

async function authHeaders(base) {
  if (!capabilities.auth) return {};
  const email = "owner@example.com";
  if (capabilities.auth.mode === "magic") {
    const response = await fetch(base + "/auth/magic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.match(body.note, /No mailer is configured/);
    return { authorization: "Bearer " + body.token };
  }
  const registered = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "long-secret" }),
  });
  assert.ok(registered.status === 201 || registered.status === 400);
  const logged = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "long-secret" }),
  });
  const body = await logged.json();
  assert.equal(logged.status, 200, JSON.stringify(body));
  return { authorization: "Bearer " + body.token };
}

async function parentOverrides(base, route, headers) {
  const overrides = {};
  for (const relation of capabilities.relations ?? []) {
    if (!route.parameters.includes(relation.field)) continue;
    const parent = routes.find(
      (item) =>
        item.action === "create" &&
        (item.resource === relation.bucket || item.path === relation.bucket),
    );
    assert.ok(parent, relation.field);
    const made = await call(base, parent, "sample", null, headers, {});
    assert.equal(made.status, parent.success_status, relation.field);
    const madeBody = await made.json();
    const field = (route.fields || []).find((item) => item.name === relation.field);
    const numeric = Number(madeBody.id);
    const numericField =
      field &&
      (field.type === "integer" || field.type === "number") &&
      Number.isFinite(numeric);
    overrides[relation.field] = numericField ? numeric : madeBody.id;
  }
  return overrides;
}

function savedIds(dataDir) {
  const db = new DatabaseSync(join(dataDir, "data", "store.sqlite"));
  try {
    return db
      .prepare("SELECT body FROM records")
      .all()
      .map((row) => JSON.parse(row.body).id);
  } finally {
    db.close();
  }
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
        const headers = await authHeaders(base);
        const overrides = await parentOverrides(base, create, headers);
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
        const created = await call(base, create, "sample", null, headers, overrides);
        assert.equal(created.status, create.success_status);
        const body = await created.json();
        assert.equal(typeof body.id, "string");
        for (const name of create.parameters) {
          if (name === "id") continue;
          assert.deepEqual(
            body[name],
            expectedValue(create, name, overrides, "sample"),
          );
        }
        if (list) {
          const listed = await call(base, list, null, null, headers);
          assert.equal(listed.status, list.success_status);
          const payload = await listed.json();
          assert.ok(Array.isArray(payload.items));
          assert.ok(Array.isArray(payload.model));
          assert.ok(payload.items.some((item) => item.id === body.id));
        }
        if (capabilities.storage === "sqlite")
          assert.ok(savedIds(dataDir).includes(body.id));
        const revived = await listen(0, "127.0.0.1", dataDir);
        try {
          if (list) {
            const kept = await (
              await call(
                "http://127.0.0.1:" + revived.address().port,
                list,
                null,
                null,
                headers,
              )
            ).json();
            assert.ok(kept.items.some((item) => item.id === body.id));
          }
        } finally {
          await new Promise((resolveClose) => revived.close(resolveClose));
        }
        const read = owned.find((item) => item.action === "read");
        if (read) {
          const opened = await call(base, read, null, body.id, headers);
          assert.equal(opened.status, read.success_status);
          assert.equal((await opened.json()).id, body.id);
          const missing = await call(base, read, null, "missing-id", headers);
          assert.equal(missing.status, 404);
        }
        if (create.rules.includes("unique")) {
          const again = await call(base, create, "sample", null, headers, overrides);
          assert.equal(again.status, 400);
          assert.equal((await again.json()).rule, "unique");
        }
        if (create.rules.includes("required") && create.parameters.length) {
          const bare = await call(base, create, null, null, headers);
          assert.equal(bare.status, 400);
          assert.equal((await bare.json()).rule, "required");
        }
        if (create.rules.includes("max-length") && create.parameters.length) {
          const tooLong = await call(
            base,
            create,
            "x".repeat(81),
            null,
            headers,
            overrides,
          );
          assert.equal(tooLong.status, 400);
          assert.equal((await tooLong.json()).rule, "max-length");
        }
        if (update) {
          const next = await call(base, update, "edited", body.id, headers, overrides);
          assert.equal(next.status, update.success_status);
          const updated = await next.json();
          assert.equal(updated.id, body.id);
          for (const name of update.parameters) {
            if (name === "id") continue;
            assert.deepEqual(
              updated[name],
              expectedValue(update, name, overrides, "edited"),
            );
          }
        }
        if (merge) {
          const next = await call(base, merge, "merged", body.id, headers, overrides);
          assert.equal(next.status, merge.success_status);
          const updated = await next.json();
          assert.equal(updated.id, body.id);
        }
        if (remove) {
          const gone = await call(base, remove, null, body.id, headers);
          assert.equal(gone.status, remove.success_status);
          assert.equal((await gone.json()).deleted, true);
          if (list) {
            const after = await (await call(base, list, null, null, headers)).json();
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

function recordKey(route, created) {
  if (!created) return null;
  if (
    route.path_param &&
    route.path_param !== "id" &&
    created[route.path_param] != null &&
    String(created[route.path_param]) !== ""
  )
    return String(created[route.path_param]);
  return created.id;
}

for (const route of routes) {
  if (!route.declared) continue;
  test("endpoint " + route.method + " " + route.path, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ree-endpoint-"));
    const server = await listen(0, "127.0.0.1", dataDir);
    try {
      const base = "http://127.0.0.1:" + server.address().port;
      const headers = await authHeaders(base);
      const create = routes.find(
        (item) => item.resource === route.resource && item.action === "create",
      );
      let created = null;
      if (create && route.action !== "create") {
        const overrides = await parentOverrides(base, create, headers);
        const response = await call(base, create, "sample", null, headers, overrides);
        assert.equal(response.status, create.success_status, route.path);
        created = await response.json();
      }
      if (route.action === "create") {
        const overrides = await parentOverrides(base, route, headers);
        const response = await call(base, route, "sample", null, headers, overrides);
        assert.equal(response.status, route.success_status, route.path);
        const body = await response.json();
        assert.equal(typeof body.id, "string");
        for (const name of route.parameters) {
          if (name === "id") continue;
          assert.deepEqual(body[name], expectedValue(route, name, overrides, "sample"));
        }
        if ((route.fields || []).some((field) => field.required)) {
          const bare = await fetch(base + route.path, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: "{}",
          });
          assert.equal(bare.status, 400);
          assert.equal((await bare.json()).rule, "required");
        }
        const stringField = (route.fields || []).find(
          (field) => field.type === "string" && field.name !== "id",
        );
        if (stringField && route.body === "json") {
          const invalid = await call(base, route, "sample", null, headers, {
            ...overrides,
            [stringField.name]: 1,
          });
          assert.equal(invalid.status, 400);
          assert.equal((await invalid.json()).rule, "type");
        }
        return;
      }
      if (route.action === "list") {
        const listed = await call(base, route, null, null, headers);
        assert.equal(listed.status, route.success_status, route.path);
        return;
      }
      const key = recordKey(route, created);
      if (route.action === "read") {
        const opened = await call(base, route, null, key, headers);
        assert.equal(opened.status, route.success_status, route.path);
        assert.equal((await opened.json()).id, created.id);
        return;
      }
      if (route.action === "replace" || route.action === "merge") {
        const field = (route.fields || []).find(
          (item) => item.type === "string" && item.name !== "id",
        );
        const overrides = {};
        if (field)
          overrides[field.name] =
            Array.isArray(field.enum) && field.enum.length > 1
              ? field.enum[1]
              : "edited-value";
        const next = await call(base, route, "edited", key, headers, overrides);
        assert.equal(next.status, route.success_status, route.path);
        if (field) assert.equal((await next.json())[field.name], overrides[field.name]);
        return;
      }
      if (route.action === "remove") {
        const gone = await call(base, route, null, key, headers);
        assert.equal(gone.status, route.success_status, route.path);
        assert.equal((await gone.json()).deleted, true);
      }
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
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

test("capabilities behave only when the spec supports them", async () => {
  const report = JSON.parse(
    readFileSync(new URL("../capabilities.json", import.meta.url), "utf8"),
  );
  assert.match(report.note, /not a percentage/);
  const byId = Object.fromEntries(
    report.capabilities.map((item) => [item.id, item]),
  );
  assert.equal(
    byId.storage.status,
    capabilities.storage === "sqlite" ? "implemented" : "left-out",
  );
  assert.equal(byId.auth.status, capabilities.auth ? "implemented" : "left-out");
  assert.equal(byId.roles.status, capabilities.roles ? "implemented" : "left-out");
  assert.equal(
    byId.relations.status,
    (capabilities.relations ?? []).length ? "implemented" : "left-out",
  );
  assert.equal(byId.search.status, capabilities.search ? "implemented" : "left-out");
  assert.equal(
    byId.webhooks.status,
    capabilities.webhooks ? "implemented" : "left-out",
  );
  assert.equal(
    byId.pricing.status,
    capabilities.pricing ? "implemented" : "left-out",
  );
  assert.equal(byId.openapi.status, capabilities.openapi ? "implemented" : "left-out");
  assert.equal(byId.deploy.status, capabilities.deploy ? "implemented" : "left-out");
  if (capabilities.openapi)
    assert.equal(existsSync(new URL("../openapi.json", import.meta.url)), true);
  if (capabilities.deploy) {
    const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const render = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");
    assert.match(docker, /0\\.0\\.0\\.0/);
    assert.equal(docker.includes("sk_live_"), false);
    assert.equal(render.includes("sk_live_"), false);
    assert.equal(render.includes("sk_test_"), false);
  }
  const dataDir = mkdtempSync(join(tmpdir(), "ree-cap-"));
  const server = await listen(0, "127.0.0.1", dataDir);
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const pricing = await fetch(base + "/pricing");
    assert.equal(pricing.status, capabilities.pricing ? 200 : 404);
    if (capabilities.pricing) {
      assert.match(await pricing.text(), /data-pricing="1"/);
      const plain = await fetch(base + "/checkout", { method: "POST" });
      const open = await plain.json();
      assert.equal(open.configured, false);
      assert.match(open.note, /test key/);
      const previous = process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_SECRET_KEY = "sk_live_refused";
      try {
        const live = await fetch(base + "/checkout", { method: "POST" });
        const liveBody = await live.json();
        assert.equal(live.status, 400);
        assert.equal(liveBody.error, "live-key");
        assert.equal(JSON.stringify(liveBody).includes("sk_live_refused"), false);
      } finally {
        if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = previous;
      }
    }
    const hook = await fetch(base + "/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json", ...(capabilities.auth ? await authHeaders(base) : {}) },
      body: JSON.stringify({ name: "ping" }),
    });
    if (!capabilities.webhooks) assert.equal(hook.status, 404);
    else {
      assert.equal(hook.status, 201);
      const stored = await hook.json();
      assert.equal(stored.delivered, false);
      assert.match(stored.note, /not sent/);
    }
    if (capabilities.auth && capabilities.auth.mode === "password") {
      const headers = await authHeaders(base);
      const other = await fetch(base + "/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "other@example.com",
          password: "long-secret",
        }),
      });
      assert.equal(other.status, 201);
      const otherBody = await other.json();
      assert.equal(otherBody.password_hash, undefined);
      if (capabilities.roles) assert.equal(otherBody.role, "member");
      const otherLogin = await fetch(base + "/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "other@example.com",
          password: "long-secret",
        }),
      });
      const otherToken = (await otherLogin.json()).token;
      const create = routes.find((item) => item.action === "create");
      if (create) {
        const overrides = await parentOverrides(base, create, headers);
        const made = await call(base, create, "owned", null, headers, overrides);
        assert.equal(made.status, create.success_status);
        const owned = await made.json();
        const id = owned.id;
        assert.equal(typeof owned.owner, "string");
        assert.equal(owned.password_hash, undefined);
        const hidden = await call(
          base,
          routes.find((item) => item.action === "read" && item.resource === create.resource) ??
            create,
          null,
          id,
          { authorization: "Bearer " + otherToken },
        );
        if (capabilities.roles) assert.equal(hidden.status, 404);
      }
    }
    if (capabilities.relations.length) {
      const headers = await authHeaders(base);
      const child = routes.find(
        (item) =>
          item.action === "create" &&
          item.parameters.includes(capabilities.relations[0].field),
      );
      if (child) {
        const missing = await call(base, child, "missing", null, headers, {
          [capabilities.relations[0].field]: "missing-id",
        });
        assert.equal(missing.status, 400);
        assert.equal((await missing.json()).error, "relation");
      }
    }
    if (capabilities.search) {
      const headers = await authHeaders(base);
      const create = routes.find(
        (item) => item.action === "create" && item.parameters.length > 0,
      );
      const list = create
        ? routes.find(
            (item) => item.action === "list" && item.resource === create.resource,
          )
        : null;
      if (create && list) {
        const overrides = await parentOverrides(base, create, headers);
        await call(base, create, "alpha", null, headers, overrides);
        await call(base, create, "beta", null, headers, overrides);
        const all = await call(base, list, null, null, headers);
        assert.ok((await all.json()).items.length >= 2);
        const filtered = await fetch(
          base + list.path + "?q=alpha",
          { headers },
        );
        const found = await filtered.json();
        assert.ok(found.items.some((item) => Object.values(item).includes("alpha")));
        assert.equal(
          found.items.some((item) => Object.values(item).includes("beta")),
          false,
        );
        const field = create.parameters.find(
          (name) =>
            !(capabilities.relations ?? []).some(
              (relation) => relation.field === name,
            ),
        );
        if (field) {
          const byField = await fetch(
            base + list.path + "?" + encodeURIComponent(field) + "=alpha",
            { headers },
          );
          const fieldBody = await byField.json();
          assert.ok(fieldBody.items.some((item) => item[field] === "alpha"));
          assert.equal(
            fieldBody.items.some((item) => item[field] === "beta"),
            false,
          );
        }
        const paged = await fetch(base + list.path + "?limit=1&offset=0", {
          headers,
        });
        assert.equal((await paged.json()).items.length, 1);
      }
    }
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  if (capabilities.storage === "sqlite") {
    const broken = mkdtempSync(join(tmpdir(), "ree-broken-"));
    mkdirSync(join(broken, "data"), { recursive: true });
    writeFileSync(join(broken, "data", "store.sqlite"), "not a database");
    await assert.rejects(async () => listen(0, "127.0.0.1", broken));
  }
});
`;
