# REE studio baseline

Inspection record for the Investigation Studio work. It separates the product layer from the inherited engine and records checks run before that work was attributed to new failures.

Host for this pass: Linux x64, Node v22.23.4, npm 10.9.9. The checkout pins Node 24.18.0 and npm 11.16.0. Node 22.23.4 is inside the engine range `^22.19.0 || ^24.11.0 || >=26.0.0` and is not the pinned pair. SQLite inspection wants Node 24.15+ or 26+.

## Product layer and engine

| Layer       | What it is                                                                           | Entry                                                              |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| REE product | Beginner CLI, intake, doctor, visual lesson, Evidence Explorer, Investigation Studio | `ree.mjs`, `rel/`, `Start-REE.command`, `Start-REE-Studio.command` |
| REA engine  | Domain Evidence, application workflows, provider adapters, CLI, MCP                  | `src/`, `scripts/rea.mjs`, `bridge/`                               |

`ree.mjs analyze` delegates to `scripts/rea.mjs analyze-javascript-application`. The studio starts that same command in a child process. Package metadata remains `rea-agents` / `io.github.morluto/rea`. Release jobs stay gated to `morluto/rea`. This checkout is not published as REE.

## Route inventory

| Route                                 | In this checkout    | External tool     | Studio                                             | Verified here before the studio                                |
| ------------------------------------- | ------------------- | ----------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| JavaScript / Electron static analysis | Implemented         | No                | Runs it                                            | CLI tests existed; runtime was not built at the first baseline |
| Evidence Explorer                     | Implemented         | No                | Uses it                                            | `rel/evidence-explorer.test.mjs` passed                        |
| SQLite snapshots                      | Engine route        | Node SQLite build | Not invoked                                        | Not run                                                        |
| Ghidra, IDA, Hopper                   | Engine adapters     | Bring-your-own    | Not invoked                                        | Not installed or run                                           |
| JADX, Apktool, JEB                    | Engine routes       | Bring-your-own    | Not invoked                                        | Not run                                                        |
| Firmware, WASM, packet capture        | Engine routes       | Matching tools    | Not invoked                                        | Not run                                                        |
| Process capture and finite hypotheses | Engine workflows    | Host support      | Planner preview and a separate owned-fixture probe | Not re-run in the first baseline                               |
| Remote model                          | Not an engine route | —                 | Refused                                            | —                                                              |

## Baseline commands before studio code

`node_modules` and `dist/cli-runtime/cli.js` were absent.

```text
node --test rel/mac-doctor.test.mjs rel/lab-server.test.mjs rel/intake.test.mjs rel/evidence-explorer.test.mjs
# tests 41, pass 41, fail 0

node --test rel/analyze-static.test.mjs
# fail 2: "Built REA runtime missing" for the canonical plan and the real REE command.
# The other tests in that file passed (16 pass, 2 fail).

node --test rel/codex-mcp.test.mjs
# fail: Cannot find package '@modelcontextprotocol/client' because dependencies were not installed.
```

Those three failures are pre-existing environment gaps, not studio regressions. `npm ci` later installed dependencies. `npm run build:cached` then completed (`turbo` 2.11.7, 3 tasks, about 8s on this host).

## Checks after the studio code

```text
node --test rel/studio/graph.test.mjs rel/studio/studio.test.mjs rel/mac-doctor.test.mjs rel/lab-server.test.mjs rel/intake.test.mjs
# tests 46, pass 46, fail 0

node --test rel/analyze-static.test.mjs
# tests 18, pass 18, fail 0
# The two runtime-missing failures from the baseline no longer fail once dist/cli-runtime/cli.js exists.

node --test rel/studio/studio-engine.test.mjs
# pass 1, skipped 1 (the skip is the "runtime missing" guard, because the runtime was present)
# The passing test created a project, classified experiments/rel-first-lab, ran authorized static analysis through the studio, read an import edge as inferred, opened its recorded source line, and resumed the project from the same data directory.
# duration_ms about 2076

node ree.mjs analyze "$PWD/experiments/rel-first-lab" --authorized --out "$OUT" --question "Which files import which?"
# 49 graph nodes, 67 edges
# Evidence ev_45d365f3b6f0be5b8831504b9bf5f268826bf0973e47a11ad01e1bd65587d58b
```

The owned-fixture probe in the studio tests returned ids `N-102`, `N-101`, `N-104`. The caller-declared title-weighted prediction matched. The tag-first prediction did not. No REA Evidence id was minted for that capture.

Not run in this pass: the full `npm run check:pr` matrix, real Ghidra/IDA/Hopper/JADX/Apktool/JEB executions, macOS Finder launch, and a browser click-through on macOS. The studio page was fetched over loopback from the tests, including its HTML and security headers.

A later pass on the same host repeated the studio checks and added the MCP handshake that had failed before dependencies were installed:

```text
node --test rel/studio/graph.test.mjs rel/studio/studio.test.mjs rel/mac-doctor.test.mjs rel/lab-server.test.mjs rel/intake.test.mjs
# tests 46, pass 46, fail 0

node --test rel/analyze-static.test.mjs rel/studio/studio-engine.test.mjs
# tests 20, pass 19, fail 0, skipped 1
# The skip is the runtime-missing guard. The studio engine test passed in about 2609 ms.

node --test rel/codex-mcp.test.mjs
# tests 2, pass 2, fail 0
# Includes a local MCP tool-discovery handshake against the built server.

npm run test:local -- tests/conformance/readmeConsistency.test.ts
# 6 passed
```

Still not run: `npm run check:pr`, native or Android providers, a macOS Finder launch, and a browser click-through on macOS.
