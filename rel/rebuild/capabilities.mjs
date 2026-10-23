const SEARCH_PARAMS = new Set([
  "q",
  "query",
  "search",
  "limit",
  "offset",
  "page",
]);

/**
 * Capabilities the rebuild will build from this spec.
 * A missing signal stays left out. Nothing here is a percentage of the original product.
 */
export function decideCapabilities(spec, plan) {
  const routes = plan.routes ?? [];
  const hasRecords = routes.some((route) =>
    ["create", "list", "read", "replace", "merge", "remove"].includes(
      route.action,
    ),
  );
  const relations = relationList(routes);
  const search = wantsSearch(spec);
  const auth = authMode(spec);
  const roles = Boolean(auth) && wantsRoles(spec);
  const webhooks = wantsWebhooks(spec);
  const pricing = pricingPlans(spec);
  const http = routes.length > 0;
  const runtime = {
    storage: hasRecords ? "sqlite" : null,
    relations,
    search,
    auth,
    roles,
    webhooks,
    pricing,
    openapi: http,
    deploy: http,
  };
  const items = [
    hasRecords
      ? item(
          "storage",
          "implemented",
          "Records are stored in data/store.sqlite.",
        )
      : item(
          "storage",
          "left-out",
          "No record route was built, so no database was added.",
        ),
    relations.length > 0
      ? item(
          "relations",
          "implemented",
          "A field names another collection. A missing id is rejected.",
        )
      : item("relations", "left-out", "No field names another collection."),
    search
      ? item(
          "search",
          "implemented",
          "List routes accept q, field filters, limit, and offset. Omitting them returns every visible record.",
        )
      : item(
          "search",
          "left-out",
          "The spec has no search, filter, or page parameter.",
        ),
    auth
      ? item(
          "auth",
          "implemented",
          auth.mode === "magic"
            ? "Magic link sessions are local. No mailer is configured, so no email is sent."
            : "Email and password sessions are local. Each record is stored for the signed-in user.",
        )
      : item("auth", "left-out", "The spec describes no authentication."),
    roles
      ? item(
          "roles",
          "implemented",
          "The first account is an admin. Later accounts are members and see their own records.",
        )
      : item(
          "roles",
          "left-out",
          auth
            ? "The spec has accounts and does not describe roles."
            : "Roles need an account model in the spec.",
        ),
    webhooks
      ? item(
          "webhooks",
          "implemented",
          "Events are stored locally and are not delivered to another host.",
        )
      : item(
          "webhooks",
          "left-out",
          "The spec has no webhook path or integration.",
        ),
    pricing
      ? item(
          "pricing",
          "implemented",
          "GET /pricing lists the spec plans. POST /checkout accepts a Stripe test key and refuses a live key.",
        )
      : item("pricing", "left-out", "The spec has no pricing plan."),
    http
      ? item(
          "ui",
          "implemented",
          "The product page lists each collection that was built.",
        )
      : item(
          "ui",
          "left-out",
          "No route was built, so no product page was added.",
        ),
    http
      ? item(
          "openapi",
          "implemented",
          "openapi.json describes the generated routes.",
        )
      : item(
          "openapi",
          "left-out",
          "No route was built, so no OpenAPI document was written.",
        ),
    http
      ? item(
          "deploy",
          "implemented",
          "Dockerfile and render.yaml bind the web service to 0.0.0.0 and PORT. No Stripe key is stored in those files.",
        )
      : item(
          "deploy",
          "left-out",
          "No HTTP service was built, so no deploy file was written.",
        ),
  ];
  return { ...runtime, items };
}

export function capabilityReport(decision) {
  return {
    schema_version: "ree.rebuild.capabilities.v1",
    note: "Each capability is implemented or left out for this spec. These counts are not a percentage of the original product.",
    capabilities: decision.items,
  };
}

export function capabilityLines(decision) {
  const lines = [
    "## Capabilities",
    "",
    "Each capability is implemented or left out for this spec. These lines are not a percentage of the original product.",
    "",
  ];
  for (const entry of decision.items) {
    lines.push(`- ${entry.id}: ${entry.status}. ${entry.reason}`);
  }
  return lines;
}

function item(id, status, reason) {
  return { id, status, reason };
}

function collections(routes) {
  const map = new Map();
  for (const route of routes) {
    const path = route.collection || (route.path_param ? null : route.path);
    if (!path || path.includes("{")) continue;
    const current = map.get(route.resource) ?? {
      path,
      resource: route.resource,
      fields: new Set(),
    };
    current.path = path;
    current.resource = route.resource;
    for (const name of route.model ?? []) current.fields.add(name);
    map.set(route.resource, current);
  }
  return [...map.values()];
}

function relationList(routes) {
  const cols = collections(routes);
  const relations = [];
  for (const col of cols) {
    for (const field of col.fields) {
      if (field === "id" || field === "owner") continue;
      const bare = field.endsWith("_id")
        ? field.slice(0, -3)
        : field.endsWith("Id")
          ? field.slice(0, -2)
          : null;
      if (!bare) continue;
      const key = bare.toLowerCase().replace(/_/gu, "");
      const target = cols.find((other) => {
        if (other.path === col.path) return false;
        const last = other.path.split("/").filter(Boolean).pop() ?? "";
        const norm = last.toLowerCase().replace(/-/gu, "");
        return (
          norm === key || norm === `${key}s` || key === norm.replace(/s$/u, "")
        );
      });
      if (!target) continue;
      relations.push({ field, bucket: target.resource });
    }
  }
  return relations;
}

function wantsSearch(spec) {
  for (const endpoint of spec.api?.endpoints ?? []) {
    for (const name of endpoint.parameters ?? []) {
      if (SEARCH_PARAMS.has(String(name).toLowerCase())) return true;
    }
  }
  const text = (spec.features ?? [])
    .map((feature) => `${feature.name ?? ""} ${feature.detail ?? ""}`)
    .join("\n");
  return /\b(search|filter|pagination|paging)\b/iu.test(text);
}

function authMode(spec) {
  const auth = spec.api?.auth ?? [];
  if (auth.length === 0) return null;
  const text = auth
    .map((entry) => `${entry.name ?? ""} ${entry.style ?? ""}`)
    .join("\n");
  if (/magic|email.?link/iu.test(text)) return { mode: "magic" };
  return { mode: "password" };
}

function wantsRoles(spec) {
  const featureText = (spec.features ?? [])
    .map((feature) => `${feature.name ?? ""} ${feature.detail ?? ""}`)
    .join("\n");
  if (/\broles?\b|\badmin\b/iu.test(featureText)) return true;
  for (const endpoint of spec.api?.endpoints ?? []) {
    if ((endpoint.parameters ?? []).some((name) => /^role$/iu.test(name)))
      return true;
  }
  const authText = (spec.api?.auth ?? [])
    .map((entry) => `${entry.name ?? ""} ${entry.style ?? ""}`)
    .join("\n");
  return /\broles?\b|\badmin\b/iu.test(authText);
}

function wantsWebhooks(spec) {
  for (const endpoint of spec.api?.endpoints ?? []) {
    if (/webhook/iu.test(String(endpoint.path ?? ""))) return true;
  }
  return (spec.integrations ?? []).some((entry) =>
    /webhook/iu.test(String(entry.name ?? "")),
  );
}

function pricingPlans(spec) {
  const plans = spec.pricing?.plans ?? [];
  if (plans.length === 0) return null;
  return {
    plans: plans.map((plan) => ({
      name: String(plan.name ?? ""),
      amount: plan.price?.amount ?? null,
      currency: plan.price?.currency ?? null,
      interval: plan.price?.interval ?? null,
      display: plan.price?.display ?? null,
    })),
  };
}
