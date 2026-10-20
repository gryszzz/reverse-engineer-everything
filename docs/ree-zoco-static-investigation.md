# REE real-application investigation: ZoCo mobile navigation

This is a reproducible static investigation of an owner-maintained application,
using REE's documented intake, analysis, question-led Evidence review, and
reporting path. It tests whether the first-user workflow can help someone find
relevant source without claiming that static analysis proves browser behavior.

## Scope and exact target

- Target: [`gryszzz/ZoCo-Web`](https://github.com/gryszzz/ZoCo-Web), public `main`
  at commit [`79feacf`](https://github.com/gryszzz/ZoCo-Web/commit/79feacf86c107ae5c09d5772f95801fc0e9b01bd),
  resolved on 2026-10-20.
- The earlier local checkout was clean at `ba97a53`, but behind the remote. The
  investigation used an isolated clone of the current remote commit; it did not
  update that older checkout.
- Question: **How does the mobile navigation menu open, close, and update its
  accessibility state?**
- Authority: read-only source analysis. REE did not run ZoCo, fetch its deployed
  website, use a browser, or modify the target. The analyzer read source files
  as data; manual source review confirmed the reported leads.
- REE baseline: `2f58bb238633edb8eb6b04e0c60203a8ea056983`. The semantic-search
  refinements documented below were local changes under verification when this
  investigation was run.

## Reproduce the workflow

Run these commands from the REE checkout root. `TARGET` should be a local,
authorized copy of the repository. The output path must be new, with an
existing parent, and outside both repositories.

```sh
npm ci
npm run build:cached

TARGET=/absolute/path/to/ZoCo-Web
QUESTION="How does the mobile navigation menu open, close, and update its accessibility state?"
node ree.mjs inspect "$TARGET" --question "$QUESTION"

OUT="$(mktemp -d)/zoco-navigation"
node ree.mjs analyze "$TARGET" --authorized --out "$OUT" --question "$QUESTION"
cat "$OUT/REE_EVIDENCE_REPORT.md"
node rel/evidence-explorer.mjs "$OUT/evidence.json" --semantic --find menu --limit 20
```

`inspect` classifies the target without analyzing it. `analyze --authorized`
runs the existing JavaScript static-analysis route; it does not launch the
website. The result retains the complete `evidence.json`, compact `summary.json`
and `view-evidence.json`, and a readable Markdown report. Semantic queries are
source-navigation leads. They do not answer the question automatically.

## What source review established

ZoCo uses two related menu patterns in a shared controller:

| Page family    | Open and close behavior                                                                                                                                                           | Accessibility state in source                                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Homepage       | The menu button toggles `.open`; selecting a nav link, pointering outside the header, pressing Escape, or widening beyond 1100 px closes it. Escape restores focus to the button. | The button starts with `aria-expanded="false"`, `aria-label="Open navigation menu"`, and `aria-controls="site-mobile-nav"`. The controller updates `aria-expanded`, the label, and visible button text as it toggles.                             |
| Interior pages | The menu uses `<details>/<summary>`. Nav links, outside pointer input, Escape, and widening beyond 1170 px close it. Escape restores focus to the summary.                        | The controller reads and writes `details.open`, and CSS styles `[open]`. These pages use a `summary` named “Menu” and a labeled mobile `nav`; the inspected markup has no explicit `aria-expanded` or `aria-controls` attributes on this control. |

The shared controller also synchronizes a body class for the backdrop and scroll
lock. The CSS shows the homepage menu when `.open` is set, styles the interior
menu from the native `[open]` attribute, and applies separate responsive
breakpoints. These are source facts; computed styles, actual keyboard behavior,
and assistive-technology announcements were not tested.

The main source references are pinned to the inspected commit: [shared
controller](https://github.com/gryszzz/ZoCo-Web/blob/79feacf86c107ae5c09d5772f95801fc0e9b01bd/mobile-nav-glass-20261012.js#L12-L65),
[homepage markup](https://github.com/gryszzz/ZoCo-Web/blob/79feacf86c107ae5c09d5772f95801fc0e9b01bd/index.html#L279-L297),
[interior markup in service-area](https://github.com/gryszzz/ZoCo-Web/blob/79feacf86c107ae5c09d5772f95801fc0e9b01bd/service-area/index.html#L85-L98),
[homepage responsive rules](https://github.com/gryszzz/ZoCo-Web/blob/79feacf86c107ae5c09d5772f95801fc0e9b01bd/mobile-nav-glass-20261012.css#L119-L184),
and [scroll-lock/backdrop rules](https://github.com/gryszzz/ZoCo-Web/blob/79feacf86c107ae5c09d5772f95801fc0e9b01bd/mobile-nav-glass-20261012.css#L8-L20).

## What REE found, and where it fell short

The final run parsed 6 JavaScript files with 0 parse failures and reported an
application graph of 37 nodes and 68 relationships. Application-graph coverage
was partial and not truncated. The separate semantic graph contained 1,382
nodes and 1,141 relationships; its coverage status was unknown, with 473
family-level unknowns. The report kept that uncertainty visible.

| Question term | Application graph matches | Semantic graph matches | What the preview was useful for                                                                                                                            |
| ------------- | ------------------------: | ---------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mobile`      |                        14 |                    234 | Located pages that load the shared controller and relations from its source file. The semantic count is broad because many relations share that file path. |
| `navigation`  |                         0 |                      0 | No recorded relation matched this term. The page still contains navigation labels; empty graph search does not establish absence.                          |
| `menu`        |                         0 |                     24 | Surfaced the `interiorMenu` binding and source locations in the shared controller.                                                                         |
| `open`        |                         0 |                     97 | Surfaced `open` reads and state-related leads, but did not explain the full interaction on its own.                                                        |
| `close`       |                         0 |                      0 | Correctly returned no exact term after the search fix; close behavior is expressed as state changes, not a `close` identifier.                             |

The static semantic graph did not expose the literal `aria-expanded`, even
though the homepage markup initializes it, the controller writes it, and CSS
uses its true state. That forced a direct source check for the exact
accessibility values. REE also did not join the HTML
control, JavaScript state changes, and CSS visibility rule into one behavioral
claim. The search leads were useful; a human still had to trace and reconcile
those files.

The review exposed two concrete issues in REE's question-led search. Substring
matching treated `close` as a match for `closest`; semantic search now uses
case-insensitive whole terms, complete identifiers, and camel-case segments.
JSON search results also repeated opaque `unknown_ids` that were already
available in the full Evidence file; the explorer now returns per-family
unknown counts while preserving the complete IDs in `evidence.json`.

## Reproducibility and resource measurements

The final Evidence identity is `ev_d1ef0f4b52f136df0d7bba21dc448fcece032a72f10b896de83fa48a911885ba`.
The analyzed artifact digest is
`fd5bf9bb4395232d434d6adb8c990f53c8e11cfc21255619c651aacfa372cade`.
Application and semantic graph IDs are `jag_c77be56b9518d610f7f6885c9f059fa31326a886437e4551f5607e655a1a768c`
and `jsrg_d3a7952c72a0825a6584c95e7af3c38fc89bb6083ed6334af03d0a1abb96b57c`.

The full Evidence file was 2,441,941 bytes. A bounded JSON `close` search
returned 2,773 bytes and preserved the 473 unknown count; the complete IDs
remain in the Evidence file. That is a response-size comparison for this query,
not an analysis-time or token benchmark.

One sequential comparison used Node `v24.19.0` and macOS `/usr/bin/time -l`
against the same target snapshot:

| REE revision                     | Wall time | User + system CPU |          Reported maximum RSS |
| -------------------------------- | --------: | ----------------: | ----------------------------: |
| Baseline `2f58bb2`               |    2.69 s |            2.86 s | 408,076,288 bytes (389.2 MiB) |
| Local semantic-search refinement |    2.40 s |            2.85 s | 404,389,888 bytes (385.6 MiB) |

This is one run per revision, so it does not establish a performance improvement.
Cold/warm variation, process-family peak memory, and token use were not measured.
Full Evidence and the generated reports remain in the local analysis directory
`/tmp/ree-zoco-nav-20261020-ree`; they are not committed because they contain
machine-specific target paths.

## What remains unverified

- No browser, device, runtime, deployment, screen-reader, or keyboard acceptance
  test was performed, as requested.
- The analysis demonstrates useful static source navigation on one current
  public application snapshot; it does not establish broad target or language
  generalization.
- Semantic graph coverage remains unknown, and its 473 unknowns are unresolved.
- Exact HTML attribute literals and cross-file HTML/JavaScript/CSS behavior are
  not reliably surfaced by the current question preview.
- A future investigation-resumption workflow is separate work; this report and
  Evidence bundle are retained files, not a resumable session manager.
