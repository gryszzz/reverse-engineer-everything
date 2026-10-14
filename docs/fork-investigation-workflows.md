# Building on REA in Reverse Engineering Everything

This fork builds on [morluto/rea](https://github.com/morluto/rea). Its useful
foundation is an investigation architecture: identified artifacts become
Evidence, and that Evidence can support explanation, comparisons, runtime
correlation and reconstruction checks. The upstream [README snapshot](../UPSTREAM_REA_README.md),
[architecture map](architecture.mermaid) and licensing remain intact.

## Where responsibilities belong

| Layer                          | Existing owner                                                       | What the fork should reuse                                                       |
| ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Artifact identity and analysis | `src/artifacts/`, provider adapters, `src/application/javascript/`   | Existing parsers, resource bounds and exact target identities                    |
| Facts and uncertainty          | `src/domain/evidence.ts`, `src/domain/evidenceBundle.ts`             | Authenticated records, coverage, provenance and explicit unknowns                |
| Retained investigations        | `src/application/investigation/EvidenceLedger.ts`                    | Immutable records, idempotent retention and unknown revisions                    |
| Selected answers               | `src/application/analysisView/`, `src/domain/analysisView/`          | Summaries, pages and exact items derived from parent Evidence                    |
| Connections and comparisons    | `src/application/javascript/JavaScriptApplicationWorkflowService.ts` | Existing feature traces, application comparisons and source-to-bundle comparison |
| Reconstruction claims          | `src/application/ReconstructionObligationLedgerService.ts`           | Explicit obligations and evidence of whether they are met                        |
| Interfaces                     | `src/cli/`, `src/server/`, `rel/`                                    | Shared engine behavior with interfaces appropriate to each user                  |

These are source-level observations, not certification that every provider works
on this Mac. The generated provider catalog describes supported routes; host
prerequisites and real-provider verification still determine availability.
Native analysis, Android, firmware and runtime capture have different dependencies
and effects. The REE beginner command currently runs static JavaScript directory
or ASAR analysis. Its format classifier is an intake aid, not an analyzer.

## A complete investigation should survive its first answer

The existing engine supports retaining original Evidence and deriving selected
views from it. That gives the fork a useful direction: help a person move from a
question to a reproducible finding and then to the experiment that could confirm
or refute it. A graph edge can explain a static relationship; its presence does
not establish execution. Comparisons and reconstruction obligations can build
on identified Evidence without treating an attractive diagram as proof.

The first refinement connects the existing CLI summary support to both
`rel analyze` and `rel demo --run`:

1. Run the analyzer once and save complete `evidence.json` atomically.
2. Receive a compact, identified `view-evidence.json` from that same process.
3. Generate the human report from that view, retaining parent and graph IDs,
   counts, coverage, limitations and remaining unknowns.
4. Inspect saved relationships or ask the engine for module pages/items.

The engine owns graph counts. The optional `graph_summary` field preserves
compatibility with older saved views. The REE presentation module lives in
`rel/evidence-summary.mjs`; the teaching report and explorer reuse it.
The demo shares the production static-analysis runner and requires fresh output,
so rerunning a lesson cannot overwrite a previous investigation.

## Findings established with actual execution

At baseline `6cdbed816fa021f9d162c0f006ed65b7bf92ab4f`, the REE analyzer wrote a
complete Evidence record, parsed it in the parent process, wrote another complete
copy inside a summary request, and launched a second engine process. Its report
also included long semantic unknown-ID arrays.

A local controlled fixture contained 30 ESM files, each importing the next file
and exporting 20 small functions. Complete Evidence was approximately 10.46 MB.
Both implementations returned parent Evidence
`ev_1254acf4622d02aa8ba5a92cc274ed5fd8638f2d72ab6b1bc80a3f3e35d9d121`.
The evidence contents, graph identities and analysis coverage were preserved.

Measurements on macOS 26.7.1 arm64 with Node 24.18.0 and npm 11.16.0:

| Measure                                   | Previous REE flow | Shared summary flow |
| ----------------------------------------- | ----------------: | ------------------: |
| Extra full-Evidence request copy          |  10,461,546 bytes |                None |
| Readable report                           |      99,278 bytes |         6,674 bytes |
| Estimated report tokens, tokenx 1.3.0     |            21,324 |               1,713 |
| Elapsed time, two controlled warm repeats |     5.94 / 4.98 s |       3.52 / 3.58 s |
| User + system CPU, same repeats           |     7.98 / 7.21 s |       4.90 / 4.84 s |
| Sampled peak process-family RSS           |     559 / 555 MiB |       566 / 563 MiB |

The warm comparison ran the baseline REE runner against the same revised engine,
then the new runner, twice in sequence without concurrent tests. CPU totals
include the `ps` sampling subprocesses. RSS samples used a 25 ms sleep between
process-tree reads and may miss short peaks. These are small local samples,
not a general performance guarantee. Cold caches were not measured. tokenx is
a heuristic estimate, not a model tokenizer. Peak memory did not improve;
engine analysis and saved-file validation remain memory-sensitive.

Actual Evidence also revealed that the explorer read guessed endpoint and
location field names. Its synthetic fixture reproduced those names, so the tests
passed while real edges displayed blank endpoints. The explorer now reads
`node_id`, `source_node_id`, `target_node_id`, node observations and per-edge
Evidence directly. A public CLI regression analyzes a two-module fixture and
checks displayed endpoints, source ranges, confidence and authority against the
saved engine record. The macOS lane now runs that regression as well, and both
REE workflows react to engine, build-script and dependency changes.

## Opportunities that need further experiments

- **Repository scope:** explicit dependency/generated-tree exclusions should
  reduce noise while retaining a reviewable exclusion manifest. Exact source
  selection currently leaves unselected material unknown and does not follow imports.
- **Saved investigation navigation:** the companion explorer still loads a full
  record and has a 64 MiB admission limit. Engine file references authenticate the
  full record; they are not an on-disk index. Larger investigations need measured
  storage and memory decisions before promising cheap random access.
- **Feature questions:** join the existing module views, bounded traces and
  version comparisons around concrete analyst questions before adding another
  generic command surface.
- **Reconstruction experiments:** use source-owned examples with independently
  specified expected behavior and the existing verification/obligation machinery.
  A successful reconstruction should state the tested equivalence boundary.
- **Provider readiness:** distinguish configured, discoverable and actually
  verified providers. A passing JavaScript lesson does not validate native,
  firmware or runtime integrations.

These opportunities follow from the inspected architecture and observed workflow
gaps. They are not claims of shipped features or a fixed development sequence.
