# Your first ten minutes with REE (Mac)

This optional lesson is a safe way to learn what genuine evidence means before analyzing an application. REE also includes a real static JavaScript/Electron investigation route; after the lesson, continue with [the workbench quick start](README.md#get-started). You don't have to know MCP, assembly, or JavaScript to begin.

## Start the first lesson

1. Install a supported Node.js version if you haven't already. This project currently pins Node 24.18.0 for the full analyzer; see [Mac setup](rel/MAC_SETUP.md). No REA build or API key is required for the beginner browser lab.
2. In Finder, open your cloned REE folder and **double-click `Start-REE.command`** for the lesson. For the investigation workspace, double-click **`Start-REE-Studio.command`**, run `node ree.mjs studio --open`, or build the unsigned Dock app with `node ree.mjs app build` and `node ree.mjs app install`. If macOS blocks an unsigned script or app, open it from Terminal with `zsh ./Start-REE.command`, or right-click `REE.app` and choose Open. Don't disable system security protections.
3. Keep the Terminal window open while using the browser. Press **Control+C** in Terminal to shut down the local server.

If Node is missing, the launcher gives instructions without installing anything. This launcher starts only the sample lesson; it doesn't analyze any other repository or upload data. The tiny local HTTP server binds to **127.0.0.1**, not the public internet.

## A two-minute investigation

- Type **bridge** and guess which note should come first.
- Click **Show real results**. The left list runs the actual source-owned search function.
- Click **Show me how**. Watch the educational diagram highlight one step at a time.
- Click **search.mjs** to find the ranking rules in actual JavaScript.
- Open **Recorded REA evidence**. The original engine confirmed two source-linked imports; the UI animation is an explanation, not a recorded runtime trace.

If you can explain _"one file brings in data and a search function, and the search function ranks notes by rules we can verify"_, you've finished lesson one.

## Go deeper whenever you're ready

Next, [build and run the actual analyzer](rel/MAC_SETUP.md) on our tiny owned example. Then [search its real saved Evidence](rel/EVIDENCE_EXPLORER.md). Later we can expand to other authorized artifact types and add visualization connected to their actual REA outputs.

This is a first-use guide, not a claim that REE can reconstruct arbitrary systems automatically. Keeping that distinction is how we make its deeper capabilities trustworthy.
