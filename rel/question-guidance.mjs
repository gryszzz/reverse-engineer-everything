const QUESTION_STOP_WORDS = new Set([
  "a",
  "about",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "might",
  "must",
  "of",
  "on",
  "or",
  "our",
  "owned",
  "present",
  "relationship",
  "relationships",
  "route",
  "newcomer",
  "should",
  "source",
  "source-owned",
  "static",
  "that",
  "the",
  "their",
  "them",
  "these",
  "they",
  "this",
  "those",
  "to",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "demo",
  "explain",
  "you",
  "your",
]);

const MAX_QUESTION_SEARCH_TERMS = 5;

/** Return a small, deterministic set of literal graph-search terms from a question. */
export function questionSearchTerms(question) {
  if (typeof question !== "string" || question.trim() === "") return [];
  const terms = [];
  const seen = new Set();
  for (const match of question
    .normalize("NFKC")
    .matchAll(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu)) {
    const term = match[0].toLowerCase();
    if (
      term.length < 2 ||
      term.length > 160 ||
      QUESTION_STOP_WORDS.has(term) ||
      seen.has(term)
    )
      continue;
    seen.add(term);
    terms.push(term);
    if (terms.length === MAX_QUESTION_SEARCH_TERMS) break;
  }
  return terms;
}

/** Render exact Evidence Explorer commands; terms are restricted to shell-safe tokens above. */
export function questionEvidenceSearchGuide(
  question,
  { disableExplorerCommand = false } = {},
) {
  const terms = questionSearchTerms(question);
  const commands = terms.length
    ? terms.map(
        (term) =>
          `node rel/evidence-explorer.mjs "$OUT/evidence.json" --find '${term}' --limit 20`,
      )
    : ['node rel/evidence-explorer.mjs "$OUT/evidence.json" --limit 12'];
  return {
    terms,
    markdown: [
      "## Follow the question into saved Evidence",
      "",
      "These are literal, case-insensitive searches of recorded JavaScript graph relationships. They are navigation hints, not an automatic interpretation of the question.",
      ...(terms.length
        ? [
            "",
            "Suggested terms: " + terms.map((term) => `\`${term}\``).join(", "),
          ]
        : ["", "No distinct search terms were derived from the question."]),
      "",
      "From the REE checkout root, run:",
      "",
      "```sh",
      ...(disableExplorerCommand
        ? [
            "# Use REA's bounded analysis views; this saved Evidence file exceeds the local explorer limit.",
          ]
        : commands),
      "```",
      "",
      "A matching relationship is a lead to inspect with its saved source location and Evidence. No match means no recorded relationship matched that text; it does not show that the feature or behavior is absent. If results are truncated, narrow the term or raise the limit to at most 40. The explorer accepts Evidence files up to 64 MiB.",
      "",
      "## Verification boundary",
      "",
      "The static-analysis step did not launch the target, capture runtime events, test behavior, or verify a reconstruction claim.",
      "",
      "## Next actions",
      "",
      "- Inspect matching relationship locations in the target source and record which ones support your question.",
      "- If the question depends on runtime behavior, choose a separate REA observation route, confirm its prerequisites and authorization, and define a bounded scenario before capture.",
      "- Keep unmatched terms and the report's coverage, limitations, and unknowns visible; a static graph is not proof of execution.",
      "",
    ].join("\n"),
  };
}
