import { metaDescription, pageOutline } from "./html-outline.mjs";
import { proseOmission, shortQuote } from "./text.mjs";

const CONTAINERS = new Set([
  "features",
  "feature",
  "capabilities",
  "pricing",
  "plans",
  "plan",
  "integrations",
  "integration",
  "limitations",
  "limitation",
  "known issues",
  "reviews",
  "review",
  "workflows",
  "workflow",
  "getting started",
  "get started",
  "how it works",
]);

export function extractHtml(html, quoteMax) {
  const outline = pageOutline(html);
  const features = [];
  const workflows = [];
  const integrations = [];
  const limitations = [];
  const plans = [];
  const reviews = [];
  const unknowns = [];
  const description = metaDescription(html);
  const descriptionQuote = shortQuote(description, quoteMax);
  if (descriptionQuote) {
    features.push({
      name: "Site description",
      quote: descriptionQuote,
      detail: "Taken from the meta description as a short attributed quote.",
      origin: "meta-description",
    });
  } else if (description) {
    unknowns.push(`Meta description was ${description.length} characters and was not copied.`);
  }

  for (const block of outline.blocks) {
    const kind = blockKind(block);
    if (kind === "pricing") {
      const plan = planFromBlock(block, quoteMax, unknowns);
      if (plan) plans.push(plan);
      continue;
    }
    if (kind === "workflow") {
      const workflow = workflowFromBlock(block, quoteMax, unknowns);
      if (workflow) workflows.push(workflow);
      continue;
    }
    if (kind === "integrations") {
      integrations.push(...integrationsFromBlock(block));
      continue;
    }
    if (kind === "limitations") {
      limitations.push(...statementsFromBlock(block, quoteMax, "stated-limitation", unknowns));
      continue;
    }
    if (kind === "reviews") {
      reviews.push(...statementsFromBlock(block, quoteMax, "stated-review", unknowns));
      continue;
    }
    if (block.level >= 2 && !isContainer(block.heading)) {
      const feature = featureFromBlock(block, quoteMax);
      if (feature) features.push(feature);
    }
  }
  return { features, workflows, integrations, limitations, plans, reviews, unknowns };
}

export function parsePrice(text) {
  const trimmed = text.trim();
  if (/^free$/i.test(trimmed)) {
    return { amount: "0", currency: "USD", interval: null, display: "Free" };
  }
  const match =
    /(USD|EUR|GBP|\$|€|£)\s*(\d+(?:[.,]\d{1,2})?)\s*(?:\/|\s+per\s+)?\s*(month|mo|year|yr|week|day)?/i.exec(
      trimmed,
    );
  if (!match) return null;
  const symbols = {
    $: "USD",
    "€": "EUR",
    "£": "GBP",
    usd: "USD",
    eur: "EUR",
    gbp: "GBP",
  };
  const intervals = {
    month: "month",
    mo: "month",
    year: "year",
    yr: "year",
    week: "week",
    day: "day",
  };
  return {
    amount: match[2].replace(",", ""),
    currency: symbols[match[1].toLowerCase()] ?? symbols[match[1]] ?? "USD",
    interval: intervals[(match[3] ?? "").toLowerCase()] ?? null,
    display: trimmed.slice(0, 40),
  };
}

function blockKind(block) {
  const blob = [block.heading, ...block.region.flatMap((region) => [region.id, region.className])]
    .join(" ")
    .toLowerCase();
  if (/\breviews?\b|\bcomplaints?\b|\bfeedback\b/.test(blob)) return "reviews";
  if (/limitation|known issues|caveats?/.test(blob)) return "limitations";
  if (/integrat|works with/.test(blob)) return "integrations";
  if (/workflow|getting started|get started|how it works|how to/.test(blob)) return "workflow";
  if (/\bpric|\bplans?\b|\btiers?\b|\bbilling\b/.test(blob)) return "pricing";
  if (/features?|capabilities/.test(blob)) return "features";
  return "general";
}

function isContainer(heading) {
  return CONTAINERS.has(heading.trim().toLowerCase());
}

function featureFromBlock(block, quoteMax) {
  if (!block.heading || block.heading.length > quoteMax) return null;
  const quote = shortQuote(block.paragraphs[0] ?? "", quoteMax);
  return {
    name: block.heading,
    quote,
    detail: proseOmission(block.paragraphs),
    origin: "public-page",
  };
}

function workflowFromBlock(block, quoteMax, unknowns) {
  if (isContainer(block.heading) && !block.lists.some((list) => list.ordered)) return null;
  const steps = [];
  for (const list of block.lists.filter((list) => list.ordered)) {
    for (const item of list.items) {
      const quote = shortQuote(item, quoteMax);
      if (quote) steps.push(quote);
      else unknowns.push(`A workflow step of ${item.length} characters was not copied.`);
    }
  }
  if (!block.heading || block.heading.length > quoteMax || steps.length === 0) return null;
  return { name: block.heading, steps };
}

function integrationsFromBlock(block) {
  const names = [];
  for (const list of block.lists) {
    for (const item of list.items) {
      const name = item.trim();
      if (name && name.length <= 80) names.push(name);
    }
  }
  if (!isContainer(block.heading) && block.heading && block.heading.length <= 80)
    names.unshift(block.heading);
  return names.map((name) => ({ name }));
}

function statementsFromBlock(block, quoteMax, origin, unknowns) {
  const statements = [];
  for (const list of block.lists) {
    for (const item of list.items) {
      const quote = shortQuote(item, quoteMax);
      if (quote) statements.push({ statement: quote, origin });
      else unknowns.push(`A ${origin} passage of ${item.length} characters was not copied.`);
    }
  }
  return statements;
}

function planFromBlock(block, quoteMax, unknowns) {
  if (isContainer(block.heading) && !findPrice(block) && block.lists.length === 0) return null;
  if (!block.heading || block.heading.length > quoteMax) return null;
  const price = findPrice(block);
  const limits = [];
  const includes = [];
  for (const list of block.lists) {
    for (const item of list.items) {
      const text = item.trim();
      if (!text || text.length > quoteMax || parsePrice(text)) continue;
      if (isLimit(text)) limits.push(text);
      else includes.push(text);
    }
  }
  if (!price && limits.length === 0 && includes.length === 0) {
    unknowns.push("A pricing block had no recognizable price or limits.");
  }
  return { name: block.heading, price, limits, includes };
}

function findPrice(block) {
  for (const paragraph of [block.heading, ...block.paragraphs]) {
    const price = parsePrice(paragraph);
    if (price) return price;
  }
  return null;
}

function isLimit(item) {
  return /\b(requests?|users?|seats?|projects?|storage|gb|mb|workspaces?|files?)\b|\/\s*(day|month|mo|min|hour)|per\s+(day|month|user|seat)/i.test(
    item,
  );
}
