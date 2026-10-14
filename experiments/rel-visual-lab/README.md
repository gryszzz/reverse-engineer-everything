# REE Visual Lab 01 — learn by seeing

**REE = Reverse Engineering Everything.** Our promise: **understand the mechanism, show the proof, and test what we learned.**

This is our own beginner experience built **on top of** the original [REA engine](https://github.com/morluto/rea). We are not renaming someone else's engine or pretending to have written its analysis providers. Our identity is the learning workflow and clear explanations around the real engine.

## First lesson in plain English

On a Mac with Node.js installed, you can open **`Start-REE.command`** from the repo folder. Try searching for `bridge`, click **Show real results**, and then **Show me how**. See [your first ten minutes](../../FIRST_10_MINUTES.md) for the exact walkthrough and macOS troubleshooting.

## Start on your computer

Open Terminal in the REE checkout on branch `rel/first-lab-foundations`. Use a supported Node.js version (the repo pins one in `.nvmrc`).

```bash
node ree.mjs lab --open
```

That opens a browser tab on your own computer. If the browser cannot be opened automatically, the command prints a local address beginning with `http://127.0.0.1:` which you can copy into Safari or Chrome.

**No dependency installation, REA compilation, API key or Ghidra installation is required for the visual lesson.** It uses the sample code already committed to this repository.

If your environment is remote or has no desktop browser, run `node ree.mjs lab` and use the printed local URL in a browser **on that same machine** (remote ports are not automatically exposed).

Press **Ctrl+C** in Terminal to stop the lab. This opens a local-only server on a randomly selected port, not a public website.

## What you'll see

1. **Observe** — type `bridge` and guess which note appears first.
2. **Trace** — see how the command-line entry point borrows the notes and search function.
3. **Map** — inspect the five fictional notes.
4. **Explain** — understand how search matches are ranked.
5. **Verify** — compare the original ranking against a separate, hypothetical "tags first" rule.

The **left-hand list** executes the real `searchNotes` function imported from `experiments/rel-first-lab/search.mjs`. The **right-hand list** is a visual experiment, not an original feature or REA finding.

The **two import relationships** linked from `cli.mjs` to `notes.mjs` and `search.mjs` were independently identified in the [recorded real REA test](../rel-first-lab/VERIFIED_RESULTS.md). The animated connector diagram is conceptual, **not** a recorded runtime trace.

## Computer language, translated

| Term            | Everyday meaning                                      | In this lab                                                |
| --------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| JavaScript      | A written set of computer instructions                | The search code                                            |
| File            | A named drawer containing instructions or information | `search.mjs`                                               |
| Import          | One drawer borrows something from another             | `cli.mjs` imports `searchNotes`                            |
| Function        | A reusable task: inputs go in, a result comes out     | `searchNotes(notes, query)`                                |
| Array           | An ordered collection of items                        | The five notes                                             |
| Ranking         | The rules deciding which result comes first           | Title before tag                                           |
| Static analysis | Inspect structure without launching a target          | REA's module relationship scan                             |
| Runtime test    | Watch actual execution                                | The left-hand search results                               |
| Evidence        | A concrete observation or source location             | `cli.mjs:1` and `cli.mjs:2`                                |
| Unknown         | Something the available evidence cannot establish     | Whether a relationship executed in an untested environment |

The same question can appear in different computer languages:

- **Human:** "Find all notes connected to bridge."
- **JavaScript:** `searchNotes(NOTES, "bridge")`
- **Machine instructions:** a processor ultimately executes lower-level instructions; the visual lab does **not** show machine-code reconstruction.

## Levels of reverse engineering

**Level 1 — Behavior:** What goes in and what comes out?

**Level 2 — Structure:** Which pieces are connected?

**Level 3 — Rules:** What logic explains the result?

**Level 4 — Evidence:** Which exact source locations or runtime recordings support our explanation?

**Level 5 — Controlled change:** If we change one rule in our own copy, what changes and why?

**Beyond this lab:** native binaries, browser observation, runtime instrumentation, comparative reconstruction, and work across multiple artifacts. Each requires appropriate tools, permissions, and verification; none is automatically enabled by this browser lesson.

## Beyond the animation: produce REAL analyzer evidence

After setting up the pinned Node/npm toolchain in this fork:

```bash
npm ci
npm run build:cached
OUT="$(mktemp -d)/investigation"
node ree.mjs demo --run --out "$OUT"
cat "$OUT/REE_EVIDENCE_REPORT.md"
```

This invokes the built REA analyzer on our source-owned lab and saves evidence outside the repository. **Do not confuse this real analysis with the UI animation.**

In a trusted checkout, Codex can use the project's existing MCP configuration and the `$ree-investigator` skill. That is tool access and instructions, not model training or permission to inspect arbitrary applications.

## Developer verification

```bash
node --test rel/lab-server.test.mjs
```

The regression suite checks that the exact sample modules are served, the real sample ranking matches the lesson, URLs and source evidence are available, and the server cannot serve other repository files or accept writes.

We deliberately avoid frontend frameworks, external packages, remote scripts, analytics, and persistent state for this first lesson. The HTTP server only exposes an explicit allowlist of four local source/evidence files plus the one HTML page. The browser fetches nothing from the internet.

**Known limit:** automated HTTP and source tests do not by themselves establish that every browser layout or interaction has been visually audited on Safari, Chrome, and mobile. That still needs a browser check.
