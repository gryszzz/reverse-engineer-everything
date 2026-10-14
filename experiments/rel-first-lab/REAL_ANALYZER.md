# Phase 2 — Make REA analyze our own first lab

This is a **verification recipe**, not a claim that the full REA engine has already passed. It stays exclusively inside this fork's fictional sample. No other repositories, sites, deployed software, or user accounts are targets.

## What we will prove

1. **Behavior:** the small Node.js search app returns the expected ordering (sample verifier and CLI observation).
2. **Static understanding:** the fork's locally built REA CLI parses that same directory and emits a saved, identified application Evidence record.
3. **Usable output:** REA's own `inspect-analysis-view` command creates a second, much smaller summary Evidence record from the saved analysis.
4. **Honest limits:** the readable report records graph counts, source identifiers, coverage and unknowns. Import relationships are static observations/inferences—not evidence that a search ran.

The built-in `report.mjs` rejects absent, mismatched, and error-shaped Evidence instead of manufacturing a green result. It does **not** independently validate REA's complete digest algorithms or reconstruction accuracy.

## Path A — automatic fork-only GitHub proof

The workflow is [`.github/workflows/rel-first-lab.yml`](../../.github/workflows/rel-first-lab.yml). On a pull request targeting `main`, or by manual **Actions → REE first real analysis → Run workflow**, it:

- Checks out this REE fork and uses its pinned Node version.
- Runs `npm ci`, builds **this fork**, tests our reporter and executes our fictional example.
- Runs the real static JavaScript analyzer, saves full Evidence, and asks REA to project a summary view.
- Publishes a readable job summary and a 7-day `rel-first-lab-evidence` artifact, including logs, Evidence, and `summary.json`.

Forks may have GitHub Actions disabled by default. **No workflow-run history means no CI verification yet**. Enable Actions in the fork's GitHub Actions tab if needed. No secrets or paid remote services are configured by this workflow, although normal GitHub Actions usage quotas may apply.

## Path B — run locally on a computer

Use the Node toolchain pinned by `.nvmrc` and the npm lockfile. From the repository root:

```bash
npm ci
npm run build:cached
node --test experiments/rel-first-lab/report.test.mjs
OUT="$(mktemp -d)/investigation"
node experiments/rel-first-lab/run-real-analysis.mjs "$OUT"
cat "$OUT/REE_EVIDENCE_REPORT.md"
```

The command intentionally refuses to run if the built CLI is absent. Its output directory **must be outside the repository**. Native disassemblers, browser automation, environment-wide `rea setup`, and MCP configuration are not required.

## How to read the resulting files

| File                     | Interpretation                                                          |
| ------------------------ | ----------------------------------------------------------------------- |
| `observed-search.txt`    | Concrete runtime behavior of the _toy search app_                       |
| `lab-verification.txt`   | Our test output; not a REA engine test                                  |
| `evidence.json`          | Full static-analysis Evidence produced by REA; retain for reinspection  |
| `view-evidence.json`     | Second Evidence record produced by REA's compact analysis-view workflow |
| `summary.json`           | REE's bounded count-and-identity projection, plus durations             |
| `REE_EVIDENCE_REPORT.md` | Human-readable learning report with explicit unknowns                   |
| `*.stderr.txt`           | Logs and diagnostics for failed/partial steps                           |

If a command fails, **do not** treat a partially written Evidence file or summary as passing proof. The workflow must finish successfully, with both Evidence operations checked.

## Learning questions to answer with actual Evidence

- Are `cli.mjs`, `search.mjs` and `notes.mjs` represented by graph nodes? What exact recorded paths or source locations establish that?
- Is the `cli.mjs` → `search.mjs` dependency backed by an `imports` edge, or is there only a weaker candidate/unknown?
- Does the analyzer identify **ranking behavior**, or only the function/module structure? What claim could we _not_ make from this alone?
- What did the analysis cost in elapsed time and Evidence size, versus what useful explanation we gained?

After that proof, we can make **one** controlled change to this same fictional search example and measure whether REA detects it. That is the start of improving REE based on evidence instead of adding features speculatively.
