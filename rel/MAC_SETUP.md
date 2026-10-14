# REE on your MacBook — practical setup

The **same REE fork** retains upstream REA's broad reverse-engineering toolset. This guide makes the experience macOS-first, **without switching off the native Windows safety tests** or claiming every provider works on macOS.

## Easiest start: the Finder launcher

After cloning this fork and installing Node.js, double-click **`Start-REE.command`** from Finder. It runs the read-only Mac readiness check and opens the local visual lab. If macOS blocks the unsigned shell script, run `zsh ./Start-REE.command` from Terminal in the repo instead. Don't disable macOS security protections. Keep the window open while learning; Control+C stops the local server. For your first experiment, see [your first ten minutes](../FIRST_10_MINUTES.md).

## First: let REE look at your actual Mac

In the REE checkout, after installing Node.js:

```sh
node ree.mjs doctor
node ree.mjs doctor --json
```

This reports whether the computer is Intel or Apple Silicon, Node's own architecture, possible Rosetta translation, RAM, free disk space, build prerequisites, and optional Codex and analysis commands. It **does not** install packages, contact the internet, examine another project or change machine settings.

A 2020 MacBook Pro may be Intel **or** Apple Silicon, so do not assume which you have from the year alone. The readiness report determines this on your machine. Low-memory recommendations preserve investigation accuracy by limiting simultaneous work, **not** by suppressing evidence or pretending an incomplete run succeeded.

## Start small, then go deep

```sh
# No REA build needed for the beginner browser lab
node ree.mjs lab --open

# Then use the version in .nvmrc (nvm is optional, but convenient)
nvm install
nvm use
npm ci
npm run build:cached

# Prove actual REA analysis on our source-owned fixture
OUT="$(mktemp -d)/investigation"
node ree.mjs demo --run --out "$OUT"
cat "$OUT/REE_EVIDENCE_REPORT.md"
node rel/evidence-explorer.mjs "$OUT/evidence.json" --find cli.mjs
```

If `nvm` isn't installed, select the Node version from `.nvmrc` by another supported method first. Do not install optional reverse-engineering programs just to open Visual Lab 01.

## 8GB / limited-storage strategy

- **One analysis at a time.** Native decompilers and large app inventories can exceed limited RAM; start with JavaScript static analysis and bounded evidence displays.
- **Use a dedicated output folder.** Evidence Explorer caps display size rather than altering the original full Evidence. Keep reports outside the target and repository.
- **Prefer ample free disk.** If your system volume is crowded, put the results directory on an external drive with adequate available space; don't change default output paths automatically.
- **Use project-scoped Codex only.** Build in this repo and open it as a trusted Codex workspace. Review agent permissions; REA MCP exposes more than the constrained beginner CLI.
- **Optional native tooling.** Ghidra, Java, Hopper, Graphviz and other providers have independent licensing, CPU, memory and installation requirements. The doctor checks selected shell commands, not application bundle installations.

## macOS versus Windows CI

A Windows GitHub Actions job does **not** run on your Mac. Its native ownership failure is a separate cross-platform product safety issue, not an automatic diagnosis of your laptop. We preserve that test rather than bypass it.

REE has a macOS smoke-test workflow to verify the Mac-specific path. A passing macOS run is evidence of **that runner's** environment, not proof of your exact CPU or local installation. The repository-wide CI gate still needs every required lane to be resolved before we call the entire PR merge-ready.

## Safety and scope

Only inspect targets you own or are authorized to analyze. The `doctor` and Visual Lab are local/read-only. Full REA MCP providers can require permissions or have side effects; use explicit target scope and verify tools before invoking them.
