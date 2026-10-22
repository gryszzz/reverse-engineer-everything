export const FINDING_TYPES = [
  "module",
  "function",
  "import",
  "call",
  "endpoint",
  "string",
  "behavior",
];

function unique(values) {
  return [...new Set(values)];
}

/** Precision and recall for one finding type. Null means the type does not apply. */
export function scoreType(expected, found) {
  const expectedKeys = unique(expected ?? []);
  const foundKeys = unique(found ?? []);
  const expectedSet = new Set(expectedKeys);
  const foundSet = new Set(foundKeys);
  const matched = expectedKeys.filter((key) => foundSet.has(key));
  const missed = expectedKeys.filter((key) => !foundSet.has(key));
  const falseClaims = foundKeys.filter((key) => !expectedSet.has(key));
  const precision =
    foundKeys.length === 0
      ? expectedKeys.length === 0
        ? null
        : 1
      : matched.length / foundKeys.length;
  const recall =
    expectedKeys.length === 0 ? null : matched.length / expectedKeys.length;
  return {
    precision,
    recall,
    expected: expectedKeys.length,
    found: foundKeys.length,
    matched: matched.length,
    missed,
    false_claims: falseClaims,
  };
}

export function scoreFindings(expected, found) {
  const scores = {};
  for (const type of FINDING_TYPES) {
    scores[type] = scoreType(expected?.[type], found?.[type]);
  }
  return scores;
}

export function scorePasses(scores, thresholds = {}) {
  const failures = [];
  for (const type of FINDING_TYPES) {
    const score = scores[type];
    const gate = thresholds[type];
    for (const claim of score.false_claims)
      failures.push(`${type} false claim: ${claim}`);
    if (!gate) continue;
    if (
      gate.precision != null &&
      score.precision != null &&
      score.precision < gate.precision
    )
      failures.push(
        `${type} precision ${score.precision} is below ${gate.precision}`,
      );
    if (
      gate.recall != null &&
      score.recall != null &&
      score.recall < gate.recall
    )
      failures.push(`${type} recall ${score.recall} is below ${gate.recall}`);
  }
  return failures;
}
