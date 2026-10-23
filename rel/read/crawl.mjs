import { extensionBlocked } from "../outside-in/policy.mjs";

const HINT =
  /(docs|documentation|pricing|features|feature|changelog|developers|\bapi\b)/i;
const MAX_LINKS = 6;

/**
 * One hop from a public page. Same origin, robots still apply later.
 * Docs, pricing, feature, changelog, and API links only.
 */
export function selectCrawlLinks(html, pageUrl, limit = MAX_LINKS) {
  const page = new URL(pageUrl);
  const selected = [];
  const skipped = [];
  const seen = new Set([page.href]);
  for (const link of anchors(html)) {
    let target;
    try {
      target = new URL(link.href, page);
    } catch {
      skipped.push({
        target: link.href,
        reason: "The link could not be parsed.",
      });
      continue;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      skipped.push({
        target: link.href,
        reason: "Only http and https links are followed.",
      });
      continue;
    }
    target.hash = "";
    if (target.username || target.password) {
      skipped.push({
        target: target.origin + target.pathname,
        reason: "A link with a username or password was skipped.",
      });
      continue;
    }
    if (target.origin !== page.origin) {
      skipped.push({
        target: target.href,
        reason: "A different origin is not crawled.",
      });
      continue;
    }
    if (extensionBlocked(target.pathname)) {
      skipped.push({
        target: target.href,
        reason: "Source and binary links are not fetched.",
      });
      continue;
    }
    const hint = `${target.pathname} ${link.text}`;
    if (!HINT.test(hint)) {
      skipped.push({
        target: target.href,
        reason:
          "The link is not a docs, pricing, feature, changelog, or API page.",
      });
      continue;
    }
    if (seen.has(target.href)) continue;
    seen.add(target.href);
    if (selected.length >= limit) {
      skipped.push({
        target: target.href,
        reason: `Past the ${limit} page crawl limit.`,
      });
      continue;
    }
    selected.push({ url: target.href, role: roleFor(hint) });
  }
  return { selected, skipped };
}

function roleFor(hint) {
  if (/pricing/i.test(hint)) return "pricing";
  if (/changelog/i.test(hint)) return "changelog";
  return "docs";
}

function anchors(html) {
  const found = [];
  const tags = String(html ?? "").matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/giu);
  for (const tag of tags) {
    const href = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/iu.exec(
      tag[1],
    );
    const value = href?.[1] ?? href?.[2] ?? href?.[3] ?? "";
    if (!value || value.startsWith("#")) continue;
    found.push({
      href: value,
      text: tag[2]
        .replace(/<[^>]+>/gu, " ")
        .replace(/\s+/gu, " ")
        .trim(),
    });
  }
  return found;
}
