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

## Retained Evidence and selected views

Both `demo --run` and `analyze` require a new output directory with an existing
parent. They retain complete `evidence.json` once and receive REA's compact
`view-evidence.json` in the same analyzer process. `summary.json` and the readable
report retain the parent Evidence ID, graph identities, counts, coverage and
unknowns. The report no longer loads or duplicates the complete graph. Large
analyses still require memory for the engine and disk for full Evidence.

Use [Evidence Explorer](EVIDENCE_EXPLORER.md) to follow recorded relationships,
or the engine's `inspect-analysis-view` with an `evidence-file` source for module
pages and detailed module views. Saved-file views validate the full record and
remain subject to the engine's memory limits.

See [the fork's investigation architecture](../docs/fork-investigation-workflows.md)
for the existing engine connections, measured refinements and unresolved limits.

## Capabilities, not overpromises

| Target                             | REE first decision                      | Prerequisite                                           |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------ |
| JavaScript / Electron / TypeScript | Use static application-graph analysis   | Built REA fork                                         |
| ELF / PE / Mach-O executable       | Choose native analysis provider         | Suitable Hopper, Ghidra or IDA                         |
| .NET `.dll`                        | Verify real managed metadata            | Static .NET tools; DLL extension alone is insufficient |
| Android APK / Apple app package    | Inventory package, then inspect layers  | Format-specific providers/tools                        |
| WebAssembly                        | Inspect WASM sections/interfaces        | WABT for detailed inspection                           |
| SQLite                             | Analyze a read-only database snapshot   | Supported Node version and snapshot                    |
| HAR / PCAP files                   | Analyze _recorded_ requests and packets | Capture-format tooling and permission                  |
| Firmware or raw binary             | Identify actual format before analysis  | Often additional Linux tools                           |
| Website                            | Plan bounded browser observation        | Explicit authorization and browser                     |
| Unknown format                     | Ask for a format or sample              | No fabricated diagnosis                                |

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

Future friendly actions could include **Understand**, **Map**, **Compare versions**, and **Recreate feature**. Those are design directions, **not implemented modes** today. REA already implements many deeper analysis workflows; REE should reuse them rather than invent weaker duplicates.

No other user projects, remote sites or accounts are in scope for our present development. No global REA setup, provider installs, deployment, uncontrolled execution, or modifications to any repository besides this REE fork.

## Codex integration in this fork

A trusted local Codex workspace can load [the REE-specific MCP configuration](../.codex/config.toml) and [the ree-investigator skill](../.agents/skills/ree-investigator/SKILL.md). The server exposes the full underlying REA tools—more than the simplified static-only CLI. Check `node ree.mjs codex` and `/mcp` in Codex. This is not model training or a modification to your global Codex configuration.
