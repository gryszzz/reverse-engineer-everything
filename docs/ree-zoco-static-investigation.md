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
- REE baseline: `47f3bf0aa48755f292f44604796ce10d2deb5a0b`. The analysis was
  run from a working tree based on that commit with the cross-layer changes
  applied locally. It did not modify ZoCo.

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
node rel/evidence-explorer.mjs "$OUT/evidence.json" --find 'aria-expanded' --limit 20
node rel/evidence-explorer.mjs "$OUT/evidence.json" --find 'nav-links.open' --limit 20
```

`inspect` classifies the target without analyzing it. `analyze --authorized`
runs the existing JavaScript static-analysis route; it does not launch the
website. The result retains the complete `evidence.json`, compact `summary.json`
and `view-evidence.json`, and a readable Markdown report. Semantic queries are
source-navigation leads. They do not answer the question automatically. The
application graph also links literal DOM queries and event handlers to retained
HTML elements, bounded DOM state writes, and supported selectors in linked local
stylesheets. The Evidence Explorer shows page, stylesheet, selector, event, and
write context. These remain source-based relationships, not runtime behavior.

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

The cross-layer run parsed 6 JavaScript files with 0 parse failures and reported
415 application graph nodes and 2,127 relationships. The new graph contains 143
HTML element nodes, 19 event-listener nodes, 37 state-write nodes, and 142
stylesheet-rule nodes. Application-graph coverage remains partial and not
truncated. The separate semantic graph contains 1,382 nodes and 1,141
relationships; its coverage is unknown, with 473 family-level unknowns.

The saved-Evidence query `--find aria-expanded` surfaces the homepage attribute
write at `mobile-nav-glass-20261012.js:18`, its event-handler/helper relation,
and CSS rules conditioned on `[aria-expanded=true]`. `--find nav-links.open`
shows the homepage `<nav>` matched to rules in `theme.css`, `styles.css`,
`mobile-nav-glass-20261012.css`, and `zoco-mobile-menu-polish-20261013.css`.
The Explorer now includes HTML page and CSS selector context so repeated page
templates can be distinguished. The CSS matches carry explicit media and
dynamic-class conditions.

This closes the specific source-tracing gap found earlier: the homepage
control, its event handler and state writes, and potentially matching CSS rules
can be followed through the application graph. It is still not a complete
explanation of all open/close paths. Document-level Escape, outside-pointer,
and resize handlers remain listener facts; control flow is not evaluated. The
native `<details>` path is represented through `open` writes and `[open]`
selectors where supported. Functional selectors such as `:is()` and `:not()`
remain explicit unknowns. Computed styles and cascade precedence are not
evaluated.

The earlier question-guidance search defect and repeated opaque unknown IDs are
also corrected: semantic search uses whole identifier terms and the Explorer
returns per-family unknown counts while the complete Evidence retains the IDs.

## Reproducibility and resource measurements

The cross-layer run's Evidence identity is
`ev_88c530266b07050230a481b0918624d114cdb6600ab5c9cb4e64a0ab734398d7`.
The analyzed artifact digest remains
`fd5bf9bb4395232d434d6adb8c990f53c8e11cfc21255619c651aacfa372cade` and the
application graph ID is
`jag_3a55848832d4617bbf94e5d567f930bd0c6d5589532da02d523713775730d9c6`.

The full Evidence file is 12,318,153 bytes (11.7 MiB). A bounded
`aria-expanded` search displayed 5 of 15 matching relationships;
`nav-links.open` returned 6 relationships. Search results now include bounded
page, stylesheet, selector, event, and state-write context, while the complete
Evidence remains available in the saved file.

The final sequential run used Node `v24.19.0` and macOS `/usr/bin/time -l`
against the same target snapshot:

| REE revision                                  | Wall time | User + system CPU |          Reported maximum RSS |
| --------------------------------------------- | --------: | ----------------: | ----------------------------: |
| Earlier baseline `2f58bb2`                    |    2.69 s |            2.86 s | 408,076,288 bytes (389.2 MiB) |
| Cross-layer working tree (based on `47f3bf0`) |    3.94 s |            5.09 s | 464,830,464 bytes (443.3 MiB) |

These are one run per revision, not a benchmark. The latest run took about 1.3
seconds longer and used about 54 MiB more maximum RSS than the older sample,
while adding 208 graph nodes and 2,059 relationships. The added CSS parsing and
page-specific edges have measurable cost; token use and process-family memory
were not measured. Further selector-based result selection or paging may be
worth exploring for larger web projects.

The generated Evidence and reports remain under
`/tmp/ree-zoco-cross-layer-final3-20261021`; they are not committed because they
contain machine-specific target paths.

## What remains unverified

- No browser, device, runtime, deployment, screen-reader, or keyboard acceptance
  test was performed, as requested.
- The analysis demonstrates useful static source navigation on one current
  public application snapshot; it does not establish broad target or language
  generalization. This is an owner-maintained application, not an independent
  third-party user test.
- Semantic graph coverage remains unknown, and its 473 unknowns are unresolved.
- Selector support is bounded. Dynamic DOM creation, ambiguous aliases, CSS
  nesting and imports, functional selector syntax, unselected CSS properties,
  cascade, and computed styles remain unresolved.
- The cross-layer run increased graph and Evidence size and added measurable
  analysis time; only one post-change run was measured.
- A future investigation-resumption workflow is separate work; this report and
  Evidence bundle are retained files, not a resumable session manager.
