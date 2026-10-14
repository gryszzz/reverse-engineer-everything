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
counterexample claims fail.

Run after building the checkout with its pinned Node toolchain:

```sh
npm run build:cached
node scripts/verify/reconstruction/c-process-probe.mjs /tmp/ree-c-investigation
```

The output directory must be new. It contains scenarios, complete capture and
comparison Evidence, stderr progress logs, and a summary with source and binary
digests, the declared search domain, selected input, Evidence IDs, and claim
statuses. Its overall verification result is expected to be `fail` because the
candidate is deliberately incorrect; the harness exits successfully only when
the terminal and overall counterexample claims fail and the control statuses
match expectations. The macOS smoke workflow retains this output as a
short-lived CI artifact.

This is a demonstration of an investigation loop, not an autonomous REA feature.
The human supplies the hypothesis, the candidate input domain, and the rule for
selecting a probe. Enumeration can expose a counterexample within that bounded
domain; it cannot show that the domain is complete or establish general
equivalence. Process capture also retains its normal limits for inherited
environment, unobserved filesystem changes, and sampled process trees.
