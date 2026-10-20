# REE product readiness

REE should let a user supply software they are authorized to inspect, ask a
question, and follow a working investigation route to useful evidence. Broad
coverage means many verified routes. It does not mean guaranteed recovery of
original source or complete understanding of every artifact.

This is a proposed delivery sequence based on the current source, not a list of
implemented features. The initial platform remains macOS-first unless the user
selects a different priority. The inherited Linux and Windows workflows remain
part of the engine.

## Current position

| Area                          | Present implementation                                                                                          | Remaining readiness work                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Beginner entry point          | `ree.mjs doctor`, `types`, `inspect`, optional teaching lab, and static JavaScript/Electron analysis            | Validate the first-use route on a permitted application and make route hand-offs easier to follow                |
| Static application analysis   | Saved Evidence, compact views, readable reports, bounded question-term previews, feature traces and comparisons | Turn lexical leads into source-grounded findings without implying a question was answered automatically          |
| Native and specialist formats | REA provider contracts, CLI/MCP tools, format-specific guides and verification lanes                            | Verify tool availability and selected provider operation on each claimed platform                                |
| Runtime evidence              | Existing process capture and observation workflows with ownership and cleanup rules                             | Present target scope, prerequisites, capture results and remaining unknowns coherently                           |
| Hypothesis testing            | Finite prediction-table planner, CLI/MCP selection and reassessment, and bounded process probe workflows        | Connect the user's selected question, capture outcome and next probe through a documented investigation flow     |
| Reconstruction                | Finite claims, obligations, comparisons and bounded experimental synthesis                                      | Make scope and failed or unknown claims understandable in the investigation report                               |
| Distribution                  | Source checkout and local build; inherited release workflow is gated to `morluto/rea`                           | Select distinct npm/MCP identities, isolate install/update ownership, and qualify a clean package before release |

See [the engineering map](ree-engineering-map.md),
[Simple Mode](../rel/README.md), and [testing guidance](testing.md) for the
underlying implementation and verification boundaries.
See the [shared reconstruction report contract](reconstruction-reports.md) and
[independent distribution readiness](independent-distribution.md) for current
user-facing behavior and package blockers.

## Local verification snapshot — 2026-10-19

This development run used Linux x64, Node 24.19.0 and npm 11.9.0. Node is
supported by the engine, but this is not the pinned Node 24.18.0 / npm 11.16.0
release qualification.

- CLI/MCP parity and a real native-PTY process probe passed. The process test
  checks exact-plan approval, stale executable rejection, hypothesis narrowing
  and preservation of truncated capture coverage.
- Twenty-five focused planner, service, contract, example and effect tests passed.
- Type checking, lint, documentation and formatting checks passed. The test-discovery check found
  every test exactly once when the new regression files were added.
- The beginner demo parsed seven files with zero parse failures and returned
  47 graph nodes and 65 edges. Its Evidence ID was
  `ev_e4e52288b3498c4ae02c782c77575d8ae63e27a145d7c16c7144577bbbf0c446`.
- The command sandbox prevented reliable child-process output and some ownership
  inspection. The successful CLI/process and demo checks required the authorized
  execution environment with those restrictions lifted.

These checks do not establish external native-provider readiness, macOS/Windows
operation, complete reconstruction, or a passing full CI matrix. The hypothesis
planner and its CLI/MCP surfaces are implemented; question-led static Evidence
search guidance is a separate, lexical convenience and does not perform semantic
question answering. Consult GitHub Actions for subsequent remote qualification.

## Guided static route check — 2026-10-20

The first-user route now connects preview intake, explicit static authorization,
JavaScript/Electron analysis, retained Evidence, report limitations, and
question-term previews through the existing Evidence Explorer. Search terms are
bounded to five and report previews to three relationships per term. Each
preview retains its edge ID, source/target labels, source location, state,
confidence, and authority. A no-match result is explicitly not evidence of
absence; more matches can be opened with the exact generated CLI commands.

The route remains static-only: it does not launch the application, derive a
behavioral specification, or verify a reconstruction. The source-owned first
lab is the reproducible fixture. A second, permitted representative application
is still required before this route can be called independently qualified. A
checkout-owned project component can exercise the route but does not stand in
for an external contributor's application.

### Local verification details

- Host: macOS arm64. Node 24.12.0 and npm 11.15.0 were available. Node is
  within REA's supported range but is not the repository-pinned Node 24.18.0 /
  npm 11.16.0 pair. Dependencies and the runtime build were already present;
  this was not a clean-install test.
- Forty-three focused Node tests passed across intake, static reporting, Evidence
  Explorer, and the owned report fixture.
- The owned first lab analyzed seven JavaScript files with zero parse failures,
  49 graph nodes, and 67 edges. Its separate behavior verifier passed 11 checks.
  The suggested `search` lookup returned seven recorded relationships, including
  the `cli.mjs` to `search.mjs` import at `cli.mjs:2`.
- A second local analysis of REE's `rel/` source subtree parsed 13 JavaScript
  files with zero parse failures and returned 176 nodes and 259 edges. Its
  question suggested `evidence`; the saved-graph search found 55 relationships
  and the report previewed three with source lines, edge IDs, and Evidence
  metadata. This is a broad lexical lead, not an answer. The run retained 2,527
  semantic graph unknowns. It exercises REE code but is not an external
  representative application.
- On that 14,098,374-byte Evidence file, the complete static-analysis command
  took 3.98 seconds wall time (4.86 user, 0.35 system). macOS `time -l` reported
  335,478,784 bytes maximum RSS and 102,739,200 bytes peak memory footprint for
  the timed command. One saved-graph search took 0.08 seconds wall time (0.07
  user, 0.01 system), with 124,911,616 bytes maximum RSS and 97,004,032 bytes
  peak memory footprint. These are single after-change measurements, not a
  before/after comparison; process-family aggregation and agent token costs were
  not independently measured.

These runs confirm the owned end-to-end path and a larger in-repository source
tree. They do not satisfy the permitted external-application criterion, test a
clean install, establish behavior on Windows/Linux, or replace the latest hosted
CI result for this revision.

## First usable release

The first release should complete one investigation journey before expanding
its beginner-facing formats:

1. Open a target and identify its actual artifact family, retaining ambiguity.
2. Check prerequisites for the selected route and explain missing tools.
3. Ask the user's investigation question and select static or runtime actions
   explicitly. For JavaScript/Electron static analysis, derive literal search
   hints into retained Evidence; select a separate capture route only when
   runtime observations are needed and its authority is explicitly confirmed.
4. Run the selected engine workflow with progress, cancellation, bounded
   resources and retained diagnostics.
5. Show a concise explanation linked to files, locations and canonical Evidence.
   Current question-term search hints are not yet an explanation and require a
   person or agent to inspect matching source and Evidence.
6. Offer useful next actions: follow a relationship, inspect an unresolved area,
   compare another version, or design a discriminating experiment.
7. Save enough investigation state to resume without rerunning completed work.

The existing JavaScript/Electron route is the closest starting point. A native
workflow is a valid alternative priority if that is the user's primary target;
its release must include a real configured provider on the intended host.

### Acceptance criteria

- A new user can build or install REE using documented supported tooling and
  complete an investigation without editing internal scripts.
- A source-owned fixture and a representative permitted application both pass
  intake, analysis, report navigation and resumption checks.
- The report answers a concrete question and distinguishes observed facts,
  static deductions, inference, incomplete coverage and unsupported behavior.
- Missing providers, malformed input, cancellation, partial capture and failed
  cleanup produce actionable results with retained evidence and diagnostics.
- CLI and MCP expose consistent workflow semantics and current advertised schemas.
- The target remains unchanged for static routes; runtime routes use their
  explicit execution and ownership contracts.
- Memory, elapsed time and retained-data costs are recorded for representative
  small and large investigations. Agent costs are labeled measured or unmeasured.
- The selected platform's required checks and real-provider lanes pass. A
  source test, catalog entry or simulated provider does not satisfy this criterion.

## Expand coverage by verified route

Each family needs a complete journey and an evidence-backed support status.

| Family                                       | Existing route to reuse                                                          | Required release evidence                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| JavaScript / TypeScript / Electron           | Static application graph, views, traces, source-to-bundle and version comparison | Real source tree and ASAR investigations, unresolved semantics retained |
| ELF / PE / Mach-O                            | Selected Ghidra, Hopper or IDA workflow                                          | Real provider, target architecture, version, host and lifecycle checks  |
| Managed .NET                                 | Managed artifact, metadata and native-boundary workflows                         | Real assemblies and declared conformance boundaries                     |
| Android / Apple packages                     | Package inventory and platform-specific analysis                                 | Verified package formats, prerequisites and cross-layer evidence links  |
| WebAssembly                                  | Artifact inspection and interface comparison                                     | Real WABT/toolchain lane and representative modules                     |
| Firmware / raw binaries                      | Format identification and matching provider                                      | Real extraction/analysis lane with unsupported regions retained         |
| SQLite                                       | Read-only snapshot inspection                                                    | Supported Node runtime and representative snapshot verification         |
| Recorded network data / browser observations | Capture parsers and selected browser/runtime workflows                           | Real format/tool versions and explicit recording or observation scope   |

Support should distinguish **implemented**, **prerequisites available**, and
**verified on this host**. Failed or unsupported cases must identify the next
useful action. An unknown format must not silently select an arbitrary provider.

## Delivery order

1. Validate the question-guided static workflow on the owned fixture and a
   permitted representative application, recording friction and actual
   Evidence/source matches.
2. Improve the source-grounded finding step while preserving the distinction
   between search hits, static deductions, runtime observations, and unknowns.
3. Reuse REA's contracts, Evidence, views, comparisons and provider selection
   for the next bounded investigation route.
4. Add dependable resumption and evidence navigation, with measured large-target
   behavior and failure recovery.
5. Qualify additional artifact families one at a time against the same acceptance
   criteria. Publish exact platform/provider support with every release.
6. Establish a reproducible REE installation and release identity without
   overwriting upstream attribution or publishing as the upstream project.

A broader guided interface requires a reviewed design after the first target
family and platform are selected. Adding tool names alone does not complete the
user journey or establish universal reverse-engineering support.
