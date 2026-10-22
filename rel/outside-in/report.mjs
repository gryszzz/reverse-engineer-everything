export function renderReport(spec) {
  const lines = [
    `# Outside-in behavior spec: ${spec.target.name}`,
    "",
    "Clean room: yes. This report contains descriptions and structured facts only. It does not contain copied source or long verbatim passages.",
    "",
    spec.clean_room_statement,
    "",
    `Generated: ${spec.generated_at}`,
    `Status: ${spec.status}`,
    `LLM: ${spec.llm.used ? `caller-supplied (${spec.llm.provider})` : "not used"}`,
    "REE remote model calls: not performed.",
    "",
    "## Target",
    "",
    ...spec.target.urls.map((url) => `- ${url}`),
    "",
    "## Sources",
    "",
  ];
  if (spec.sources.length === 0)
    lines.push("No public document was fetched.", "");
  for (const source of spec.sources) {
    lines.push(
      `- ${source.role} ${source.url} (HTTP ${source.status}, fetched ${source.fetched_at}, sha256 ${source.sha256}, cache ${source.cache.hit ? "hit" : "miss"})`,
    );
  }
  lines.push("", "## Refusals", "");
  if (spec.refusals.length === 0) lines.push("None.", "");
  for (const refusal of spec.refusals) {
    lines.push(`- ${refusal.reason}: ${refusal.url} — ${refusal.detail}`);
  }
  lines.push("", "## Features", "");
  writeClaims(lines, spec.features, (feature) => {
    const quote = feature.quote ? ` Quote: "${feature.quote.text}".` : "";
    return `- ${feature.name}. ${feature.detail}${quote} ${cite(feature.citations)}`;
  });
  lines.push("", "## Workflows", "");
  if (spec.workflows.length === 0) lines.push("None recognized.", "");
  for (const workflow of spec.workflows) {
    lines.push(`- ${workflow.name}. ${cite(workflow.citations)}`);
    for (const step of workflow.steps) lines.push(`  - "${step.text}"`);
  }
  lines.push("", "## Public API", "");
  lines.push(`Style: ${spec.api.style}.`, "");
  for (const server of spec.api.servers) {
    lines.push(`- Server ${server.url}. ${cite(server.citations)}`);
  }
  for (const auth of spec.api.auth) {
    lines.push(
      `- Auth ${auth.name} (${auth.style}, ${auth.placement ?? "unspecified"}). ${cite(auth.citations)}`,
    );
  }
  for (const limit of spec.api.rate_limits) {
    lines.push(
      `- Rate limit ${limit.limit}${limit.window ? `/${limit.window}` : ""} (${limit.scope}). ${cite(limit.citations)}`,
    );
  }
  for (const endpoint of spec.api.endpoints) {
    const summary = endpoint.summary ? ` "${endpoint.summary.text}".` : "";
    lines.push(
      `- ${endpoint.method} ${endpoint.path}.${summary} ${cite(endpoint.citations)}`,
    );
  }
  for (const unknown of spec.api.unknowns) lines.push(`- Unknown: ${unknown}`);
  if (
    spec.api.servers.length +
      spec.api.auth.length +
      spec.api.endpoints.length +
      spec.api.unknowns.length ===
    0
  )
    lines.push("No public API document was recognized.");
  lines.push("", "## Pricing", "");
  if (spec.pricing.plans.length === 0) lines.push("None recognized.", "");
  for (const plan of spec.pricing.plans) {
    const price = plan.price
      ? `${plan.price.display} (${plan.price.amount} ${plan.price.currency}${plan.price.interval ? `/${plan.price.interval}` : ""})`
      : "price not recognized";
    const limits = plan.limits.length
      ? ` Limits: ${plan.limits.join("; ")}.`
      : "";
    lines.push(`- ${plan.name}: ${price}.${limits} ${cite(plan.citations)}`);
  }
  lines.push("", "## Integrations", "");
  writeClaims(
    lines,
    spec.integrations,
    (item) => `- ${item.name}. ${cite(item.citations)}`,
  );
  lines.push("", "## Stated limitations", "");
  if (spec.limitations.length === 0) lines.push("None recognized.", "");
  for (const item of spec.limitations) {
    lines.push(
      `- (${item.origin}) "${item.statement.text}". ${cite(item.citations)}`,
    );
  }
  lines.push("", "## Changelog", "");
  if (spec.changes.length === 0) lines.push("None recognized.", "");
  for (const change of spec.changes) {
    const when = change.published_at ?? "date unknown";
    lines.push(`- "${change.title.text}" (${when}). ${cite(change.citations)}`);
  }
  lines.push("", "## Omitted material", "");
  if (spec.omitted.length === 0) lines.push("None.", "");
  for (const item of spec.omitted) {
    lines.push(
      `- ${item.count} ${item.kind} block(s) omitted. ${cite(item.citations)}`,
    );
  }
  lines.push("", "## Similarity guard", "");
  lines.push(
    spec.similarity.flagged
      ? `Flagged ${spec.similarity.findings.length} passage(s) at threshold ${spec.similarity.threshold}. Copied text was removed from this spec.`
      : `No verbatim run at or above ${spec.similarity.threshold} characters was found outside short attributed quotes (maximum ${spec.similarity.quote_max}).`,
  );
  lines.push("", "## Unknowns", "");
  if (spec.coverage.unknowns.length === 0) lines.push("None.", "");
  for (const unknown of spec.coverage.unknowns) lines.push(`- ${unknown}`);
  lines.push(
    "",
    "## Boundaries",
    "",
    "- Public http(s) documents only. robots.txt is fetched and obeyed. A missing or blocking robots file fails closed, except HTTP 404, which is treated as no rules.",
    "- Rate limits and crawl-delay are honored by waiting or stopping. HTTP 429 is not retried.",
    "- No login, cookies, credentials, captcha solving, paywall bypass, or headless browser.",
    "- Redirects are not followed. Source files and binaries are not fetched or decompiled.",
    "- The cache stores fetched bytes for provenance. It is not part of this clean-room spec.",
    "- This spec does not grant any right to copy the product, its code, or its marketing copy.",
    "",
  );
  return lines.join("\n");
}

function writeClaims(lines, items, render) {
  if (items.length === 0) {
    lines.push("None recognized.", "");
    return;
  }
  for (const item of items) lines.push(render(item));
  lines.push("");
}

function cite(citations) {
  return citations
    .map(
      (citation) => `(source: ${citation.url}, fetched ${citation.fetched_at})`,
    )
    .join(" ");
}
