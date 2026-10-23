# Investigation Studio

The Investigation Studio is a local workspace on top of the REA engine. It runs in this checkout. `REE.app` is an unsigned bundle you build from this checkout; it is not a published or notarized app, and it does not install Ghidra, IDA, Hopper, or other providers.

## Launch on a Mac

From the checkout, with Node.js available:

```sh
nvm use
node ree.mjs doctor
node ree.mjs studio --open
```

Or double-click `Start-REE-Studio.command`. If macOS blocks the unsigned file, run `zsh ./Start-REE-Studio.command` in Terminal. Leave the window open. Control+C stops the server.

The page address is `http://127.0.0.1:<port>/`. The server refuses other hosts and other origins. The theme script is `/theme.js` because the page content-security policy blocks inline scripts. Projects are stored in `~/Library/Application Support/REE/studio` unless you pass `--data DIR`. That directory must be outside the checkout. On Linux the default is `$XDG_DATA_HOME/ree/studio` or `~/.local/share/ree/studio`.

`doctor` and the studio page do not need a build. Static analysis does.

## Build REE.app

On a Mac, from the checkout, after `nvm use`:

```sh
node ree.mjs app build
node ree.mjs app install
```

`app build` writes `build/REE.app`. It compiles a WebKit window with `swiftc` from `PATH` or, when that is missing, from `xcrun -f swiftc` and `xcrun --sdk macosx -f swiftc`. It sets `SDKROOT` from `xcrun --sdk macosx --show-sdk-path` and passes `-sdk` to `swiftc`. It tries both Apple Silicon and Intel. A failed build removes the partial bundle it created. `app install` copies that bundle to `~/Applications/REE.app` and puts a Desktop link named `REE`. Finder is given five seconds and is killed if it waits on an Apple Events prompt; the command then leaves a symlink.

Opening the app starts `node ree.mjs studio` from the checkout recorded at build time and shows it in the REE window. Closing the window stops the server. Opening it again while it is running focuses the existing window. If the recorded Node.js binary is gone, the app shows an alert that names `.nvmrc` and `node ree.mjs app build` instead of a blank window. Rebuild after you move the checkout or change Node versions.

The bundle is unsigned and not notarized. If macOS blocks the first open, right-click `REE.app`, choose Open, then Open. That does not disable Gatekeeper.

`node ree.mjs app build --layout-only` assembles the bundle without the WebKit window. Tests and non-mac hosts use that form. It is not the install path on a Mac.

## Theater and rebuild

While a JavaScript analysis runs, the studio reads `rea_progress` lines from the engine's stderr and appends them to `timeline.jsonl`. The Analyze view is that timeline: those lines, the active provider, elapsed time, and a file list that grows only when a progress line names a file. The eyebrow says Live analysis. After Evidence is written, the timeline adds the Evidence id, recovered module identities, inferred imports, and the functions, calls, strings, and behaviors stored in that record. A click opens the stored Evidence id, node or relation id, evidence state, and the progress phase that was actually recorded for that fact. If no progress line names the fact, the panel says so. Network behavior is shown as a behavior. It is not turned into an HTTP path. Hypothesis lines appear only when the Evidence record stored a hypothesis status. Replay walks that saved file. It does not synthesize events.

Evidence rebuild, under Advanced, previews a module map from those identities. The preview also reads each recovered file inside the artifact and places that text beside the stub that would be written, with a text diff where they differ. That comparison is display-only. The engine does not record a numeric match score for this route, so the verification label stays unverified. Writing requires approval and a new directory outside the checkout. The files are stubs: recovered identity, reconstructed implementation, unverified behavior. The included test checks the stubs against the map. It does not compare program behavior. Each written stub is appended to the same timeline.

The native action runs `scripts/verify/reconstruction/c-process-probe.mjs` only when an added artifact is `experiments/ree-investigation-boundary`. It does not need a JavaScript Evidence run. That harness compiles and captures the owned fixture, then records `verify-reconstruction` claim statuses. Another path is refused. The expected statuses are `control.terminal: pass` and `counterexample.terminal: fail`. The overall failure is the expected result because the candidate is deliberately wrong.

## Build, then analyze the owned fixture

```sh
npm ci
npm run build:cached
node ree.mjs studio --open
```

In the studio, Simple Mode opens on one front door: **Drop a file, folder, or paste a link**.

1. Drop a file or folder. The studio copies it into the data directory and classifies it. Nothing is analyzed yet.
2. Or paste a link and choose **Show what will be fetched**. That lists the URL, byte limit, time limit, and destination. It does not use the network. **Fetch and analyze** runs only after you tick authorization and the digest still matches. The saved bytes are not executed.
3. Tick the authorization box. The studio picks a ready route. If none is ready, it says so and does not invent a run.
4. When the run finishes, Findings shows one plain-English sentence per saved fact. Each sentence names the Evidence id and path. **Show evidence** opens the recorded step. Unknowns stay listed. The map shows stored relationships only. **Build from this** drafts a clean-room spec from those facts. You can uncheck features. The draft does not invent HTTP endpoints. Evidence search and a research session end with the same action.
5. Board accepts a Scout target or an outside-in spec. It does not invent scores.
6. Build writes the product files, then runs the behavior tests, and lists each file and each pass or fail as it is recorded. Each feature gets a data model, write rules, CRUD routes, and a section on the product page. A feature that only matches a path template is left out, and the report says why. **Package as product** writes `product.tgz` and a dry-run handoff after the tests finish. **Run owned web pipeline** starts `experiments/ree-bench/web` as Board Desk and shows each stage while the checkpoint file updates. Guard, Blast, Scale, and Vault are files. Nothing is submitted. It does not copy original source. Evidence rebuild, in Advanced, is a different action: stubs from recovered module identities, not this product.

Advanced Mode keeps Evidence rebuild, intake, readiness, the exact command, Evidence search, the graph, research, the owned probe, and the report. From there, **Use the owned JavaScript fixture** classifies `experiments/rel-first-lab` without analyzing it. A static run reads source and does not launch the fixture. Search Evidence for `search.mjs` or `cli.mjs`. Inferred graph edges are static relationships, not captured executions.

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

The studio can run the existing engine commands for JavaScript and ASAR, PE resources, EVM bytecode, objdump file headers, WebAssembly, ELF layout, Android JADX, apktool, Mach-O, and a Ghidra overview. A route that is missing its tool is `missing-tool` or `not-configured`. It is not reported as ready. The only install the page can run is `brew install apktool`, and only after the exact argv and digest are approved. WABT, JADX, Python, and Ghidra stay bring-your-own. IDA, Hopper, Rizin, and radare2 are not launched.

## Experiment, diff, and research

**Experiment** previews one command: the owned-fixture probe for the query `bridge`, with a five-second timeout and an allowlisted environment. Nothing runs until you approve that digest. The capture is stored on the experiment and is not written into `evidence.json`. The finite-hypothesis planner can be asked before the probe, with no observations. It reports insufficient evidence until an observation carries a real REA Evidence id. This studio does not mint one, so the capture is not sent back to the planner.

**Report** and summary diff compare saved records. They do not create a new engine verdict.

**Research** is off until you enable it. The local stages SCOUT, MAPPER, TRACER, ANALYST, DIFF, VERIFIER, and REPORTER restate intake, Evidence summaries, and saved comparisons. A model call also needs `REE_MODEL_API_KEY` and the checkbox. OpenAI-compatible endpoints are the default, including xAI when `REE_MODEL_PROVIDER=xai`. Anthropic uses `REE_MODEL_PROVIDER=anthropic`. The request contains retrieved passages, not the project at large. The verifier drops a fact that does not cite a retrieved Evidence id. Cost is unknown unless the response includes usage and `REE_MODEL_USD_PER_MILLION` is set. A computed cost above `REE_MODEL_BUDGET_USD` (default 0.05) discards the claims. A key stored only in `research.json` is still not sent.

## Explain this and the first run

Click **Explain this** on a finding, a theater module, or a graph node. The text is a local template. It quotes the stored label, relationship, and Evidence id, and it lists what is unknown. It does not call a model. A sentence with no Evidence id is withheld from the facts list.

The first visit shows a three-step tour. `?` opens shortcuts. `1` through `4` jump to the front door, Analyze, Findings, and Build when focus is not in a field. Lessons, Diff Lab, and Trace Lab are under Advanced. After a drop or a saved project with artifacts, **What can I do with this?** lists the ready routes and says which views restate Evidence. Simple Mode, the first ready route, research off, and authorization off are the defaults.

## Trace Lab

Trace Lab runs `capture-process` for `experiments/rel-first-lab/cli.mjs` with the query `bridge` after you check the box. Press T to open it. The record stays on the project trace, not in `evidence.json`. Filesystem rows are checkpoint effects for that directory. Network and IPC stay not-recorded. A matching path is the same name in the static record and the checkpoint, which does not show that the module ran. Linux and macOS need a native PTY. Windows capture is unavailable. A missing runtime refuses the launch.

## Diff Lab

Drop two versions into one project, then open Diff Lab and press Compare versions. The structural section is a directory listing. Evidence file identities and dependency edge ids appear only when both versions have a completed Evidence file under 8 MiB. Functions, strings, and behavior stay unknown when the records do not store those identities. Unknown is not shown as zero changes.

## Lessons

The Lessons view has four walks: Your first binary, How Electron apps are built, Reading disassembly, and Comparing versions. They read `experiments/ree-fixtures`, `experiments/rel-first-lab`, and the two C files in `experiments/ree-investigation-boundary`. They do not execute those programs. `objdump` output is labeled as tool stdout. If `objdump` is missing, the step says so and shows no listing.

## Limits

- Explain this does not describe runtime behavior and does not invent a function body.

- One static analysis at a time in a data directory, with a three-minute timeout.
- Evidence browsing follows the existing 64 MiB explorer limit.
- The graph window is at most 200 application-graph edges, or 40 semantic relations.
- Source excerpts open only when the recorded path stays inside a directory target.
- Cancelling a run sends SIGTERM, then SIGKILL. A run that already finished keeps its Evidence.
