import { parse as parseYaml } from "yaml";
import { shortQuote } from "./text.mjs";

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

export function extractOpenApi(text) {
  let document;
  try {
    document = parseYaml(String(text));
  } catch {
    return { error: "OpenAPI document could not be parsed." };
  }
  if (
    !document ||
    typeof document !== "object" ||
    (!document.openapi && !document.swagger)
  ) {
    return { error: "Document is not an OpenAPI or Swagger description." };
  }
  return {
    style: "openapi",
    servers: serversFrom(document),
    auth: authFrom(document),
    rateLimits: rateLimitsFrom(document, "document"),
    endpoints: endpointsFrom(document),
  };
}

function serversFrom(document) {
  const servers = Array.isArray(document.servers) ? document.servers : [];
  return servers
    .map((server) => (typeof server?.url === "string" ? server.url : ""))
    .filter((url) => url && url.length <= 200);
}

function authFrom(document) {
  const schemes =
    document.components?.securitySchemes ?? document.securityDefinitions ?? {};
  if (!schemes || typeof schemes !== "object") return [];
  return Object.entries(schemes).map(([name, scheme]) => ({
    name,
    style: authStyle(scheme ?? {}),
    placement: scheme?.in ?? (scheme?.type === "http" ? "header" : null),
  }));
}

function authStyle(scheme) {
  if (scheme.type === "http") return scheme.scheme ?? "http";
  if (scheme.type === "apiKey") return `apiKey:${scheme.in ?? "unknown"}`;
  if (scheme.type === "oauth2") return "oauth2";
  if (scheme.type === "openIdConnect") return "openIdConnect";
  return scheme.type ?? "unknown";
}

function endpointsFrom(document) {
  const paths = document.paths ?? {};
  const endpoints = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation || typeof operation !== "object") continue;
      endpoints.push(endpointFrom(method, path, operation));
    }
  }
  return endpoints;
}

function endpointFrom(method, path, operation) {
  const summary = shortQuote(operation.summary ?? "");
  const parameters = [];
  let unresolved = 0;
  for (const parameter of operation.parameters ?? []) {
    if (typeof parameter?.name === "string") {
      if (!parameters.includes(parameter.name)) parameters.push(parameter.name);
    } else unresolved += 1;
  }
  const body = jsonBody(operation);
  for (const name of body.names) {
    if (!parameters.includes(name)) parameters.push(name);
  }
  return {
    method: method.toUpperCase(),
    path,
    operationId:
      typeof operation.operationId === "string" ? operation.operationId : null,
    summary,
    parameters,
    body: body.body,
    responseCodes: Object.keys(operation.responses ?? {}),
    security: securityNames(operation.security),
    rateLimits: rateLimitsFrom(operation, `${method.toUpperCase()} ${path}`),
    unresolvedParameters: unresolved,
    unresolvedBody: body.unresolved,
  };
}

function jsonBody(operation) {
  const requestBody = operation.requestBody;
  if (requestBody == null) return { names: [], body: null, unresolved: 0 };
  if (typeof requestBody !== "object" || requestBody.$ref)
    return { names: [], body: null, unresolved: 1 };
  const content = requestBody.content;
  if (!content || typeof content !== "object")
    return { names: [], body: null, unresolved: 1 };
  const json = content["application/json"];
  if (!json || typeof json !== "object" || json.schema?.$ref)
    return { names: [], body: null, unresolved: 1 };
  const properties = json.schema?.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return { names: [], body: null, unresolved: 1 };
  const names = [];
  for (const name of Object.keys(properties)) {
    if (name.length > 0 && name.length <= 80 && !names.includes(name))
      names.push(name);
  }
  if (names.length === 0) return { names: [], body: null, unresolved: 1 };
  return { names, body: "json", unresolved: 0 };
}

function securityNames(security) {
  if (!Array.isArray(security)) return [];
  return security.flatMap((item) =>
    item && typeof item === "object" ? Object.keys(item) : [],
  );
}

function rateLimitsFrom(node, scope) {
  const raw = node?.["x-rate-limit"] ?? node?.["x-ratelimit"];
  const parsed = parseRateLimit(raw);
  if (!parsed) return [];
  return [{ ...parsed, scope }];
}

function parseRateLimit(raw) {
  if (typeof raw === "string") {
    const match = /(\d+)\s*(?:\/|per)\s*([A-Za-z]+)/.exec(raw);
    if (!match || raw.length > 80) return null;
    return { limit: match[1], window: match[2].toLowerCase() };
  }
  if (!raw || typeof raw !== "object") return null;
  const limit = raw.limit ?? raw.requests ?? raw.max;
  if (limit == null) return null;
  const window = raw.window ?? raw.period ?? raw.interval ?? null;
  return {
    limit: String(limit).slice(0, 40),
    window: window == null ? null : String(window).slice(0, 40),
  };
}
