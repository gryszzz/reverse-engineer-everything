# Agents

REE is built on morluto's REA engine (MIT).

Another bot can run the public-document flow without the studio. The commands below print stable JSON when `--json` is set. The object is `ree.agent.v1`: `schema_version`, `step`, `ok`, and either `result` or `error`. The existing `pipeline`, `rebuild`, `verify`, `handoff`, and `board` commands are unchanged.

A public URL is fetched by outside-in: robots.txt, a rate limit, no login, and no source or binary download. A fixture directory is the offline form of that read. When the document has no feature, `result.rebuild` is false and `result.note` says the page does not support a rebuild.

```bash
node ree.mjs agents analyze --url https://example.com/docs --name Example --out /tmp/ree-run --json
node ree.mjs agents findings --run /tmp/ree-run --json
node ree.mjs agents spec --run /tmp/ree-run --json
node ree.mjs agents rebuild --spec /tmp/ree-run/behavior-spec.json --name "Example Desk" --out /tmp/ree-product --json
node ree.mjs agents verify --project /tmp/ree-product --json
node ree.mjs agents package --project /tmp/ree-product --json
node ree.mjs agents board-post --spec /tmp/ree-run/behavior-spec.json --data /tmp/ree-board --json
```

`node ree.mjs agents mcp` speaks MCP on stdin and stdout. The tools are `ree_analyze`, `ree_findings`, `ree_spec`, `ree_rebuild`, `ree_verify`, `ree_package`, and `ree_board_post`. Each returns the same JSON. This server does not replace the inherited REA MCP tools.

The product name must differ from the spec target name. Rebuild does not copy source. Board post does not call Guard, notify Blast, or call Scale.
