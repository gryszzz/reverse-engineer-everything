# Reconstruction reports

REE's reconstruction report is a versioned presentation of the existing REA
verification result and its Evidence closure. It does not create a second
Evidence store or replace the portable Evidence bundle.

## Build a report

The `build-reconstruction-report` CLI command accepts the same specification
and Evidence bundle as `verify-reconstruction`, plus optional participant
labels:

```sh
node scripts/rea.mjs build-reconstruction-report report-input.json --format json
```

The request has these fields:

- `specification`: the finite, explicit claims to verify;
- `evidence_bundle`: the authenticated comparison and source Evidence;
- `participant_roles` (optional): both sides labeled as `reference` and
  `candidate`. If omitted, the report keeps the established `left`/`right`
  names. It never guesses which side is the original implementation.

The response includes `report`, the canonical `verification_evidence` record,
and a Markdown rendering generated from that report. Save the response beside
the original Evidence bundle; the report contains Evidence IDs and artifact
identity summaries rather than copies of source records. Those IDs let an
analyst navigate back to the complete observations in the retained bundle.

## Contract and meaning

The machine-readable report uses `report_type: "ree.reconstruction-report"`
and `schema_version: 1`. It includes:

- deterministic claim outcomes and a SHA-256 digest of the report content;
- the verification Evidence ID and specification digest;
- comparison and source Evidence IDs for each claim;
- left/right participant roles, provider, authority, confidence, environment,
  and artifact identities when the source Evidence records them;
- process executable digests with separate selected and launch-identity fields;
- residual unknown questions and claim/report limitations.

The report omits local filesystem paths. A source may have an `unknown`
identity when its Evidence contains no artifact subject or process executable
identity. A process executable digest without an Evidence subject is marked
`partial`: a prelaunch file sample does not prove the operating system's
atomic executable-image binding. `pass`, `fail`, and `unknown` are inherited from the existing
verification workflow. Missing Evidence closure is rejected; incomplete or
unobserved behavior remains unknown. A passing report covers only its declared
claims and retained Evidence. It does not establish global equivalence.

The Markdown view is derived from the versioned JSON report, so it cannot
silently disagree with the machine-readable outcomes. Its Evidence IDs resolve
against the retained bundle; the report does not duplicate raw observations.
It summarizes each comparison's observed status. For exact terminal text,
structural deltas, or other comparison details, open the cited comparison and
source Evidence records in that bundle.

## Reproducible owned example

From the repository root, with the pinned Node/npm toolchain, repository
dependencies, and Clang available:

```sh
npm ci
npm run verify:ree-investigation-boundary -- /tmp/ree-c-investigation
```

The owned C fixture writes both `reconstruction-report.json` and
`REE_RECONSTRUCTION_REPORT.md`, alongside the original bundle components,
`verification.evidence.json`, and `summary.json`. The report intentionally
shows a failure because the starting candidate is incorrect: the fixture's
successful exit means the matching control and counterexample were verified as
expected. The half-unit inputs are evidence for those bounded cases, not a
proof of universal equivalence.

The shared report contract also accepts the inherited verifier's structural
function and artifact claims. Those report shapes are covered by the same
contract tests; the C command is the current end-to-end example that writes
the JSON and Markdown artifacts to disk.
