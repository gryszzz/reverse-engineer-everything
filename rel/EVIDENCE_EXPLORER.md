# REE Evidence Explorer

**Go beyond the teaching animation.** This command reads an existing, saved REA JavaScript application Evidence record. It does not run an unknown program or download anything.

Run real analysis first, on REE's owned lab:

    npm ci
    npm run build:cached
    OUT="$(mktemp -d)/investigation"
    node ree.mjs demo --run --out "$OUT"

Read a real saved graph, filtering by source file:

    node rel/evidence-explorer.mjs "$OUT/evidence.json"
    node rel/evidence-explorer.mjs "$OUT/evidence.json" --find search.mjs --limit 20
    node rel/evidence-explorer.mjs "$OUT/evidence.json" --json
    node rel/evidence-explorer.mjs "$OUT/evidence.json" --dot > "$OUT/relationships.dot"

DOT is Graphviz input, not a browser UI. If Graphviz is installed, render with:

    dot -Tsvg "$OUT/relationships.dot" -o "$OUT/relationships.svg"

**What is real:** saved application graph edges, identifiers, any analyzer-returned source locations, confidence and relationship types.

**What is not proven:** runtime execution, semantic completeness, that every provider works, or digest validity independently of REA. Missing locations are displayed as not provided. Error payloads and mismatched graph identities are rejected; use REA's saved-file views when Evidence digest authentication is required.

The reader follows REA's canonical `node_id`, `source_node_id`, `target_node_id`
and per-edge `evidence` fields. Labels come from recorded node identities or
observations; JSON output includes the edge ID, coverage and limitations.
Multiple observed labels are preserved.

The reader caps a JSON file at 64 MiB and limits displayed relationships to 40 per invocation; filtering does not mutate the underlying Evidence. Only JavaScript application graphs are supported by this companion tool today. For larger records, start with the saved `view-evidence.json` and use the engine's `inspect-analysis-view` file references for module views within its memory limits.

Run regression tests:

    node --test rel/evidence-explorer.test.mjs

**Next:** expand provider-specific viewers after each one has real artifacts, tests and explainable provenance.
