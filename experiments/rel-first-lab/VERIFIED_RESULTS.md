# REL verified investigation — first full REA run

**Date:** 2026-10-13  
**REL fork revision:** `930379a8ba06ef6eb975ae00afea1f1d7c5a6c17`  
**Run:** [GitHub Actions #38435513091](https://github.com/gryszzz/Reverse-Engineering-Life-REL-/actions/runs/38435513091) — **successful**  
**Evidence artifact:** [rel-first-lab-evidence](https://github.com/gryszzz/Reverse-Engineering-Life-REL-/actions/runs/38435513091/artifacts/11833775254) (retained by GitHub for 7 days)

## What we ran

- The source-owned fictional search CLI and its 11-check verifier.
- `node scripts/rea.mjs analyze-javascript-application <absolute REL first-lab directory> --json`, using the **built fork's code**, not the published upstream npm package.
- REA's `inspect-analysis-view` on the full saved Evidence, producing a second Evidence record.
- Two REL reporting tests, including failure cases that prevent unsupported success claims.

**All the above completed successfully in the dedicated REL workflow.** No other repositories or services were inspected.

## Observed measurements

| Measurement                          | Result                                   |
| ------------------------------------ | ---------------------------------------- |
| Source JavaScript files parsed       | 7                                        |
| Parse failures                       | 0                                        |
| Application graph nodes / edges      | 43 / 65                                  |
| Edge relationships                   | 47 `imports`, 14 `contains`, 4 `exposes` |
| Application graph coverage           | `complete`, not truncated                |
| Semantic graph nodes / relationships | 1,460 / 1,149                            |
| Semantic graph explicit unknowns     | 475                                      |
| Semantic coverage status             | `unknown`                                |
| Real static analysis elapsed         | 1,973 ms on GitHub runner                |
| Full analyzer Evidence               | 2,466,492 bytes                          |
| REA projected view Evidence          | 10,154 bytes                             |
| REL human-readable report            | 1,984 bytes                              |

The `statistics.modules` field was `0`, but the graph contained `javascript-module` nodes. That statistic is **not** a count of all source files or all graph modules. The 47 import edges can represent several recovered relationships, not necessarily 47 unique package dependencies. `complete` structural coverage does **not** imply complete understanding: the semantic graph retains 475 explicit unknowns and its own coverage is `unknown`.

## One question answered with actual Evidence

**Question:** What connects the sample command-line app to the search code and its data?

REA reported high-confidence **static relationship inferences**, with actual source locations:

1. `cli.mjs`, line **1**, imports `./notes.mjs`; resolved path `notes.mjs`, `resolution_status: resolved`.
2. `cli.mjs`, line **2**, imports `./search.mjs`; resolved path `search.mjs`, `resolution_status: resolved`.

The corresponding Evidence edge locations are `source-range` values, with `state: inferred`, `confidence: high`, and `authority: static-relationship-inference`. They do **not** by themselves prove a runtime path executed. The separate search CLI verification establishes the sample's observed ordering.

## What this means in normal language

REA can scan our little program, identify its pieces, draw links between them, and back those links with the source line that produced the finding. When a conclusion is uncertain, the model has places to record that uncertainty rather than pretending every relationship is known.

**It has not yet reconstructed the search-ranking algorithm solely from observed program behavior**, nor has this one experiment validated third-party application reconstruction, native disassemblers, or automation. Those would require separate tests.

## Next quality and efficiency steps

1. Narrow the analysis target to the three sample application files (the current directory also contains our test/report tooling); measure evidence size and analysis time again.
2. Produce a _short, task-focused_ REL report containing the two relevant import edges and locations. The full Evidence should remain accessible separately, rather than flooding an agent's context with every semantic unknown.
3. Make a single controlled ranking change and compare two independently generated Evidence snapshots; check whether REA spots the real change and whether the result actually helps us understand it.

## CI qualification note

The **REL real-analysis workflow passed**, independently from the repository-wide CI. The broader CI static check failed at `oxfmt --check` and reported formatting differences in nine new/modified REL files plus two existing upstream files (`src/domain/functionComparison.test.ts`, `src/ida/IdaOperationRunner.ts`). This is a **separate merge blocker**; do not equate the successful experiment with a green full PR. Keep this PR as draft while we address only the changes we own and determine an appropriate upstream baseline strategy.

Evidence identifiers for this run: root artifact SHA-256 `a50cfc471f40dff5531e68d624d69d68478631c56b230cbd89fb6391403987b3`; application graph `jag_99fa8261e6bb9d23dfb7c81b07bdd1d49cccec3f824b46509595ff81834782d6`; Evidence `ev_9d8cf3f5b7d71ea84706174ef37e871287f0218bf3bdb63f5fca12b8d764f294`.
