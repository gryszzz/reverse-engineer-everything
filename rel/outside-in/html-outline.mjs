import { decodeEntities, normalizeSpace } from "./text.mjs";

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "title",
  "svg",
  "head",
  "nav",
]);

export function pageOutline(html) {
  const tokens = tokenize(String(html ?? ""));
  return walk(tokens);
}

export function metaDescription(html) {
  const tags = String(html ?? "").match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/name=["']description["']/i.test(tag)) continue;
    const content = /content=["']([^"']*)["']/i.exec(tag);
    if (content) return normalizeSpace(decodeEntities(content[1]));
  }
  return "";
}

function tokenize(html) {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
  const tokens = [];
  const pattern = /<\/?[a-zA-Z][^>]*>|[^<]+/g;
  for (const match of stripped.matchAll(pattern)) {
    const raw = match[0];
    if (raw.startsWith("<")) {
      const closed = raw.startsWith("</");
      const name = raw
        .replace(/^<\/?/, "")
        .replace(/[\s/>].*$/, "")
        .toLowerCase();
      tokens.push({ type: "tag", name, closed, raw });
    } else {
      const text = normalizeSpace(decodeEntities(raw));
      if (text) tokens.push({ type: "text", text });
    }
  }
  return tokens;
}

function walk(tokens) {
  const blocks = [];
  const regions = [];
  let skip = 0;
  let mode = null;
  let buffer = "";
  let headingLevel = 0;
  let current = null;
  let list = null;

  const flush = () => {
    const text = normalizeSpace(buffer);
    buffer = "";
    if (!text) return;
    if (mode === "heading")
      current = startBlock(blocks, current, headingLevel, text, regions);
    else if (mode === "li" && list) list.items.push(text);
    else if (current) current.paragraphs.push(text);
  };

  for (const token of tokens) {
    if (token.type === "tag") {
      if (!token.closed && SKIP.has(token.name)) skip += 1;
      if (token.closed && SKIP.has(token.name) && skip > 0) skip -= 1;
      if (skip > 0) continue;
      consumeTag(token, {
        flush,
        regions,
        setMode: (next) => {
          mode = next;
        },
        setLevel: (level) => {
          headingLevel = level;
        },
        getCurrent: () => current,
        setCurrent: (block) => {
          current = block;
        },
        setList: (next) => {
          list = next;
        },
        blocks,
      });
      continue;
    }
    if (skip > 0 || !mode) continue;
    buffer += ` ${token.text}`;
  }
  flush();
  if (current) blocks.push(current);
  return { blocks };
}

function startBlock(blocks, current, level, text, regions) {
  if (current) blocks.push(current);
  return {
    heading: text,
    level,
    paragraphs: [],
    lists: [],
    region: regions.map((region) => ({ ...region })),
  };
}

function consumeTag(token, ctx) {
  const { name, closed, raw } = token;
  if (!closed && (name === "section" || name === "article" || name === "div")) {
    ctx.regions.push({
      tag: name,
      id: attr(raw, "id"),
      className: attr(raw, "class"),
    });
    return;
  }
  if (closed && (name === "section" || name === "article" || name === "div")) {
    for (let index = ctx.regions.length - 1; index >= 0; index -= 1) {
      if (ctx.regions[index].tag === name) {
        ctx.regions.splice(index, 1);
        break;
      }
    }
    return;
  }
  if (!closed && /^h[1-3]$/.test(name)) {
    ctx.flush();
    ctx.setMode("heading");
    ctx.setLevel(Number(name.slice(1)));
    return;
  }
  if (closed && /^h[1-3]$/.test(name)) {
    ctx.flush();
    ctx.setMode(null);
    return;
  }
  if (!closed && (name === "ul" || name === "ol")) {
    ctx.flush();
    const list = { ordered: name === "ol", items: [] };
    const current = ctx.getCurrent();
    if (current) current.lists.push(list);
    ctx.setList(list);
    return;
  }
  if (closed && (name === "ul" || name === "ol")) {
    ctx.flush();
    ctx.setList(null);
    ctx.setMode(null);
    return;
  }
  if (!closed && name === "li") {
    ctx.flush();
    ctx.setMode("li");
    return;
  }
  if (closed && name === "li") {
    ctx.flush();
    ctx.setMode(null);
    return;
  }
  if (!closed && name === "p") {
    ctx.flush();
    ctx.setMode("p");
    return;
  }
  if (closed && name === "p") {
    ctx.flush();
    ctx.setMode(null);
  }
}

function attr(tag, name) {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  return match ? (match[2] ?? match[3] ?? match[4] ?? "") : "";
}
