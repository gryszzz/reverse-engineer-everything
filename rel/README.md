# REE Simple Mode — one front door, many investigation tools

**Goal:** understand authorized software in plain English with source-backed evidence, while preserving upstream REA's detailed tools. We are _simplifying the interface_, not claiming that any software can always be reconstructed.

## Start here

From the REE project root:

```sh
node ree.mjs                           # usage
node ree.mjs demo                      # preview our first controlled exercise
node ree.mjs types                     # target types and readiness
node ree.mjs inspect /path/to/app      # read-only target classification
node ree.mjs inspect https://example.org --question "What does this page load?"
node ree.mjs inspect /path/to/app --json
```

After building, the source-owned REE demo can execute, and another **explicitly authorized static JavaScript/Electron directory or ASAR** can be analyzed without launching it:

```sh
npm ci
npm run build:cached
node ree.mjs demo --run --out /tmp/rel-demo-evidence
```

That command delegates to our already verified [Phase 2 REA runner](../experiments/rel-first-lab/REAL_ANALYZER.md). It runs REE on fictional local data, saves full analyzer Evidence, asks REA for its compact analysis view, and generates a readable report. Choose an output directory outside the repository.

For an authorized extracted JavaScript application, use `node ree.mjs analyze /absolute/app/path --authorized --out /tmp/rel-investigation-001`. Other `inspect` targets—including website URLs—are **preview only**. `--run` intentionally rejects them rather than opening programs, running unknown code, contacting websites or making unsupported analysis claims. The type classifier reads directory names or the first 32 bytes of a local regular file only; filenames are clues, not verified program behavior.

Public documentation collection is a separate opt-in command, `node ree.mjs outside-in`. `node ree.mjs ingest-docs` turns a public URL or a docs folder into that spec and does not crawl. `node ree.mjs read` detects a public URL, an API file, an npm package, a public GitHub repository, or a local folder and writes the same spec plus `read.json`. None of these commands fetches source, bypasses a login, or changes `inspect`. See [outside-in](outside-in/README.md) and [docs/read.md](../docs/read.md).

The build pipeline reads a Scout JSON target or one of those behavior specs. It does not rescore Scout's 1–5 integers, and it does not invent market scores for a spec. `rebuild` writes a new folder outside this repository. Each feature gets a data model, write rules, CRUD routes, a page section, a behavior test, and, when a record route is built, a SQLite store at `data/store.sqlite`. A feature whose name equals an endpoint summary or operation id uses that concrete path, and the other declared methods on that path are built too. A feature with no matching endpoint gets its own collection. A path with one {name} segment gets get, update, and delete on the parent collection. JSON request bodies are accepted. Login and logout hash passwords and issue or revoke a token. A findBy path filters that collection. An inventory path counts the sibling collection. Any other path template, or a method other than GET, POST, PUT, PATCH, or DELETE, is left out and the reason is written in `FEATURE_REPORT.md`. Stripe checkout uses an existing test-mode price id and stays off until `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and that price id are set. The folder includes those tests, a README, an MIT license, pricing notes taken from the spec, and `product.tgz`. It does not copy original code. `verify` reports `pass` when a behavior test passed, `unimplemented` when the feature was not built, and `fail` when a test failed. `experiments/ree-bench/desk` is an owned fixture with more than five features. CI fails when its feature coverage is under 80%. `handoff` writes `handoff.json` and `README.md` for Blast, a Guard submission, and a Vault manifest. The README section What we can't read or build yet lists gaps from that product. It is not a percentage of the original product. It does not notify Blast, call Guard, or copy files into Vault. On a machine that has `/home/box/shared`, the Blast files go to `/home/box/shared/ree-to-blast/<build_id>/`. Otherwise pass `--blast-dir`.

`pipeline` runs scope, investigate, findings, spec, improve, rebuild, verify, package, guard, and handoff. improve writes `improvements.json` from Scout weakness quotes, Scale pricing and willingness-to-pay quotes, and build picks. Each item cites that record and quote. With no evidence the list is empty and the run says so. `--improvements FILE` reads that file or directory. `--no-improve` reads nothing. Accepted items become extra features marked improvement. Nothing is invented. An owned fixture is a directory with `request.json` and `manifest.json`. That path makes no network request. A directory without `request.json` stops unless `--authorized` is set, and static analysis is not turned into a product spec. An http or https URL is the authorization scope. The run requests that public page and its robots.txt, rate-limited, with no login. A URL with a username or password stops before any request. Each stage writes `checkpoints/<stage>.json`. A failed stage stops the run. `--resume` continues in the same output directory. The product package adds `NOTICE` and `LANDING.md`. The handoff posts one finding file per feature or endpoint and one pick file per feature whose route test passed. It also writes request files for Guard, Blast, and Scale. Those systems are not called. `board picks --data` lists the pick files and `board export --data --out` copies them with the request files. `board export --to` writes the Opportunity Board to a shared folder (`board.json` plus `findings/<id>/`). `board picks --from` reads agent verdicts from that folder. The directory defaults to `REE_SHARED_BOARD`. URL credentials are removed. The studio shows each verdict beside the matching entry. Approval flags record intent. `dry_run` stays true. When `REE_SHARED_BOARD` or `/home/box/shared/ree-board` already exists, the package stage writes `findings/<id>.md`, appends a run to `board.json`, and writes dry-run Guard, Blast, and Scale request files. It does not create that directory. A Guard verdict request is written to `/home/box/shared/guard/verdicts/<build_id>.json` only when `/home/box/shared` exists. Launch, publish, and payment are not performed. The contract is [docs/pipeline-contracts.md](../docs/pipeline-contracts.md). Search, relations, email and password or magic-link accounts, roles, and locally stored webhooks are built only when the behavior spec supports them. An HTTP product also gets Stripe checkout for an existing test-mode price id. It stays off until STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and that price id are set. No Stripe account or product is created. A live Stripe key is refused, and no live key is written into the product. Plan names come from Scale evidence when that record has a name, otherwise from the spec, otherwise a labeled placeholder. GraphQL operations, workflows, and rate limits are not built. Webhook events are not delivered to another host. Magic links are not emailed. A path with one {name} segment gets get, update, and delete on its parent collection. Login, logout, findBy filters, and inventory counts are built when declared. Any other path template is left out, with a reason.

```sh
node ree.mjs pipeline experiments/ree-bench/web --name "Board Desk" --out /tmp/ree-pipeline
node ree.mjs opportunities ingest target.json --out /tmp/ree-board
node ree.mjs board picks --data /tmp/ree-pipeline
node ree.mjs board export --data /tmp/ree-pipeline --out /tmp/ree-board-export
node ree.mjs board export --to /tmp/ree-shared-board
node ree.mjs board picks --from /tmp/ree-shared-board
node ree.mjs rebuild --spec /tmp/spec/behavior-spec.json --name "Board Kit" --out /tmp/board-kit
node ree.mjs verify --project /tmp/board-kit
node ree.mjs handoff --project /tmp/board-kit --blast-dir /tmp/ree-blast
node ree.mjs finish /tmp/board-kit
```

## Retained Evidence and selected views

Both `demo --run` and `analyze` require a new output directory with an existing
parent. They retain complete `evidence.json` once and receive REA's compact
`view-evidence.json` in the same analyzer process. `summary.json` and the readable
report retain the parent Evidence ID, graph identities, counts, coverage and
unknowns. The report no longer loads or duplicates the complete graph. Large
analyses still require memory for the engine and disk for full Evidence.

Use [Evidence Explorer](EVIDENCE_EXPLORER.md) to follow recorded relationships.
Its default view searches the structural application graph; `--semantic`
searches the separate static syntax graph for source-located leads. Neither view
interprets arbitrary questions or proves runtime behavior. Semantic JSON output
summarizes per-family unknown counts; the complete `evidence.json` keeps all
unknown IDs. For module pages and detailed module views, use the engine's
`inspect-analysis-view` with an `evidence-file` source. Saved-file views
validate the full record and remain subject to the engine's memory limits.

For linked HTML/CSS/JavaScript applications, application-graph results also
include bounded static cross-layer relationships. For example, search
`aria-expanded` to follow a DOM attribute write into matching styles, or
`nav-links.open` to find rules that may apply when JavaScript changes a class.
The Explorer shows the page, stylesheet, selector, event, and state-write
context. Selector matches are source-based possibilities; REE does not execute
the event, resolve the CSS cascade, or claim rendered behavior.

See [the fork's investigation architecture](../docs/fork-investigation-workflows.md)
for the existing engine connections, measured refinements and unresolved limits.

## Capabilities, not overpromises

| Target                             | REE first decision                                  | Prerequisite                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| JavaScript / Electron / TypeScript | Use static application-graph analysis               | Built REA fork                                                                                                                                   |
| ELF / PE / thin Mach-O             | Read Go build info, Rust packages, and PE resources | Built-in readers. `inspect-macho` symbols need macOS `otool` and `lipo` and are partial on Linux. Disassembly still needs Hopper, Ghidra, or IDA |
| .NET `.dll`                        | Verify real managed metadata                        | Static .NET tools; DLL extension alone is insufficient                                                                                           |
| Android APK / Apple app package    | Inventory package, then inspect layers              | Format-specific providers/tools                                                                                                                  |
| WebAssembly                        | Inspect WASM sections/interfaces                    | WABT for detailed inspection                                                                                                                     |
| SQLite                             | Analyze a read-only database snapshot               | Supported Node version and snapshot                                                                                                              |
| HAR / PCAP files                   | Analyze _recorded_ requests and packets             | Capture-format tooling and permission                                                                                                            |
| Firmware or raw binary             | Identify actual format before analysis              | Often additional Linux tools                                                                                                                     |
| Website                            | Plan bounded browser observation                    | Explicit authorization and browser                                                                                                               |
| Named public docs URLs             | Outside-in behavior spec                            | Explicit URL list; robots.txt and rate limits                                                                                                    |
| Unknown format                     | Ask for a format or sample                          | No fabricated diagnosis                                                                                                                          |

## Our intended workflow

```text
Question + target
      ↓
Identify format, or say UNKNOWN
      ↓
Show what can be done, required tools and permissions
      ↓
Only then run the matching REA tool
      ↓
Short human report: how it works / evidence / limitations / next experiment
      ↓
Advanced drill-down or reconstruction when verified
```

The [Investigation Studio](../docs/investigation-studio.md) is the local workspace for this route: projects, intake, readiness, static analysis, Evidence, a bounded graph, an owned-fixture probe, and a report. It does not add Understand, Map, Compare, or Recreate as general modes. REA already implements many deeper workflows; REE reuses them rather than inventing weaker copies.

No other user projects, remote sites or accounts are in scope for our present development. No global REA setup, provider installs, deployment, uncontrolled execution, or modifications to any repository besides this REE fork.

## Codex integration in this fork

A trusted local Codex workspace can load [the REE-specific MCP configuration](../.codex/config.toml) and [the ree-investigator skill](../.agents/skills/ree-investigator/SKILL.md). The server exposes the full underlying REA tools—more than the simplified static-only CLI. Check `node ree.mjs codex` and `/mcp` in Codex. This is not model training or a modification to your global Codex configuration.
