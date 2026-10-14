# REE — Start here

**REE is our learning workspace built around the upstream [REA (Reverse Engineer Anything)](https://github.com/morluto/rea).** This project adds an approachable on-ramp without claiming we rewrote the engine. Preserve upstream attribution, LICENSE, and THIRD_PARTY_NOTICES.md.

## Simple mode: start here first

Use [REE Simple Mode](rel/README.md) to choose a supported investigation workflow without learning all of REA. Start with `node ree.mjs demo` (preview only), run `node ree.mjs types`, or classify an authorized target with `node ree.mjs inspect TARGET`. Only our source-owned demo supports `--run` while we verify broader workflows.

## Goal

Learn to answer a narrow question about authorized software with **evidence**, then test the explanation. Our first milestone is a repeatable, understandable **local investigation**, not a new agent or native-analysis provider.

```text
Question → choose authorized target → observe behavior → inspect structure
         → separate facts from guesses → verify → record what remains unknown
```

REA provides a CLI and an MCP server for agents. Both use shared analysis workflows. In this project, the CLI entry point is scripts/rea.mjs, with routing in src/cli.ts and implementations in src/. The published npm package rea-agents is upstream; **npx rea-agents does not automatically run this repository's code**. Build and run the local entry point when testing REE changes.

## Start with the offline REE First Lab

Visit [experiments/rel-first-lab/README.md](experiments/rel-first-lab/README.md). Its five fictional notes and search command are entirely contained in this project. No API keys, websites, other projects, browsers, Hopper, Ghidra, or IDA required.

From the repository root:

```bash
node experiments/rel-first-lab/cli.mjs bridge
node experiments/rel-first-lab/verify.mjs
```

Expected search order: **Bridge Patterns → Signal Bridge → Local Cache**. First predict _why_. Then open search.mjs and compare your prediction with the actual code. The verifier checks only this toy example; it does **not** prove the complete REA analyzer works.

## Code map

| Path                                     | What it does                           |
| ---------------------------------------- | -------------------------------------- |
| scripts/rea.mjs and src/cli.ts           | Start and route CLI commands           |
| src/main.ts and src/server/              | MCP/server entry points                |
| src/composition/                         | Wire providers and workflows           |
| src/application/ and src/javascript/     | App-analysis and JavaScript logic      |
| src/domain/ and src/contracts/           | Evidence models, types, contracts      |
| docs/cli.md                              | CLI usage and summary views            |
| docs/javascript-application-workflows.md | Graph, trace, and comparison semantics |
| experiments/rel-first-lab/               | Our source-owned practice target       |

Static relationships are **inferences, not proof of execution**. Observations, derivations, confidence, unknowns and coverage are intentionally separate in REA. See [JavaScript Application Graph](docs/javascript-application-graph.md).

## Our improvement loop

1. **Learn:** run the lab CLI, verify the output, inspect imports and ranking.
2. **Use:** optionally build REE and run static analysis on the lab folder only.
3. **Record:** fill in [the worksheet](experiments/rel-first-lab/WORKSHEET.md) with an exact command, facts, inferences, unknowns, and a test.
4. **Measure:** capture runtime, Evidence size, extra commands, and whether the question got answered.
5. **Improve one bottleneck:** if evidence is hard to read, prototype a small REE summary/report rather than rebuilding the full engine.

## Scope and safety

- **Only this REE project** is in scope. Do not integrate it with any of our other repositories or services.
- Use only software and targets we own or are authorized to inspect.
- Prefer static, read-only work. Runtime execution, process attachment, debugger actions, and browser interactions need separate review.
- Do not run global setup, change agent configurations, install native providers, publish packages, or launch unknown programs for this first lab.
- Keep changes on a separate branch; preserve the original engine while learning.

**Milestone 1 is complete only when** the demo works, the explanation is reproducible, and any full REA analyzer run is truthfully labeled verified or unverified. No broader reconstruction-accuracy claims.

## Phase 2: verify the actual REA engine

Follow [the real-analyzer exercise](experiments/rel-first-lab/REAL_ANALYZER.md). The REE-only workflow builds this repository, analyzes the same fictional program, and preserves full Evidence plus a readable report. **A real-analyzer run passed on October 13, 2026.** See [verified findings](experiments/rel-first-lab/VERIFIED_RESULTS.md). The 11 sample checks alone did not establish that result; it was verified separately in GitHub Actions.
