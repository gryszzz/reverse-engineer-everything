export function extractGraphql(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return fromIntrospection(JSON.parse(trimmed));
    } catch {
      return { error: "GraphQL introspection JSON could not be parsed." };
    }
  }
  return fromSdl(trimmed);
}

function fromSdl(sdl) {
  const cleaned = sdl.replace(/"""[\s\S]*?"""/g, "").replace(/#[^\n]*/g, "");
  const endpoints = [];
  const blocks = /type\s+(Query|Mutation)\s*\{([\s\S]*?)\}/g;
  for (const match of cleaned.matchAll(blocks)) {
    const kind = match[1].toLowerCase();
    const fields = /([_A-Za-z][_0-9A-Za-z]*)\s*(\(([^)]*)\))?\s*:/g;
    for (const field of match[2].matchAll(fields)) {
      endpoints.push({
        method: kind === "query" ? "QUERY" : "MUTATION",
        path: `${kind}.${field[1]}`,
        operationId: field[1],
        summary: null,
        parameters: argumentNames(field[3] ?? ""),
        responseCodes: [],
        security: [],
        rateLimits: [],
        unresolvedParameters: 0,
      });
    }
  }
  if (endpoints.length === 0) return { error: "No GraphQL Query or Mutation fields were found." };
  return { style: "graphql", servers: [], auth: [], rateLimits: [], endpoints };
}

function fromIntrospection(data) {
  const schema = data?.__schema ?? data?.data?.__schema;
  if (!schema) return { error: "GraphQL introspection JSON has no __schema." };
  const types = new Map((schema.types ?? []).map((type) => [type.name, type]));
  const endpoints = [
    ...fieldsOf(types.get(schema.queryType?.name), "QUERY"),
    ...fieldsOf(types.get(schema.mutationType?.name), "MUTATION"),
  ];
  if (endpoints.length === 0) return { error: "GraphQL introspection listed no operations." };
  return { style: "graphql", servers: [], auth: [], rateLimits: [], endpoints };
}

function fieldsOf(type, method) {
  if (!type?.fields) return [];
  const prefix = method === "QUERY" ? "query" : "mutation";
  return type.fields.map((field) => ({
    method,
    path: `${prefix}.${field.name}`,
    operationId: field.name,
    summary: null,
    parameters: (field.args ?? []).map((arg) => arg.name).filter(Boolean),
    responseCodes: [],
    security: [],
    rateLimits: [],
    unresolvedParameters: 0,
  }));
}

function argumentNames(list) {
  return [...list.matchAll(/([_A-Za-z][_0-9A-Za-z]*)\s*:/g)].map((match) => match[1]);
}
