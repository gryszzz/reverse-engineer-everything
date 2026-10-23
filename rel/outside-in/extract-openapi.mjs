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
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation || typeof operation !== "object") continue;
      const parameters = shared.concat(
        Array.isArray(operation.parameters) ? operation.parameters : [],
      );
      endpoints.push(
        endpointFrom(method, path, operation, parameters, document),
      );
    }
  }
  return endpoints;
}

function endpointFrom(method, path, operation, declared, document) {
  const summary = shortQuote(operation.summary ?? "");
  const parameters = [];
  let unresolved = 0;
  for (const parameter of declared) {
    if (parameter?.in === "header" || parameter?.in === "body") continue;
    if (typeof parameter?.name === "string") {
      if (
        parameter.name.length > 0 &&
        parameter.name.length <= 80 &&
        !parameters.includes(parameter.name)
      )
        parameters.push(parameter.name);
    } else unresolved += 1;
  }
  const body = jsonBody(operation, declared, document);
  for (const name of body.names) {
    if (!parameters.includes(name)) parameters.push(name);
  }
  markRequiredParameters(declared, body.fields);
  for (const field of body.fields) {
    if (!parameters.includes(field.name)) parameters.push(field.name);
  }
  return {
    method: method.toUpperCase(),
    path,
    operationId:
      typeof operation.operationId === "string" ? operation.operationId : null,
    summary,
    parameters,
    fields: body.fields,
    body: body.body,
    responseCodes: Object.keys(operation.responses ?? {}),
    security: securityNames(operation.security),
    rateLimits: rateLimitsFrom(operation, `${method.toUpperCase()} ${path}`),
    unresolvedParameters: unresolved,
    unresolvedBody: body.unresolved,
  };
}

function markRequiredParameters(declared, fields) {
  for (const parameter of declared) {
    if (!parameter || parameter.required !== true) continue;
    const place = parameter.in;
    if (place === "path" || place === "header" || place === "body") continue;
    const name = parameter.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 80)
      continue;
    const found = fields.find((field) => field.name === name);
    if (found) found.required = true;
    else
      fields.push({ name, required: true, type: schemaType(parameter.schema) });
  }
}

function jsonBody(operation, declared, document) {
  const requestBody = operation.requestBody;
  if (requestBody == null) {
    const swagger = declared.find((parameter) => parameter?.in === "body");
    if (!swagger) return { names: [], fields: [], body: null, unresolved: 0 };
    return fieldsFromSchema(swagger.schema, document);
  }
  if (typeof requestBody !== "object")
    return { names: [], fields: [], body: null, unresolved: 1 };
  const resolved = requestBody.$ref
    ? pointer(document, requestBody.$ref)
    : requestBody;
  if (!resolved || typeof resolved !== "object")
    return { names: [], fields: [], body: null, unresolved: 1 };
  const content = resolved.content;
  if (!content || typeof content !== "object")
    return { names: [], fields: [], body: null, unresolved: 1 };
  const json = content["application/json"];
  if (!json || typeof json !== "object")
    return { names: [], fields: [], body: null, unresolved: 1 };
  return fieldsFromSchema(json.schema, document);
}

function fieldsFromSchema(schema, document) {
  const resolved = resolveSchema(schema, document, new Set());
  if (!resolved) return { names: [], fields: [], body: null, unresolved: 1 };
  if (resolved.type === "array" || Array.isArray(resolved.items))
    return { names: [], fields: [], body: null, unresolved: 1 };
  const properties = resolved.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return { names: [], fields: [], body: null, unresolved: 1 };
  const required = new Set(
    Array.isArray(resolved.required) ? resolved.required : [],
  );
  const fields = [];
  for (const [name, property] of Object.entries(properties)) {
    if (
      name.length === 0 ||
      name.length > 80 ||
      fields.some((field) => field.name === name)
    )
      continue;
    const nested = resolveSchema(property, document, new Set());
    const field = {
      name,
      required: required.has(name),
      type: schemaType(nested ?? property),
    };
    const values = enumValues(nested ?? property);
    if (values) field.enum = values;
    fields.push(field);
  }
  if (fields.length === 0)
    return { names: [], fields: [], body: null, unresolved: 1 };
  return {
    names: fields.map((field) => field.name),
    fields,
    body: "json",
    unresolved: 0,
  };
}

function resolveSchema(schema, document, seen) {
  if (!schema || typeof schema !== "object") return null;
  if (typeof schema.$ref !== "string") return schema;
  if (seen.has(schema.$ref)) return null;
  seen.add(schema.$ref);
  const target = pointer(document, schema.$ref);
  if (!target) return null;
  return resolveSchema(target, document, seen);
}

function pointer(document, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  let node = document;
  for (const part of ref.slice(2).split("/")) {
    if (!node || typeof node !== "object") return null;
    node =
      node[decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"))];
  }
  return node && typeof node === "object" ? node : null;
}

function schemaType(schema) {
  if (!schema || typeof schema !== "object") return "string";
  if (
    schema.type === "integer" ||
    schema.format === "int32" ||
    schema.format === "int64"
  )
    return schema.type === "number" ? "number" : "integer";
  if (
    schema.type === "number" ||
    schema.type === "boolean" ||
    schema.type === "array" ||
    schema.type === "object" ||
    schema.type === "string"
  )
    return schema.type;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "string";
}

function enumValues(schema) {
  if (!Array.isArray(schema?.enum) || schema.enum.length === 0) return null;
  if (
    schema.enum.some((value) => typeof value !== "string" || value.length > 80)
  )
    return null;
  return schema.enum;
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
