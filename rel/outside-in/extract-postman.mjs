const METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/** Postman Collection v2 JSON. Auth secrets and header values are not kept. */
export function extractPostman(text) {
  let document;
  try {
    document = JSON.parse(String(text));
  } catch {
    return { error: "Postman collection could not be parsed." };
  }
  if (
    !document ||
    typeof document !== "object" ||
    !Array.isArray(document.item)
  )
    return { error: "Document is not a Postman collection." };
  const endpoints = [];
  walk(document.item, endpoints);
  if (endpoints.length === 0)
    return { error: "Postman collection has no HTTP requests." };
  return {
    style: "postman",
    servers: [],
    auth: authFrom(document.auth),
    rateLimits: [],
    endpoints,
  };
}

function walk(items, endpoints) {
  for (const item of items ?? []) {
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item.item)) walk(item.item, endpoints);
    if (!item.request) continue;
    const request = item.request;
    const method = String(
      typeof request === "string" ? "GET" : (request.method ?? "GET"),
    ).toUpperCase();
    if (!METHODS.has(method)) continue;
    const path = requestPath(request);
    if (!path) continue;
    const parameters = queryNames(request);
    const body =
      request.body?.mode === "raw" &&
      String(request.body?.options?.raw?.language ?? "")
        .toLowerCase()
        .includes("json")
        ? "json"
        : null;
    endpoints.push({
      method,
      path,
      operationId: operationId(item.name),
      summary: null,
      parameters,
      responseCodes: [],
      body,
      rateLimits: [],
      unresolvedParameters: 0,
    });
  }
}

function authFrom(auth) {
  const type = typeof auth?.type === "string" ? auth.type : "";
  if (!type || type === "noauth") return [];
  return [{ name: type, style: type, placement: "header" }];
}

function requestPath(request) {
  if (typeof request === "string") return normalizePath(request);
  const url = request?.url;
  if (typeof url === "string") return normalizePath(url);
  if (url && Array.isArray(url.path)) {
    const parts = url.path
      .map((part) => (typeof part === "string" ? part : ""))
      .filter(Boolean);
    if (parts.some((part) => part.includes("{{"))) return null;
    return "/" + parts.map(encodePath).join("/");
  }
  if (typeof url?.raw === "string") return normalizePath(url.raw);
  return null;
}

function normalizePath(value) {
  const text = String(value).trim();
  if (!text || text.includes("{{")) return null;
  try {
    const parsed = new URL(text, "https://collection.local");
    return parsed.pathname || "/";
  } catch {
    return text.startsWith("/") ? text.split("?")[0] : null;
  }
}

function encodePath(part) {
  try {
    return encodeURIComponent(decodeURIComponent(part));
  } catch {
    return encodeURIComponent(part);
  }
}

function queryNames(request) {
  const query = request?.url?.query;
  if (!Array.isArray(query)) return [];
  const names = [];
  for (const item of query) {
    if (typeof item?.key !== "string" || !item.key) continue;
    if (!names.includes(item.key)) names.push(item.key);
  }
  return names;
}

function operationId(name) {
  if (typeof name !== "string") return null;
  const cleaned = name.trim().replace(/[^A-Za-z0-9_]+/g, "");
  return cleaned ? cleaned.slice(0, 64) : null;
}
