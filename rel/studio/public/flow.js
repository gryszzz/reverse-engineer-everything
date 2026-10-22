export const primaryFlow = [
  ["door", "Front door"],
  ["analyze", "Analyze"],
  ["findings", "Findings"],
  ["build", "Build"],
];

export const advancedLabs = [
  ["board", "Board"],
  ["lessons", "Lessons"],
  ["diff-lab", "Diff Lab"],
  ["trace-lab", "Trace Lab"],
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
