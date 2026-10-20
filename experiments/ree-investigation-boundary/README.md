# REE investigation boundary fixture

This owned C fixture exercises a bounded differential investigation through
REA's real Process Capture, process comparison, and reconstruction verifier.
The authority multiplies a unit price by a quantity. The deliberately wrong
candidate rounds every product to a whole unit.

The harness first declares a finite input range and a hypothesis about
half-unit rounding. It enumerates only inputs matching that hypothesis, finds
a counterexample, then asks REA to capture and compare an agreeing integer
control and the discovered counterexample. The current workflow drafts two
typed claims from the exact comparison Evidence IDs, selecting only the
`terminal` dimension. The control claim passes and the counterexample claim
fails; the process-level `overall` comparison remains unknown and is not
included as a claim. This keeps the reconstruction statement within the
observed terminal behavior.

Run after building the checkout with its pinned Node toolchain:

```sh
npm run build:cached
node scripts/verify/reconstruction/c-process-probe.mjs /tmp/ree-c-investigation
```

The output directory must be new. It contains scenarios, complete capture and
comparison Evidence, stderr progress logs, a machine-readable summary, and
`REE_RECONSTRUCTION_REPORT.md`. The report presents the observed control and
counterexample, claim statuses, Evidence IDs, source and binary digests, and
limits in a reviewable format. Its overall verification result is expected to
be `fail` because the
candidate is deliberately incorrect; the harness exits successfully only when
the terminal counterexample claim fails and the control claim passes as
expected. The macOS smoke workflow retains this output as a
short-lived CI artifact.

The report is specific to this fixture. It demonstrates a readable projection
over existing reconstruction Evidence; it does not establish a shared report
contract for every provider or reconstruction workflow.

The normal command never executes a verifier recommendation. To explicitly
approve one bounded follow-up against the freshly built project-owned C
fixtures, run:

```sh
npm run verify:ree-investigation-boundary -- --approve-recommended-probes
```

This opt-in selects only the first candidate value of the first eligible
recommendation. Before execution, the harness checks the recommendation's
Evidence links, the source capture identities and binary digests, matching
argument vectors, the exact argument index/value, and fixture-only working
directory and environment constraints. Its fixed budget is one variation, two
process captures, and one comparison. It saves the approval record and new
capture Evidence without replacing the original records, compares the new
captures through the public CLI, adds all original and new records to a
portable Evidence bundle, derives a follow-up specification, and verifies it.
This is an owned-fixture experiment harness, not a general target executor.

The finite-trace comparison constrains exact raw terminal output and rendered
screen content, while treating their capture order as unordered. On macOS,
process lifecycle journal order can vary even when terminal evidence matches,
so the fixture does not claim lifecycle equivalence. That broader claim
remains unknown.

The optional source-blind expression and active-hypothesis modes extend this
fixture with a bounded synthesis experiment. The planner ranks inputs within a
declared arithmetic grammar; a separate proposer fits an expression to captured
input/output pairs; explicit plan and patch digests gate execution and patch
application. The complete three-run procedure and generated artifacts are
documented in the [CLI reconstruction walkthrough](../../docs/cli.md#active-hypothesis-discrimination).

These modes remain fixture experiments. The input domain and grammar are
bounded, and the reference source remains in the repository even though its
expression is excluded from the proposer inputs. Passing the selected terminal
cases does not establish behavior outside those cases. Process capture also
retains its normal limits for inherited environment, unobserved filesystem
changes, and sampled process trees.
