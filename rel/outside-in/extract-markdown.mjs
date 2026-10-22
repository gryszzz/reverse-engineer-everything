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
    const after = stripped.slice(heading.index + heading[0].length);
    const nextHeading = after.search(/\n#{1,6}\s/u);
    const block = (
      nextHeading === -1 ? after : after.slice(0, nextHeading)
    ).trim();
    const paragraph = (block.split(/\n\s*\n/u)[0] ?? "").replace(/\n/g, " ");
    features.push({
      name,
      quote: shortQuote(paragraph, quoteMax),
      detail:
        codeBlockCount > 0
          ? "SDK README heading. Fenced code samples on this page were omitted."
          : "SDK README heading.",
      origin: "sdk-readme",
    });
  }
  return { features, codeBlockCount };
}
