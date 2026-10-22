function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseRobots(text) {
  const groups = [];
  let current = null;
  const flush = () => {
    current = { agents: [], rules: [], crawlDelay: null };
    groups.push(current);
  };
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const stripped = line.replace(/#.*$/, "").trim();
    if (!stripped) continue;
    const index = stripped.indexOf(":");
    if (index < 0) continue;
    const key = stripped.slice(0, index).trim().toLowerCase();
    const value = stripped.slice(index + 1).trim();
    if (key === "user-agent") {
      if (!current || current.rules.length > 0 || current.crawlDelay != null) flush();
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      current.rules.push({ type: key, path: value });
    } else if (key === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }
  return groups.filter((group) => group.agents.length > 0);
}

function productToken(userAgent) {
  return userAgent.split("/")[0].trim().toLowerCase();
}

function agentMatches(agent, token, userAgent) {
  if (!agent || agent === "*") return false;
  return token.includes(agent) || userAgent.toLowerCase().includes(agent);
}

function pathMatches(pathname, pattern) {
  if (pattern === "") return false;
  let body = pattern;
  let end = false;
  if (body.endsWith("$")) {
    end = true;
    body = body.slice(0, -1);
  }
  const expression = `^${body.split("*").map(escapeRegex).join(".*")}${end ? "$" : ""}`;
  return new RegExp(expression).test(pathname);
}

export function evaluateRobots(groups, userAgent, pathname) {
  const token = productToken(userAgent);
  const specific = groups.filter((group) =>
    group.agents.some((agent) => agentMatches(agent, token, userAgent)),
  );
  const chosen = specific.length ? specific : groups.filter((group) => group.agents.includes("*"));
  const rules = chosen.flatMap((group) => group.rules);
  const crawlDelaySeconds = chosen.reduce(
    (max, group) => (group.crawlDelay == null ? max : Math.max(max, group.crawlDelay)),
    0,
  );
  let matched = null;
  for (const rule of rules) {
    if (!pathMatches(pathname, rule.path)) continue;
    if (!matched || rule.path.length > matched.path.length) matched = rule;
  }
  if (!matched) {
    return { allowed: true, rule: null, crawlDelaySeconds };
  }
  return {
    allowed: matched.type === "allow",
    rule: `${matched.type === "allow" ? "Allow" : "Disallow"}: ${matched.path}`,
    crawlDelaySeconds,
  };
}
