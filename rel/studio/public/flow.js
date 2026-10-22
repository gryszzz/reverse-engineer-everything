export const primaryFlow = [
  ["door", "Front door"],
  ["analyze", "Analyze"],
  ["findings", "Findings"],
  ["board", "Board"],
  ["build", "Build"],
  ["lessons", "Lessons"],
];

export const advancedLabs = [
  ["rebuild", "Evidence rebuild"],
  ["overview", "Overview"],
  ["intake", "Intake"],
  ["readiness", "Readiness"],
  ["evidence", "Evidence"],
  ["graph", "Graph"],
  ["research", "Research"],
  ["experiment", "Experiment"],
  ["report", "Report"],
];

export function navigation(mode) {
  if (mode === "advanced") return [...primaryFlow, ...advancedLabs];
  return [...primaryFlow];
}
