const SECRET_PATTERN =
  "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+";
const ENV_NAMES = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];

/** Replace Stripe key material with a fixed token. The value is never returned. */
export function redactText(value) {
  let text = String(value ?? "").replace(
    new RegExp(SECRET_PATTERN, "g"),
    "[redacted]",
  );
  for (const name of ENV_NAMES) {
    const secret = process.env[name];
    if (typeof secret === "string" && secret.length >= 8)
      text = text.split(secret).join("[redacted]");
  }
  return text;
}

/** Walk JSON-like values and redact strings. Non-strings pass through. */
export function redactValue(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    const copy = {};
    for (const [key, item] of Object.entries(value))
      copy[key] = redactValue(item);
    return copy;
  }
  return value;
}
