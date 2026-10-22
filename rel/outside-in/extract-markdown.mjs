import { shortQuote } from "./text.mjs";

export function extractMarkdown(text, quoteMax) {
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
    if (!shortQuote(name, quoteMax)) continue;
    features.push({
      name,
      quote: null,
      detail:
        "SDK README heading. Fenced code samples on this page were omitted.",
      origin: "sdk-readme",
    });
  }
  return { features, codeBlockCount };
}
