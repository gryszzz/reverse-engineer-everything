export const COVERAGE_SCHEMA = "ree.rebuild.coverage.v1";
export const COVERAGE_THRESHOLD = 0.8;

/**
 * Planned coverage is the rebuild decision.
 * Measured coverage is the behavior tests that actually passed.
 */
export function plannedCoverage(plan, featureCount) {
  const implemented = plan.behaviors
    .filter((item) => item.status === "implemented")
    .map((item) => item.id);
  const total = featureCount;
  const ratio = total === 0 ? null : implemented.length / total;
  return {
    schema_version: COVERAGE_SCHEMA,
    threshold: COVERAGE_THRESHOLD,
    implemented,
    left_out: plan.leftOut ?? [],
    total,
    ratio,
    passed: ratio !== null && ratio >= COVERAGE_THRESHOLD,
  };
}

export function coverageDecision(verify, planned = { left_out: [] }) {
  const reasons = new Map(
    (planned.left_out ?? []).map((item) => [item.id, item.reason]),
  );
  const features = (verify.features ?? []).map((feature) => {
    if (feature.match === "pass") {
      return {
        id: feature.id,
        name: feature.name,
        status: "implemented",
        reason: null,
        route: feature.route ?? null,
      };
    }
    return {
      id: feature.id,
      name: feature.name,
      status: "left-out",
      reason:
        reasons.get(feature.id) ??
        (feature.match === "fail"
          ? "the behavior test failed"
          : feature.match === "not-run"
            ? "the feature test did not run"
            : "the feature was not built"),
      route: feature.route ?? null,
    };
  });
  const implemented = features.filter(
    (feature) => feature.status === "implemented",
  ).length;
  const total = features.length;
  const ratio = total === 0 ? null : implemented / total;
  return {
    schema_version: COVERAGE_SCHEMA,
    threshold: COVERAGE_THRESHOLD,
    implemented,
    left_out: total - implemented,
    total,
    ratio,
    passed: ratio !== null && ratio >= COVERAGE_THRESHOLD,
    features,
  };
}

export function formatCoverageReport(decision) {
  const ratio = decision.ratio === null ? "none" : decision.ratio.toFixed(3);
  const lines = [
    `Feature coverage ${ratio} (${decision.implemented}/${decision.total}). Threshold ${decision.threshold.toFixed(3)}.`,
    "",
    "Implemented:",
  ];
  const built = decision.features.filter(
    (feature) => feature.status === "implemented",
  );
  if (built.length === 0) lines.push("- none");
  else {
    for (const feature of built) {
      const route = feature.route
        ? ` ${feature.route.method} ${feature.route.path}`
        : "";
      lines.push(`- ${feature.id} ${feature.name}${route}`);
    }
  }
  lines.push("", "Left out:");
  const omitted = decision.features.filter(
    (feature) => feature.status !== "implemented",
  );
  if (omitted.length === 0) lines.push("- none");
  else {
    for (const feature of omitted)
      lines.push(`- ${feature.id} ${feature.name}: ${feature.reason}.`);
  }
  lines.push("");
  return lines.join("\n");
}
