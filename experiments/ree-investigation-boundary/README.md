# REE investigation boundary fixture

This owned C fixture exercises a bounded differential investigation through
REA's real Process Capture, process comparison, and reconstruction verifier.
The authority multiplies a unit price by a quantity. The deliberately wrong
candidate rounds every product to a whole unit.

The harness first declares a finite input range and a hypothesis about
half-unit rounding. It enumerates only inputs matching that hypothesis, finds
a counterexample, then asks REA to capture and compare an agreeing integer
control and the discovered counterexample. It verifies that a terminal-only
control claim passes, the control's overall claim remains unknown, and both
counterexample claims fail. It uses the public CLI to draft four typed claims
from the exact comparison Evidence IDs and the explicitly selected `terminal`
and `overall` dimensions, then passes that specification to
`verify-reconstruction`.

Run after building the checkout with its pinned Node toolchain:

```sh
npm run build:cached
node scripts/verify/reconstruction/c-process-probe.mjs /tmp/ree-c-investigation
```

The output directory must be new. It contains scenarios, complete capture and
comparison Evidence, stderr progress logs, and a summary with source and binary
digests, the declared search domain, selected input, draft specification
Evidence, verifier Evidence, comparison IDs, and claim statuses. Its overall
verification result is expected to be `fail` because the
candidate is deliberately incorrect; the harness exits successfully only when
the terminal and overall counterexample claims fail and the control statuses
match expectations. The macOS smoke workflow retains this output as a
short-lived CI artifact.

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

This is a demonstration of evidence-derived specification drafting and
explicitly approved fixture probe execution, not an autonomous REA feature.
The human supplies the hypothesis, candidate input domain, probe rule,
comparison Evidence, dimensions to include, and approval flag. The drafter
validates exact selections and source closure; the verifier proposes only
bounded adjacent lexical values for eligible failed claims. Neither infers
missing claims, generates candidate implementations, nor establishes that the
domain is complete. Process capture also retains its normal limits for
inherited environment, unobserved filesystem changes, and sampled process trees.
