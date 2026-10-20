import { digestCanonicalValue } from "./canonicalDigest.js";
import { evidenceSchema } from "./evidence.js";
import { digestSchema, prefixedDigestSchema } from "./digests.js";
import { evidenceBundleSchema } from "./evidenceBundle.js";
import { reconstructionVerificationRequestSchema } from "./reconstructionVerificationSchemas.js";

import { z } from "zod";

const evidenceIdSchema = prefixedDigestSchema("ev");
const unknownIdSchema = prefixedDigestSchema("unk");
const statusSchema = z.enum(["pass", "fail", "unknown"]);
const sideSchema = z.enum(["left", "right"]);
const roleSchema = z.enum(["reference", "candidate"]);
const claimKindSchema = z.enum([
  "behavioral",
  "structural-function",
  "structural-artifact",
]);

const participantRolesSchema = z
  .strictObject({
    left: roleSchema,
    right: roleSchema,
  })
  .superRefine(({ left, right }, context) => {
    if (left === right)
      context.addIssue({
        code: "custom",
        message: "Comparison sides must have different participant roles",
      });
  });

/** Input to the reusable report projection; Evidence remains in the supplied bundle. */
export const reconstructionReportRequestSchema =
  reconstructionVerificationRequestSchema
    .extend({
      participant_roles: participantRolesSchema.optional(),
    })
    .strict();

const sourceArtifactIdentitySchema = z.strictObject({
  sha256: digestSchema,
  format: z.string().min(1),
  architecture: z.string().nullable(),
});

const processExecutableIdentitySchema = z.strictObject({
  selected_executable_sha256: digestSchema.nullable(),
  executable_sha256: digestSchema.nullable(),
  state: z.enum(["path_metadata_unchanged", "unknown"]),
  reason: z.string().nullable(),
});
const environmentSchema = z.strictObject({
  id: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  isolation: z.enum(["none", "process", "container", "virtual-machine"]),
});

const sourceSchema = z.strictObject({
  evidence_id: evidenceIdSchema,
  operation: z.string().min(1),
  provider: evidenceSchema.shape.provider,
  confidence: z.enum(["observed", "derived", "inferred"]),
  authority: z.enum([
    "shipped-artifact",
    "controlled-replay",
    "historical-reference",
    "external-service",
    "analyst-inference",
  ]),
  environment: environmentSchema.nullable(),
  identity_status: z.enum(["identified", "partial", "unknown"]),
  subject_identity: sourceArtifactIdentitySchema.nullable(),
  process_executable_identity: processExecutableIdentitySchema.nullable(),
});

const sideParticipantsSchema = z.strictObject({
  side: sideSchema,
  role: z.union([sideSchema, roleSchema]),
  sources: z.array(sourceSchema).min(1),
});

const reportClaimSchema = z.strictObject({
  claim_id: z.string().min(1),
  title: z.string().min(1),
  kind: claimKindSchema,
  dimension: z.string().min(1),
  status: statusSchema,
  observed_status: z.enum([
    "unchanged",
    "added",
    "removed",
    "changed",
    "truncated",
    "unknown",
    "contradiction",
  ]),
  comparison_evidence_id: evidenceIdSchema,
  participants: z.strictObject({
    left: sideParticipantsSchema,
    right: sideParticipantsSchema,
  }),
  evidence_links: z.array(evidenceIdSchema).min(2),
  unknown_ids: z.array(unknownIdSchema),
  limitations: z.array(z.string()),
});

const unresolvedUnknownSchema = z.strictObject({
  unknown_id: unknownIdSchema,
  revision: z.number().int().min(1),
  question: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  domain: z.string().min(1),
  status: z.enum([
    "open",
    "investigating",
    "blocked",
    "contradicted",
    "resolved",
  ]),
});

const reportSummarySchema = z.strictObject({
  total: z.number().int().min(1),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  unknown: z.number().int().min(0),
  behavioral: z.number().int().min(0),
  structural: z.number().int().min(0),
});

const reconstructionReportContentSchema = z.strictObject({
  report_type: z.literal("ree.reconstruction-report"),
  schema_version: z.literal(1),
  verification: z.strictObject({
    evidence_id: evidenceIdSchema,
    status: statusSchema,
    specification_sha256: digestSchema,
    summary: reportSummarySchema,
  }),
  claims: z.array(reportClaimSchema).min(1),
  unresolved_unknowns: z.array(unresolvedUnknownSchema),
  evidence_links: z.array(evidenceIdSchema).min(1),
  limitations: z.array(z.string()),
  scope_statement: z.literal(
    "Results apply only to the declared claims and retained Evidence; they do not establish global implementation equivalence.",
  ),
});

/** Stable, versioned projection over existing REA Evidence and verification results. */
export const reconstructionReportSchema = reconstructionReportContentSchema
  .extend({ report_sha256: digestSchema })
  .strict()
  .superRefine((report, context) => {
    const { report_sha256: actualDigest, ...content } = report;
    if (digestCanonicalValue(content, "Reconstruction report") !== actualDigest)
      context.addIssue({
        code: "custom",
        path: ["report_sha256"],
        message: "Report digest does not match the report content",
      });
  });

export const reconstructionReportResultSchema = z.strictObject({
  report: reconstructionReportSchema,
  verification_evidence: evidenceSchema,
});

export type ReconstructionReport = z.infer<typeof reconstructionReportSchema>;
export type ReconstructionReportResult = z.infer<
  typeof reconstructionReportResultSchema
>;
export type ReconstructionReportRole = z.infer<typeof roleSchema>;

/** Build the integrity digest without depending on JSON formatting or key order. */
export const reconstructionReportDigest = (
  content: z.infer<typeof reconstructionReportContentSchema>,
): string => digestCanonicalValue(content, "Reconstruction report");
