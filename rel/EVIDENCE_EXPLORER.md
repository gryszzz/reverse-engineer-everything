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
    node rel/evidence-explorer.mjs "$OUT/evidence.json" --semantic --find menu --limit 20
    node rel/evidence-explorer.mjs "$OUT/evidence.json" --json
    node rel/evidence-explorer.mjs "$OUT/evidence.json" --dot > "$OUT/relationships.dot"

DOT is Graphviz input, not a browser UI. If Graphviz is installed, render with:

    dot -Tsvg "$OUT/relationships.dot" -o "$OUT/relationships.svg"

**What is real:** by default, saved application-graph edges, identifiers, analyzer-returned source locations, confidence and relationship types. `--semantic` searches the separate saved JavaScript semantic graph and returns static syntax relationships with source locations, resolution state and their Evidence context.

**What is not proven:** runtime execution, semantic completeness, that every provider works, or digest validity independently of REA. Missing locations are displayed as not provided. Error payloads and mismatched graph identities are rejected; use REA's saved-file views when Evidence digest authentication is required.

The default reader follows REA's canonical `node_id`, `source_node_id`,
`target_node_id` and per-edge `evidence` fields. `--find` searches recorded
application-relationship values: node labels and IDs, relation, source location,
state, confidence, authority, coverage and limitations. `--semantic` selects
the semantic graph instead; its filter searches relation and endpoint labels,
IDs, resolution, source location, provenance and limitations. It does not search
source text, JSON property names, or every literal value. Semantic filters match
case-insensitive whole words, complete identifiers, and camel-case identifier
segments; each query word must occur somewhere in the recorded relation
metadata. This avoids matching `close` inside `closest`, while still letting
`menu` find `menuButton` and `menubutton` match the complete identifier. A
semantic match is a source-navigation lead, not a behavioral interpretation.
JSON output summarizes per-family unknown counts instead of
repeating every unknown ID; the full IDs remain in `evidence.json`. Complete
Evidence also retains unknowns that are not represented as relations, so an
empty search is not proof that a behavior or relationship is absent. JSON
output includes the edge or relation ID and relevant provenance. `--dot`
currently exports only the application graph.

The reader caps a JSON file at 64 MiB and limits displayed relationships to 40 per invocation; filtering does not mutate the underlying Evidence. Both views are read-only projections over JavaScript application Evidence. For larger records, start with the saved `view-evidence.json` and use the engine's `inspect-analysis-view` file references for module views within its memory limits.

Run regression tests:

    node --test rel/evidence-explorer.test.mjs

**Next:** expand provider-specific viewers after each one has real artifacts, tests and explainable provenance.
