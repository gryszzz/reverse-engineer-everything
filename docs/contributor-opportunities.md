# Contributor opportunities

These scoped tasks can help improve REE without needing to understand every
REA provider. They are proposal briefs for issues or pull requests; they are not
open GitHub issues.

## Good first contributions

### Verify first-run instructions on another supported host

Follow the root README from a clean checkout on Linux or Windows. Record the
Node/npm versions, exact commands, the first failure or confusing step, and the
result of the owned JavaScript example. Do not install providers or change host
configuration just to complete the check. Update only instructions supported by
the run, and say which host remains untested.

**Useful validation:** `node ree.mjs inspect experiments/rel-first-lab`, the
owned demo, and the relevant README consistency test.

### Add a focused question-to-Evidence fixture

Extend the small owned JavaScript fixture with a clearly named relationship and
cover a question term that finds it, a term that finds nothing, and a repeated
or Unicode term. Keep the output explicit that a match is a static graph lead
and a no-match does not prove absence.

**Useful validation:** `rel/analyze-static.test.mjs`,
`rel/evidence-explorer.test.mjs`, and the owned REE investigation workflow.

### Improve the Evidence Explorer's result explanations

Add source-grounded examples for relation state, confidence, authority, or
coverage so a new analyst can understand an edge without treating it as proof
of runtime execution. Use existing Evidence fields; do not infer missing
locations or create a parallel evidence format.

**Useful validation:** the saved Evidence Explorer tests and its README guide.

## Intermediate contributions

### Page large saved Evidence without repeating analysis

The standalone Evidence Explorer currently accepts files up to 64 MiB. Explore
the existing REA saved-file `inspect-analysis-view` route for larger records.
Preserve authenticated Evidence provenance, page bounds, and explicit
unknowns. Measure representative cold runs before claiming lower memory or
faster results.

### Qualify a second permitted application

Choose a source tree owned by the contributor or explicitly authorized for
static analysis. Record the classifier result, package/artifact identity,
analysis coverage, useful and misleading search hints, unresolved behavior,
and whether the report was understandable without help. Keep runtime testing
separate unless its scope is explicitly approved.

## Before opening an issue or pull request

Start from the user's concrete question and the existing REA route. Include the
smallest reproducible fixture and relevant command output, omit private target
data, and distinguish observed output from static deductions and unknowns. Follow
the repository's [contribution boundaries](../CONTRIBUTING.md#contribution-scope)
and [test guidance](testing.md).
