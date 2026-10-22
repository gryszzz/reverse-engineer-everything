# Investigation Studio

The Investigation Studio is a local workspace on top of the REA engine. It runs in this checkout. It is not a published app and it does not install Ghidra, IDA, Hopper, or other providers.

## Launch on a Mac

From the checkout, with Node.js available:

```sh
nvm use
node ree.mjs doctor
node ree.mjs studio --open
```

Or double-click `Start-REE-Studio.command`. If macOS blocks the unsigned file, run `zsh ./Start-REE-Studio.command` in Terminal. Leave the window open. Control+C stops the server.

The page address is `http://127.0.0.1:<port>/`. The server refuses other hosts and other origins. Projects are stored in `~/Library/Application Support/REE/studio` unless you pass `--data DIR`. That directory must be outside the checkout. On Linux the default is `$XDG_DATA_HOME/ree/studio` or `~/.local/share/ree/studio`.

`doctor` and the studio page do not need a build. Static analysis does.

## Build, then analyze the owned fixture

```sh
npm ci
npm run build:cached
node ree.mjs studio --open
```

In the studio:

1. Create a project and keep the question, for example `Which files import which?`
2. Choose **Use the owned JavaScript fixture**. This classifies `experiments/rel-first-lab` and does not analyze it yet.
3. Check the authorization box. The run reads source files and does not launch the fixture.
4. Choose **Run static analysis**.
5. Open **Evidence** and search `search.mjs` or `cli.mjs`.
6. Open **Graph**. Inferred edges are static relationships. They are not captured executions. Select one and open the recorded source line.
7. Open **Report** to export a Markdown projection of the saved project.

Simple Mode uses plain language. Advanced Mode shows Evidence ids, readiness fields, and the exact `node ree.mjs analyze` command.

The same analysis from the terminal:

```sh
OUT="$(mktemp -d)/ree-studio-cli"
node ree.mjs analyze "$PWD/experiments/rel-first-lab" \
  --authorized \
  --out "$OUT" \
  --question "Which files import which?"
```

## Readiness

The Readiness view separates four facts for each route:

| Field                 | Meaning                                                                               |
| --------------------- | ------------------------------------------------------------------------------------- |
| Engine                | Whether the REA checkout contains that route                                          |
| Studio                | Whether this UI invokes it                                                            |
| Prerequisites         | Whether the local build or a `PATH` command was found                                 |
| Verified on this host | `recorded-in-this-studio` only after a completed studio action in this data directory |

A missing Ghidra command does not prove the Mac app is absent. A present command does not prove a decompilation succeeded. `not-recorded` is the honest default.

## Experiment, diff, and research

**Experiment** previews one command: the owned-fixture probe for the query `bridge`, with a five-second timeout and an allowlisted environment. Nothing runs until you approve that digest. The capture is stored on the experiment and is not written into `evidence.json`. The finite-hypothesis planner can be asked before the probe, with no observations. It reports insufficient evidence until an observation carries a real REA Evidence id. This studio does not mint one, so the capture is not sent back to the planner.

**Report** and summary diff compare saved records. They do not create a new engine verdict.

**Research** is off until you enable it. The stages SCOUT, MAPPER, TRACER, ANALYST, DIFF, VERIFIER, and REPORTER restate intake, Evidence summaries, and saved comparisons. Remote model calls stay refused even if `research.json` contains a key. The key is not shown in the UI and is not sent anywhere by this build.

## Limits

- One static analysis at a time in a data directory, with a three-minute timeout.
- Evidence browsing follows the existing 64 MiB explorer limit.
- The graph window is at most 200 application-graph edges, or 40 semantic relations.
- Source excerpts open only when the recorded path stays inside a directory target.
- Cancelling a run sends SIGTERM, then SIGKILL. A run that already finished keeps its Evidence.
