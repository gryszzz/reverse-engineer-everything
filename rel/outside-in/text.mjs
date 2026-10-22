import { QUOTE_MAX } from "./constants.mjs";

export function normalizeSpace(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function shortQuote(text, quoteMax = QUOTE_MAX) {
  const normalized = normalizeSpace(text);
  if (!normalized || normalized.length > quoteMax) return null;
  return { text: normalized, attributed_quote: true };
}

export function proseOmission(paragraphs) {
  const chars = paragraphs
    .map((paragraph) => normalizeSpace(paragraph))
    .filter(Boolean)
    .join(" ").length;
  if (!chars) return "No supporting prose was recorded.";
  return `Supporting prose was left in the source (${chars} characters) and was not copied.`;
}

export function slug(text) {
  const base = normalizeSpace(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return (base || "item").slice(0, 48);
}

export function clipDetail(text, max = 300) {
  const normalized = normalizeSpace(text);
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max - 3) + "...";
}

export function lowerHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

export function mediaType(headers) {
  return (headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[body.toLowerCase()] ?? all;
  });
}
