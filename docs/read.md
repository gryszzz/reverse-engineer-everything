# Read public inputs

REE is built on morluto's REA engine (MIT).

`node ree.mjs read INPUT --out DIR` writes the same behavior spec as `outside-in`, plus `read.json`. The command is opt-in. `inspect`, `analyze`, `ingest-docs`, and the studio keep their current contracts.

## What is read

The input is detected. There is no login, no cookie, and no `Authorization` header.

| Input                                                         | What is fetched                                                                         | What is skipped                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Public `http(s)` URL                                          | The page, then one same-origin hop for docs, pricing, feature, changelog, and API links | Other origins, source and binary links, links past six pages, anything `robots.txt` disallows |
| OpenAPI, Swagger, Postman, GraphQL, HTML, or Markdown file    | That document                                                                           | Auth tokens and header values from a Postman collection                                       |
| `npm:name`, an npmjs.com package URL, or `registry.npmjs.org` | The public registry README                                                              | The tarball, when no license is published or the license is `UNLICENSED`                      |
| `.tgz` or `.tar.gz`                                           | README and exported declaration names                                                   | `.js`, `.mjs`, and `.cjs` implementation files                                                |
| `github.com/owner/repo`                                       | README and up to four schema files, only with a published open-source license           | Private repos, missing or unrecognized licenses, source files                                 |
| Local folder                                                  | The same document types, plus declaration names                                         | Hidden files, `node_modules`, `.git`, `dist`, `build`, `coverage`, implementation source      |
| JavaScript folder with `--authorized`                         | Short behavior labels from static analysis, when the REA runtime is built               | Behavior detail text. The target is not executed                                              |
| Native, mobile, wasm, managed, firmware, or Java file         | Nothing                                                                                 | The file. Its REA provider is not run                                                         |

A website crawl obeys `robots.txt` and waits at least one second between live requests to a host. `robots.txt` HTTP 404 means there are no rules. Any other robots failure stops link selection. Redirects are not followed. Loopback and private hosts are refused.

GitHub uses the public API only. The request does not send a token. npm uses the public registry only.

## Provenance and coverage

`behavior-spec.json` lists each fetched document under `sources` with `url`, `role`, `sha256`, and `fetched_at`.

`read.json` (`ree.read.v1`) repeats those sources, lists every skip with a reason, and records provenance such as the public requests that were made and an evidence id when static analysis ran. `coverage` is four counts: documents read, documents skipped, features, and endpoints. The note states that these counts are not a percentage of the original product.

Exit 0 when a spec is produced, including a partial spec. Exit 3 when every document is refused. Exit 2 for usage errors. `--out` must sit outside this repository.

## Clean room

Implementation source is not copied into the spec. A declaration file contributes exported type, interface, class, function, const, and enum names. The declaration body is not copied. Quotes stay within the outside-in limit of 160 characters. Binary files are not unpacked and are not executed.
