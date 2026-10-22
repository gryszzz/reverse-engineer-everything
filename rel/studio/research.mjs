import {
  exploreEvidence,
  createSemanticEvidenceSearcher,
} from "../evidence-explorer.mjs";
import { summarizeEvidence } from "../evidence-summary.mjs";
import { questionSearchTerms } from "../question-guidance.mjs";
import { projectApplicationGraph } from "./graph.mjs";

const REMOTE =
  "Remote model calls are refused. No Evidence, source, or project text is uploaded.";

function stage(id, tool, status, extra) {
  return {
    id,
    tool,
    status,
    facts: extra.facts ?? [],
    hypotheses: extra.hypotheses ?? [],
    unknowns: extra.unknowns ?? [],
    tool_call: extra.tool_call ?? null,
    result: extra.result ?? null,
  };
}

function coverageUnknowns(coverage, label) {
  if (!coverage || typeof coverage !== "object")
    return [`${label} coverage was not recorded.`];
  const unknowns = [];
  if (coverage.status === "unknown" || coverage.status == null)
    unknowns.push(`${label} coverage status is unknown.`);
  if (coverage.truncated === true)
    unknowns.push(`${label} coverage is truncated.`);
  return unknowns;
}

function traceFacts(explored) {
  return explored.edges
    .slice(0, 5)
    .map(
      (edge) =>
        `${edge.edge_id} ${edge.source.label} -[${edge.relation}]-> ${edge.target.label}; state ${edge.state}; confidence ${edge.confidence}; authority ${edge.authority}`,
    );
}

/** Local, auditable stages over retained records. Never calls a model. */
export function runLocalResearch({
  enabled,
  keyConfigured = false,
  project,
  record = null,
  diff = null,
  experiment = null,
}) {
  if (enabled !== true) {
    return {
      enabled: false,
      key_configured: keyConfigured,
      remote_calls: "refused",
      remote_reason: REMOTE,
      stages: [],
    };
  }
  const stages = [];
  const artifact = project.artifacts[0] ?? null;
  stages.push(
    artifact
      ? stage("SCOUT", "intake.classifyTarget", "completed", {
          tool_call: {
            name: "classifyTarget",
            arguments: { path: artifact.path },
          },
          result: {
            kind: artifact.intake.kind,
            label: artifact.intake.label,
            capability: artifact.intake.capability,
            basis: artifact.intake.basis,
          },
          facts: [
            `Intake kind ${artifact.intake.kind}; capability ${artifact.intake.capability}.`,
            `Basis: ${artifact.intake.basis}`,
          ],
          unknowns: [
            "Intake is a classification heuristic, not an analysis and not proof of format completeness.",
          ],
        })
      : stage("SCOUT", "intake.classifyTarget", "not-run", {
          unknowns: ["No artifact has been added to this project."],
        }),
  );

  let summary = null;
  if (record) {
    try {
      summary = summarizeEvidence(record);
      const window = projectApplicationGraph(record, { limit: 1 });
      stages.push(
        stage("MAPPER", "summarizeEvidence", "completed", {
          tool_call: {
            name: "summarizeEvidence",
            arguments: { evidence_id: summary.evidence_id },
          },
          result: {
            evidence_id: summary.evidence_id,
            counts: summary.counts,
            application_graph_id: summary.application_graph_id,
            basis_counts: window.basis_counts,
          },
          facts: [
            `Evidence ${summary.evidence_id}.`,
            `Application graph ${summary.counts.nodes} nodes, ${summary.counts.edges} edges.`,
            `Parsed JavaScript files: ${summary.counts.files_parsed ?? "unknown"}; parse failures: ${summary.counts.parse_failures ?? "unknown"}.`,
          ],
          unknowns: coverageUnknowns(
            summary.graph_coverage,
            "Application graph",
          ),
        }),
      );
    } catch (error) {
      stages.push(
        stage("MAPPER", "summarizeEvidence", "failed", {
          facts: [error instanceof Error ? error.message : "Summary failed."],
        }),
      );
    }
  } else {
    stages.push(
      stage("MAPPER", "summarizeEvidence", "not-run", {
        unknowns: ["No retained static Evidence is selected."],
      }),
    );
  }

  const terms = questionSearchTerms(project.question);
  if (record && terms.length > 0 && summary) {
    const term = terms[0];
    const explored = exploreEvidence(record, { find: term, limit: 5 });
    const semantic = createSemanticEvidenceSearcher(record)({
      find: term,
      limit: 5,
    });
    stages.push(
      stage("TRACER", "exploreEvidence", "completed", {
        tool_call: {
          name: "exploreEvidence",
          arguments: { find: term, limit: 5, semantic_limit: 5 },
        },
        result: {
          term,
          application_matching: explored.matching,
          application_displayed: explored.displayed,
          semantic_matching: semantic.matching,
          edges: explored.edges.map((edge) => edge.edge_id),
        },
        facts: [
          `Term ${term}: ${explored.matching} application-graph relationships matched; showing ${explored.displayed}.`,
          ...traceFacts(explored),
          `Semantic graph matches: ${semantic.matching === null ? "unavailable" : semantic.matching}.`,
        ],
        unknowns: [
          explored.matching === 0
            ? "No application-graph match. That does not show the feature is absent."
            : "A match is a static relationship lead, not proof the path executed.",
        ],
      }),
    );
  } else {
    stages.push(
      stage("TRACER", "exploreEvidence", "not-run", {
        unknowns: [
          record
            ? "No search term was derived from the saved question."
            : "Tracing needs retained Evidence and a question.",
        ],
      }),
    );
  }

  if (summary) {
    const limitations = Array.isArray(summary.limitations)
      ? summary.limitations
          .filter((item) => typeof item === "string")
          .slice(0, 8)
      : [];
    stages.push(
      stage("ANALYST", "evidence-summary", "completed", {
        tool_call: {
          name: "summarizeEvidence",
          arguments: { fields: ["limitations", "semantic_coverage"] },
        },
        result: {
          limitations,
          semantic_coverage: summary.semantic_coverage ?? null,
        },
        facts: limitations.map((item) => `Limitation: ${item}`),
        unknowns: [
          ...coverageUnknowns(summary.semantic_coverage, "Semantic graph"),
          "Question-term search is lexical navigation, not an answer to the question.",
        ],
      }),
    );
  } else {
    stages.push(
      stage("ANALYST", "evidence-summary", "not-run", {
        unknowns: ["No summary is available to separate facts from gaps."],
      }),
    );
  }

  stages.push(
    diff
      ? stage("DIFF", "compare-summary-counts", "completed", {
          tool_call: {
            name: "compareRunSummaries",
            arguments: {
              left: diff.left?.evidence_id ?? null,
              right: diff.right?.evidence_id ?? null,
            },
          },
          result: {
            relationship_deltas: diff.relationship_deltas?.length ?? 0,
          },
          facts: [
            diff.note,
            `Relationship count deltas retained: ${diff.relationship_deltas?.length ?? 0}.`,
          ],
          unknowns: [
            "A count delta is not a behavioral explanation or an REA version-comparison verdict.",
          ],
        })
      : stage("DIFF", "compare-summary-counts", "not-run", {
          unknowns: ["Diff needs two completed static runs in this project."],
        }),
  );

  stages.push(
    experiment?.observation
      ? stage("VERIFIER", "owned-fixture-comparison", "completed", {
          tool_call: {
            name: "compareObservation",
            arguments: { query: experiment.observation.query },
          },
          result: {
            ids: experiment.observation.ids,
            matches: experiment.comparison.map((item) => ({
              hypothesis_id: item.hypothesis_id,
              matches: item.matches,
            })),
          },
          facts: [
            `Runtime capture ids: ${experiment.observation.ids.join(", ") || "(none)"}.`,
            experiment.separation,
          ],
          hypotheses: experiment.comparison.map(
            (item) =>
              `${item.hypothesis_id} ${item.matches ? "matched" : "did not match"} the capture. ${item.statement}`,
          ),
          unknowns: [experiment.engine_reassessment_reason],
        })
      : stage("VERIFIER", "owned-fixture-comparison", "not-run", {
          unknowns: [
            "No approved owned-fixture capture is stored. The verifier does not invent an outcome.",
          ],
        }),
  );

  const facts = stages.flatMap((item) =>
    item.facts.map((fact) => ({ stage: item.id, fact })),
  );
  const hypotheses = stages.flatMap((item) =>
    item.hypotheses.map((hypothesis) => ({ stage: item.id, hypothesis })),
  );
  const unknowns = stages.flatMap((item) =>
    item.unknowns.map((unknown) => ({ stage: item.id, unknown })),
  );
  stages.push(
    stage("REPORTER", "assemble-stage-records", "completed", {
      tool_call: {
        name: "assemble-stage-records",
        arguments: { stages: stages.length },
      },
      result: {
        fact_count: facts.length,
        hypothesis_count: hypotheses.length,
        unknown_count: unknowns.length,
      },
      facts: [`Assembled ${facts.length} facts from the stages above.`],
    }),
  );

  return {
    enabled: true,
    key_configured: keyConfigured,
    remote_calls: "refused",
    remote_reason: REMOTE,
    tool_calls: stages.filter((item) => item.tool_call).length,
    tool_call_budget: 8,
    stages,
    facts,
    hypotheses,
    unknowns,
  };
}
