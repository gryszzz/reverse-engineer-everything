const WEAKNESS_TYPES = new Set([
  "overpriced",
  "missing_feature",
  "billing",
  "support",
  "lock_in",
  "ux",
]);

const SCORE_KEYS = [
  "pain",
  "willingness_to_pay",
  "build_ease",
  "competitor_weakness",
  "reach",
];

function fail(errors, path, message) {
  errors.push({ path, message });
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scoreValue(value, path, errors) {
  if (!Number.isInteger(value) || value < 1 || value > 5)
    fail(errors, path, "must be an integer from 1 to 5");
}

/** Validate one Scout target. Unknown fields are rejected. */
export function parseScoutTarget(value) {
  const errors = [];
  if (!isObject(value)) {
    return { ok: false, errors: [{ path: "/", message: "must be an object" }] };
  }
  const allowed = new Set([
    "target_name",
    "url",
    "category",
    "pricing",
    "weaknesses",
    "market_signal",
    "scores",
    "confidence",
    "found_at",
    "tracker_ref",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(errors, key, "is not a Scout field");
  }
  if (typeof value.target_name !== "string" || !value.target_name.trim())
    fail(errors, "target_name", "must be a non-empty string");
  if (typeof value.url !== "string" || !value.url.trim())
    fail(errors, "url", "must be a non-empty string");
  if (typeof value.category !== "string" || !value.category.trim())
    fail(errors, "category", "must be a non-empty string");
  if (typeof value.tracker_ref !== "string" || !value.tracker_ref.trim())
    fail(errors, "tracker_ref", "must be a non-empty string");
  if (
    typeof value.found_at !== "string" ||
    Number.isNaN(Date.parse(value.found_at))
  )
    fail(errors, "found_at", "must be a date-time string");
  if (
    !Number.isInteger(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 100
  )
    fail(errors, "confidence", "must be an integer from 0 to 100");
  parsePricing(value.pricing, errors);
  parseWeaknesses(value.weaknesses, errors);
  parseSignal(value.market_signal, errors);
  parseScores(value.scores, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, target: value, errors: [] };
}

function parsePricing(pricing, errors) {
  if (!isObject(pricing)) {
    fail(errors, "pricing", "must be an object");
    return;
  }
  for (const key of Object.keys(pricing)) {
    if (!["plans", "model", "source_url"].includes(key))
      fail(errors, `pricing.${key}`, "is not a pricing field");
  }
  if (!Array.isArray(pricing.plans))
    fail(errors, "pricing.plans", "must be an array");
  else {
    pricing.plans.forEach((plan, index) => {
      if (typeof plan !== "string" || !plan.trim())
        fail(errors, `pricing.plans[${index}]`, "must be a non-empty string");
    });
  }
  if (typeof pricing.model !== "string")
    fail(errors, "pricing.model", "must be a string");
  if (typeof pricing.source_url !== "string" || !pricing.source_url.trim())
    fail(errors, "pricing.source_url", "must be a non-empty string");
}

function parseWeaknesses(weaknesses, errors) {
  if (!Array.isArray(weaknesses)) {
    fail(errors, "weaknesses", "must be an array");
    return;
  }
  weaknesses.forEach((item, index) => {
    const path = `weaknesses[${index}]`;
    if (!isObject(item)) {
      fail(errors, path, "must be an object");
      return;
    }
    for (const key of Object.keys(item)) {
      if (!["type", "summary", "evidence_urls"].includes(key))
        fail(errors, `${path}.${key}`, "is not a weakness field");
    }
    if (!WEAKNESS_TYPES.has(item.type))
      fail(errors, `${path}.type`, "must be a known weakness type");
    if (typeof item.summary !== "string" || !item.summary.trim())
      fail(errors, `${path}.summary`, "must be a non-empty string");
    if (!Array.isArray(item.evidence_urls) || item.evidence_urls.length === 0)
      fail(errors, `${path}.evidence_urls`, "must list at least one URL");
    else {
      item.evidence_urls.forEach((url, urlIndex) => {
        if (typeof url !== "string" || !url.trim())
          fail(
            errors,
            `${path}.evidence_urls[${urlIndex}]`,
            "must be a non-empty string",
          );
      });
    }
  });
}

function parseSignal(signal, errors) {
  if (!isObject(signal)) {
    fail(errors, "market_signal", "must be an object");
    return;
  }
  const keys = [
    "review_count",
    "rating",
    "complaint_volume",
    "search_demand",
    "notes",
  ];
  for (const key of Object.keys(signal)) {
    if (!keys.includes(key))
      fail(errors, `market_signal.${key}`, "is not a signal field");
  }
  for (const key of ["review_count", "complaint_volume", "search_demand"]) {
    if (!Number.isInteger(signal[key]) || signal[key] < 0)
      fail(errors, `market_signal.${key}`, "must be an integer >= 0");
  }
  if (
    typeof signal.rating !== "number" ||
    signal.rating < 0 ||
    signal.rating > 5
  )
    fail(errors, "market_signal.rating", "must be a number from 0 to 5");
  if (typeof signal.notes !== "string")
    fail(errors, "market_signal.notes", "must be a string");
}

function parseScores(scores, errors) {
  if (!isObject(scores)) {
    fail(errors, "scores", "must be an object");
    return;
  }
  for (const key of Object.keys(scores)) {
    if (![...SCORE_KEYS, "total"].includes(key))
      fail(errors, `scores.${key}`, "is not a score field");
  }
  for (const key of SCORE_KEYS)
    scoreValue(scores[key], `scores.${key}`, errors);
  const sum = SCORE_KEYS.reduce(
    (total, key) => total + (Number.isInteger(scores[key]) ? scores[key] : 0),
    0,
  );
  if (scores.total !== sum) fail(errors, "scores.total", `must equal ${sum}`);
}

export function formatParseErrors(errors) {
  return errors.map((error) => `${error.path}: ${error.message}`).join("; ");
}
