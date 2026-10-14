# REE First Lab — investigate a tiny note search

This is **fictional, offline, source-owned JavaScript**. Three small production modules demonstrate a search CLI, test data, and ranking. The demo uses no network, accounts, browser, native provider, external targets, or filesystem writes.

Run commands from the **repository root**. Basic steps need Node.js only. The optional full-REA step needs the toolchain from .nvmrc/package.json, dependency installation, and a build.

## A. Observe before reading source

```bash
node experiments/rel-first-lab/cli.mjs bridge
node experiments/rel-first-lab/cli.mjs SIGNAL
node experiments/rel-first-lab/cli.mjs observability
node experiments/rel-first-lab/cli.mjs --help
```

Ask: why does **Bridge Patterns** outrank **Signal Bridge**? Why does **Local Cache** appear when its title lacks "bridge"? Does case or extra whitespace matter? Write down the **actual output**, not what you assume happens.

## B. Verify

```bash
node experiments/rel-first-lab/verify.mjs
```

Expected: **REE first lab: 11 checks passed.** This verifies the sample's search behavior, preservation of source data, and selected CLI success/error behavior. It does **not** test the REA engine or MCP server.

## C. Explain the result from source

Follow the imports from [cli.mjs](cli.mjs) to [notes.mjs](notes.mjs) and [search.mjs](search.mjs). The ranking rule rewards an exact title match, title prefix, title substring, and tag match in that order. It then alphabetizes equal-ranked matches.

- **Observed**: the CLI printed a specific order on the machine where you ran it.
- **Source-backed**: rank() and sort() explain the intended ordering.
- **Unverified**: an unrelated application, all runtime environments, or an untested released binary behaves the same.

Write the explanation and its limitations in [WORKSHEET.md](WORKSHEET.md).

## D. Optional: inspect the folder with the **local fork's** REA

Use the pinned Node/npm environment. Installing project dependencies requires network access; the later static-analysis command works on local source and does not execute the demo.

```bash
# If nvm is already installed, first run: nvm use
npm ci
npm run build:cached
```

On macOS/Linux, place generated Evidence in a temporary directory, not in Git:

```bash
OUT="$(mktemp -d)"
node scripts/rea.mjs analyze-javascript-application "$PWD/experiments/rel-first-lab" \
  --summary --evidence-out "$OUT/evidence.json" --json > "$OUT/view-evidence.json"
```

The command saves complete Evidence once and emits a compact, identified summary.
Read the overview with `cat "$OUT/view-evidence.json"`. For a saved-file module
page without repeating analysis:

```bash
node -e 'console.log(JSON.stringify({source:{kind:"evidence-file",path:process.argv[1]},view:{kind:"page",collection:"modules",offset:0,limit:10}}))' "$OUT/evidence.json" > "$OUT/modules-request.json"
node scripts/rea.mjs inspect-analysis-view "$OUT/modules-request.json" --json
```

Large apps can produce very large Evidence files; pass summaries to an agent and preserve the original Evidence for drill-down. CLI behavior is documented in [docs/cli.md](../../docs/cli.md), with graph semantics in [docs/javascript-application-workflows.md](../../docs/javascript-application-workflows.md).

The real analyzer runner and CI lane exercise this workflow on the owned sample; see [REAL_ANALYZER.md](REAL_ANALYZER.md) for commands and the boundaries of that verification.

## What comes next

After completing the worksheet, make a **second revision of this same sample** with one deliberate search-ranking change. Then learn to compare two local graph versions without analyzing another product.
