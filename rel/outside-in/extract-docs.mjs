import { extractFeed } from "./extract-feed.mjs";
import { extractGraphql } from "./extract-graphql.mjs";
import { extractMarkdown } from "./extract-markdown.mjs";
import { extractOpenApi } from "./extract-openapi.mjs";
import { extractPostman } from "./extract-postman.mjs";
import { mediaType } from "./text.mjs";

export function sniffFormat(doc, kind) {
  if (kind === "openapi") return "openapi";
  if (kind === "graphql")
    return looksLikeJson(doc.body) ? "graphql-json" : "graphql-sdl";
  if (kind === "sdk-readme") return "markdown";
  if (kind === "feed") return "feed";
  const type = doc.contentType || mediaType(doc.headers ?? {});
  const url = doc.url.toLowerCase();
  const body = doc.body.trim();
  if (type.includes("html") || url.endsWith(".html") || url.endsWith(".htm"))
    return "html";
  if (
    type.includes("markdown") ||
    url.endsWith(".md") ||
    url.endsWith(".markdown")
  )
    return "markdown";
  if (url.endsWith(".graphql") || url.endsWith(".gql")) return "graphql-sdl";
  if (url.endsWith(".postman_collection.json")) return "postman";
  if (type.includes("yaml") || url.endsWith(".yaml") || url.endsWith(".yml"))
    return sniffYaml(body);
  if (
    type.includes("json") ||
    url.endsWith(".json") ||
    body.startsWith("{") ||
    body.startsWith("[")
  )
    return sniffJson(body);
  if (/<(rss|feed)\b/i.test(body)) return "feed";
  if (/^type\s+(Query|Mutation)\b/m.test(body) || /^schema\s*\{/m.test(body))
    return "graphql-sdl";
  return "text";
}

function looksLikePostman(data) {
  const schema = data?.info?.schema;
  if (typeof schema === "string" && schema.includes("getpostman.com"))
    return true;
  return Array.isArray(data?.item) && data.item.some((item) => item?.request);
}

function looksLikeJson(body) {
  const trimmed = body.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function sniffYaml(body) {
  const parsed = extractOpenApi(body);
  return parsed.error ? "yaml" : "openapi";
}

function sniffJson(body) {
  try {
    const data = JSON.parse(body);
    if (data?.openapi || data?.swagger) return "openapi";
    if (data?.__schema || data?.data?.__schema) return "graphql-json";
    if (looksLikePostman(data)) return "postman";
  } catch {
    return "json";
  }
  return "json";
}

export function extractByFormat(doc, format, quoteMax) {
  if (format === "openapi") return { api: extractOpenApi(doc.body) };
  if (format === "postman") return { api: extractPostman(doc.body) };
  if (format === "graphql-sdl" || format === "graphql-json")
    return { api: extractGraphql(doc.body) };
  if (format === "markdown")
    return { markdown: extractMarkdown(doc.body, quoteMax, doc.kind) };
  if (format === "feed") return { feed: extractFeed(doc.body, quoteMax) };
  return { unknownFormat: format };
}
