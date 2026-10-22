import { shortQuote } from "./text.mjs";

export function extractFeed(text, quoteMax) {
  const source = String(text ?? "");
  if (/<feed[\s>]/i.test(source))
    return readEntries(source, "entry", "updated", quoteMax);
  if (/<rss[\s>]|<channel[\s>]/i.test(source))
    return readEntries(source, "item", "pubDate", quoteMax);
  return { error: "Changelog was not an RSS or Atom feed.", changes: [] };
}

function readEntries(source, tag, dateTag, quoteMax) {
  const changes = [];
  const unknowns = [];
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  for (const match of source.matchAll(pattern)) {
    const block = match[1];
    const title = textOf(block, "title");
    const quote = shortQuote(title, quoteMax);
    if (!quote) {
      unknowns.push(
        `A changelog title of ${title.length} characters was not copied.`,
      );
      continue;
    }
    const rawDate = textOf(block, dateTag);
    const parsed = Date.parse(rawDate);
    changes.push({
      title: quote,
      published_at: Number.isFinite(parsed)
        ? new Date(parsed).toISOString()
        : null,
    });
    if (rawDate && !Number.isFinite(parsed)) {
      unknowns.push("A changelog date could not be parsed.");
    }
  }
  return { changes, unknowns };
}

function textOf(block, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(
    block,
  );
  if (!match) return "";
  return match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}
