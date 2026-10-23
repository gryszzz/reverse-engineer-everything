import { shortQuote } from "./text.mjs";

const NON_FEATURES = new Set([
  "in their words",
  "frequently asked questions",
  "faq",
  "testimonials",
  "customers",
  "customer stories",
  "quotes",
  "about",
  "about us",
  "footer",
  "navigation",
  "nav",
]);

export function isMarketingHeading(name) {
  const text = String(name ?? "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  if (NON_FEATURES.has(text)) return true;
  return /frequently asked|in their words|testimonial|customer stor/.test(text);
}

export function extractMarkdown(text, quoteMax, sourceKind = null) {
  const source = String(text ?? "");
  let codeBlockCount = 0;
  const stripped = source.replace(/```[\s\S]*?```/g, () => {
    codeBlockCount += 1;
    return "\n";
  });
  const features = [];
  const headings = [...stripped.matchAll(/^(#{2,3})\s+(.+)$/gm)];
  for (const heading of headings) {
    const name = heading[2].trim();
    if (!shortQuote(name, quoteMax) || isMarketingHeading(name)) continue;
    const after = stripped.slice(heading.index + heading[0].length);
    const nextHeading = after.search(/\n#{1,6}\s/u);
    const block = (
      nextHeading === -1 ? after : after.slice(0, nextHeading)
    ).trim();
    const paragraph = (block.split(/\n\s*\n/u)[0] ?? "").replace(/\n/g, " ");
    const sdk = sourceKind === "sdk-readme";
    const label = sdk ? "SDK README heading" : "Docs heading";
    features.push({
      name,
      quote: shortQuote(paragraph, quoteMax),
      detail:
        codeBlockCount > 0
          ? `${label}. Fenced code samples on this page were omitted.`
          : `${label}.`,
      origin: sdk ? "sdk-readme" : "docs",
    });
  }
  return { features, codeBlockCount };
}
