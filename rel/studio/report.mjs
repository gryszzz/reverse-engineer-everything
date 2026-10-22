const safe = (value) =>
  String(value ?? "unknown")
    .replaceAll(/[\r\n]/gu, " ")
    .replaceAll(/([\\`*_{}[\]()#+\-.!|<>~])/gu, "\\$1");

function bullet(items) {
  if (!items || items.length === 0) return ["- None recorded."];
  return items.slice(0, 12).map((item) => `- ${safe(item)}`);
}

/** Markdown projection of saved studio state. It does not create findings. */
export function renderStudioReport(project) {
  const lines = [
    "# REE Investigation Studio report",
    "",
    `**Project:** ${safe(project.name)}`,
    `**Question:** ${safe(project.question || "No question saved")}`,
    `**Mode:** ${safe(project.mode)}`,
    "",
    "This report restates records saved by the studio. It is not a new analysis and it does not prove runtime behavior.",
    "",
    "## Artifacts",
  ];
  if (project.artifacts.length === 0)
    lines.push("- No artifact has been added.");
  for (const artifact of project.artifacts) {
    lines.push(
      `- ${safe(artifact.path)} — intake ${safe(artifact.intake?.label)} (${safe(artifact.intake?.capability)}). ${safe(artifact.intake?.basis)}`,
    );
  }
  lines.push("", "## Static runs");
  if (project.runs.length === 0)
    lines.push("- No static analysis has been run.");
  for (const run of project.runs) {
    lines.push(
      `- ${safe(run.id)} ${safe(run.status)}; Evidence ${safe(run.evidence_id)}; nodes ${safe(run.summary?.counts?.nodes)}; edges ${safe(run.summary?.counts?.edges)}.`,
    );
    if (run.command?.argv)
      lines.push(`  Command: \`${run.command.argv.join(" ")}\``);
    lines.push(...bullet(run.summary?.limitations).map((item) => `  ${item}`));
  }
  lines.push("", "## Runtime experiments");
  if (project.experiments.length === 0)
    lines.push(
      "- No owned-fixture probe has been approved. Static Evidence was not rewritten.",
    );
  for (const experiment of project.experiments) {
    lines.push(
      `- ${safe(experiment.id)} ${safe(experiment.status)}; query ${safe(experiment.observation?.query)}; ids ${safe((experiment.observation?.ids ?? []).join(", "))}.`,
    );
    lines.push(`  ${safe(experiment.separation)}`);
    for (const item of experiment.comparison ?? [])
      lines.push(
        `  - ${safe(item.hypothesis_id)}: ${item.matches ? "matched" : "did not match"} the capture.`,
      );
  }
  lines.push("", "## Research sessions");
  if (project.research_sessions.length === 0)
    lines.push(
      "- No local research session is saved. Remote model calls stay refused.",
    );
  for (const session of project.research_sessions) {
    lines.push(
      `- ${safe(session.id)} remote ${safe(session.remote_calls)}; facts ${session.facts?.length ?? 0}; hypotheses ${session.hypotheses?.length ?? 0}; unknowns ${session.unknowns?.length ?? 0}.`,
    );
  }
  lines.push(
    "",
    "## Limits",
    "- The studio currently executes static analysis only for JavaScript or Electron directories and ASAR files.",
    "- Ghidra, IDA, Hopper, Apktool, JADX, and JEB are not launched from this studio.",
    "- Hypothesis statements in an experiment are caller-declared predictions, not engine discoveries.",
    "",
  );
  return lines.join("\n");
}
