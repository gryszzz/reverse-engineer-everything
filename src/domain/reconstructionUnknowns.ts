import { uniqueSorted } from "./canonicalOrdering.js";
import {
  compareUnicodeCodePoints,
  compositeKey,
} from "./unicodeCodePointOrder.js";
import type {
  ReconstructionClaim,
  ReconstructionClaimResult,
  ReconstructionVerificationResult,
} from "./reconstructionVerificationSchemas.js";
import type { Evidence } from "./evidence.js";
import { parseProcessCapture } from "./process/processCaptureParsing.js";
import { processCaptureComparisonSchema } from "./process/processComparison.js";
import type { ResidualUnknown } from "./residualUnknown.js";

/** Select the latest revision of each residual unknown. */
export const reconstructionUnknownHeads = (
  revisions: readonly ResidualUnknown[],
): ReadonlyMap<string, ResidualUnknown> => {
  const heads = new Map<string, ResidualUnknown>();
  for (const item of revisions) {
    const current = heads.get(item.unknown_id);
    if (current === undefined || current.revision < item.revision)
      heads.set(item.unknown_id, item);
  }
  return heads;
};

/** Find active unknowns that affect a comparison or one of its sources. */
export const reconstructionClaimUnknowns = (
  heads: ReadonlyMap<string, ResidualUnknown>,
  comparisonId: string,
  sourceIds: readonly string[],
  dimension?: string,
): ResidualUnknown[] => {
  const appliesToClaim = (item: ResidualUnknown): boolean => {
    const scope = item.comparison_conclusion_scope;
    return (
      scope === undefined ||
      (scope.comparison_evidence_id === comparisonId &&
        (dimension === undefined ||
          scope.dimensions.some(
            (scopedDimension) => scopedDimension === dimension,
          )))
    );
  };
  const evidenceIds = new Set([comparisonId, ...sourceIds]);
  const relevantIds = new Set(
    [...heads.values()]
      .filter(
        (item) =>
          item.status !== "resolved" &&
          appliesToClaim(item) &&
          [
            ...item.supporting_evidence_ids,
            ...item.contradicting_evidence_ids,
          ].some((id) => evidenceIds.has(id)),
      )
      .map(({ unknown_id: id }) => id),
  );
  const pending = [...relevantIds];
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (currentId === undefined) continue;
    const current = heads.get(currentId);
    if (current === undefined) continue;
    for (const relationship of current.relationships) {
      if (relationship.type === "related-to") continue;
      const dependency = heads.get(relationship.unknown_id);
      if (
        dependency === undefined ||
        dependency.status === "resolved" ||
        relevantIds.has(dependency.unknown_id)
      )
        continue;
      relevantIds.add(dependency.unknown_id);
      pending.push(dependency.unknown_id);
    }
  }
  return [...relevantIds]
    .flatMap((id) => {
      const unknown = heads.get(id);
      return unknown === undefined ? [] : [unknown];
    })
    .sort((left, right) =>
      compareUnicodeCodePoints(left.unknown_id, right.unknown_id),
    );
};

/** Aggregate deterministic probes for unresolved claims. */
export const reconstructionProbes = (
  results: readonly ReconstructionClaimResult[],
  heads: ReadonlyMap<string, ResidualUnknown>,
  records: ReadonlyMap<string, Evidence>,
): ReconstructionVerificationResult["recommended_probes"] => {
  type Probe = ReconstructionVerificationResult["recommended_probes"][number];
  const output = new Map<string, Probe>();
  for (const result of results.filter(({ status }) => status === "unknown")) {
    const unknowns = result.unknown_ids.flatMap((id) => {
      const item = heads.get(id);
      return item === undefined ? [] : [item];
    });
    const probes = unknowns.flatMap(({ recommended_probes: items }) => items);
    const candidates = probes.length > 0 ? probes : [defaultProbe(result.kind)];
    for (const probe of candidates) {
      const key = compositeKey([probe.operation, probe.rationale]);
      const current = output.get(key) ?? {
        ...probe,
        claim_ids: [],
        unknown_ids: [],
      };
      current.claim_ids = uniqueSorted([...current.claim_ids, result.claim_id]);
      current.unknown_ids = uniqueSorted([
        ...current.unknown_ids,
        ...result.unknown_ids,
      ]);
      output.set(key, current);
    }
  }
  for (const result of results) {
    if (
      result.status !== "fail" ||
      result.kind !== "behavioral" ||
      result.dimension !== "terminal" ||
      result.observed_status !== "changed"
    )
      continue;
    const comparison = records.get(result.comparison_evidence_id);
    if (comparison === undefined) continue;
    const compared = processCaptureComparisonSchema.safeParse(
      comparison.normalized_result,
    );
    if (
      !compared.success ||
      compared.data.first_divergence.status !== "found" ||
      compared.data.first_divergence.dimension !== "terminal"
    )
      continue;
    const leftId = result.left_evidence_ids[0];
    const rightId = result.right_evidence_ids[0];
    if (
      leftId === undefined ||
      rightId === undefined ||
      result.left_evidence_ids.length !== 1 ||
      result.right_evidence_ids.length !== 1
    )
      continue;
    const leftEvidence = records.get(leftId);
    const rightEvidence = records.get(rightId);
    if (
      leftEvidence?.operation !== "capture_process_scenario" ||
      rightEvidence?.operation !== "capture_process_scenario" ||
      leftEvidence.predicate_type !== "rea.process-capture" ||
      rightEvidence.predicate_type !== "rea.process-capture"
    )
      continue;
    const leftCapture = parseProcessCapture(leftEvidence.normalized_result);
    const rightCapture = parseProcessCapture(rightEvidence.normalized_result);
    const leftArguments = readArguments(leftCapture.manifest.scenario);
    const rightArguments = readArguments(rightCapture.manifest.scenario);
    if (
      leftArguments === undefined ||
      rightArguments === undefined ||
      leftArguments.length !== rightArguments.length ||
      leftArguments.some((value, index) => value !== rightArguments[index])
    )
      continue;
    const argumentVariations = leftArguments.flatMap((value, argumentIndex) => {
      const candidateValues = decimalNeighbors(value);
      return candidateValues === undefined
        ? []
        : [
            {
              left_source_evidence_id: leftId,
              right_source_evidence_id: rightId,
              argument_index: argumentIndex,
              observed_value: value,
              candidate_values: candidateValues,
            },
          ];
    });
    if (argumentVariations.length === 0) continue;
    const key = compositeKey([
      "capture_process_scenario",
      result.comparison_evidence_id,
      "adjacent-decimal-arguments",
    ]);
    output.set(key, {
      operation: "capture_process_scenario",
      rationale:
        `Terminal output diverged for comparison ${result.comparison_evidence_id}. ` +
        "Repeat both recorded process scenarios with one numeric argument changed at a time to each adjacent decimal value; these are candidate probes, not assertions that the values are valid for the target.",
      claim_ids: [result.claim_id],
      unknown_ids: [],
      evidence_links: uniqueSorted([
        result.comparison_evidence_id,
        leftId,
        rightId,
      ]),
      argument_variations: argumentVariations,
    });
  }
  const sorted = [...output.values()].sort((left, right) =>
    compareUnicodeCodePoints(
      compositeKey([left.operation, left.rationale]),
      compositeKey([right.operation, right.rationale]),
    ),
  );
  return sorted;
};

const readArguments = (
  scenario: Readonly<Record<string, unknown>>,
): string[] | undefined => {
  const arguments_ = scenario.arguments;
  return Array.isArray(arguments_) &&
    arguments_.every(
      (argument): argument is string => typeof argument === "string",
    )
    ? arguments_
    : undefined;
};

/** Return adjacent values at the least-significant written decimal place. */
const decimalNeighbors = (value: string): [string, string] | undefined => {
  if (value.length > 64) return undefined;
  const match =
    /^(?<sign>-?)(?<whole>0|[1-9][0-9]*)(?:\.(?<fraction>[0-9]+))?$/u.exec(
      value,
    );
  const whole = match?.groups?.whole;
  if (match === null || whole === undefined) return undefined;
  const fraction = match.groups?.fraction ?? "";
  const magnitude = BigInt(`${whole}${fraction}`);
  const signed = match.groups?.sign === "-" ? -magnitude : magnitude;
  return [
    formatScaled(signed - 1n, fraction.length),
    formatScaled(signed + 1n, fraction.length),
  ];
};

const formatScaled = (value: bigint, fractionalDigits: number): string => {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(fractionalDigits + 1, "0");
  if (fractionalDigits === 0) return `${negative ? "-" : ""}${digits}`;
  const split = digits.length - fractionalDigits;
  return `${negative ? "-" : ""}${digits.slice(0, split)}.${digits.slice(split)}`;
};

const defaultProbe = (
  kind: ReconstructionClaim["kind"],
): { operation: string; rationale: string } =>
  kind === "behavioral"
    ? {
        operation: "capture_process_scenario",
        rationale: "Repeat both scenarios under one controlled environment.",
      }
    : kind === "structural-function"
      ? {
          operation: "analyze_function",
          rationale: "Capture complete function dossiers under equal limits.",
        }
      : {
          operation: "inspect_artifact",
          rationale:
            "Capture complete artifact inventories under equal limits.",
        };
