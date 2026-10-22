# Outside-in behavior specs

`outside-in` studies a product from public documents when you do not have its
code. It writes a versioned behavior spec that another system, including
BLAST's ANALYZE adapter, can read. The command is opt-in. `inspect`,
`analyze`, the Investigation Studio, and the REA engine keep their current
behavior.

It does not need `npm run build:cached`. It uses Node's HTTP client, so the
same command runs on Linux and other headless hosts. It does not use the Mac
app, a browser, or a GUI.

## Legal and ethical boundaries

This mode fetches public web pages the operator names. It is not permission to
copy a product, recover its source, or bypass a lock.

- Fetch only URLs you are allowed to request. You are responsible for the
  site's terms and for the law that applies to you.
- Public documents only. There is no login, no cookie jar, no
  `Authorization` header, and no headless browser.
- `robots.txt` is fetched and obeyed. HTTP 404 means there are no rules.
  Any other robots failure, including HTTP 401, 403, 429, 5xx, or an HTML
  challenge page, fails closed and the page is not fetched.
- HTTP 429 is not retried. The host is skipped for the rest of that run.
  `Crawl-delay` and a one-second minimum gap (live fetches) are waited out.
- HTTP 401 and 403 are refused as authentication. HTTP 402 and a
  `paywall=true` meta tag are refused. Captcha markers are refused and not
  solved. Redirects are not followed.
- Source and binary filenames and content types are not fetched and are not
  decompiled. Examples, request bodies, and fenced code samples are omitted
  from the spec.
- Loopback, link-local, and private hosts are refused. Credentials in the URL
  are refused and redacted.
- The spec is clean-room: structured facts and descriptions, plus short
  attributed quotes of at most 160 characters. A similarity guard redacts
  unmarked verbatim runs of 80 characters or more. Findings record the length
  and source URL, not the passage.
- The cache stores fetched bytes so a later run can reuse them. Those bytes
  are not part of the behavior spec. Do not treat the cache as clean-room
  output.
- No link is followed. Only the URLs you list, plus `robots.txt` for their
  origins, are requested. At most 25 explicit URLs are accepted, and a
  document over 512 KiB is refused.
- REE does not call a model. `--summarizer remote` is refused. A programmatic
  caller may pass a local summarizer object; it receives the spec, not cached
  page bodies, and its text is still passed through the similarity guard.

## Usage

```sh
node ree.mjs outside-in \
  --name "Widget Cloud" \
  --url https://widgets.example/ \
  --docs https://widgets.example/openapi.yaml \
  --pricing https://widgets.example/pricing \
  --changelog https://widgets.example/changelog.xml \
  --reviews https://widgets.example/reviews \
  --out /tmp/widgets-spec \
  --json
```

`--out` and `--cache` must sit outside this repository. The cache defaults to
`<out>/cache` and records `fetched_at`. A fresh run inside 24 hours reuses
that timestamp instead of downloading again.

`--json` prints the behavior spec on stdout and nothing else. BLAST can parse
that stdout.

| Exit | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| 0    | At least one document was fetched (`completed` or `partial`). |
| 3    | Every content URL was refused. The spec is still written.     |
| 2    | Usage error, or a request for a remote model.                 |

A request file has the same fields:

```json
{
  "target": { "name": "Widget Cloud", "urls": ["https://widgets.example/"] },
  "docs": [
    { "url": "https://widgets.example/openapi.yaml", "kind": "openapi" }
  ],
  "pricing_url": "https://widgets.example/pricing",
  "changelog_url": "https://widgets.example/changelog.xml",
  "review_urls": ["https://widgets.example/reviews"]
}
```

`kind` may be `openapi`, `graphql`, `sdk-readme`, or `feed`. When it is
omitted, the collector sniffs the body.

```sh
node ree.mjs outside-in \
  --request request.json \
  --fixture rel/outside-in/fixtures/product \
  --out /tmp/widgets-spec \
  --json
```

`--fixture DIR` reads `manifest.json` and the listed files. It does not open
a network connection. Tests use that path.

From code:

```js
import { analyzeOutsideIn } from "./rel/outside-in/analyze.mjs";

const { spec, exitCode } = await analyzeOutsideIn({
  target: { name: "Widget Cloud", urls: ["https://widgets.example/"] },
  docs: [{ url: "https://widgets.example/openapi.yaml", kind: "openapi" }],
  fixtureDir: "rel/outside-in/fixtures/product",
  outDir: "/tmp/widgets-spec",
});
```

Pass `summarizer: { id, summarize }` only when you have a local provider.
Leave it unset for the deterministic extractor. `summarizerChoice: "remote"`
throws before any fetch.

## What the spec contains

`behavior-spec.json` conforms to
[behavior-spec.schema.json](behavior-spec.schema.json)
(`ree.outside-in.behavior-spec.v1`). `OUTSIDE_IN_REPORT.md` is the same
record in Markdown. Every claim has a `citations` entry with the source URL
and `fetched_at`.

The deterministic extractor records:

- feature headings, and a short quote only when the first paragraph is at
  most 160 characters
- ordered steps under a workflow heading
- OpenAPI or Swagger operations, parameter names, auth schemes, documented
  servers, and `x-rate-limit` values
- GraphQL `Query` and `Mutation` fields, or introspection JSON
- SDK README headings, with fenced code counted under `omitted` and dropped
- plan name, price, and limit lines from pricing HTML
- changelog titles and dates from RSS or Atom
- short stated limitations and review lines

`clean_room` is always `true`. `collector.authentication` is `none`,
`collector.headless_browser` is `false`, and `llm.ree_remote_calls` is
`not-performed`.

Refusals use a stable `reason`: `robots-disallow`, `robots-unavailable`,
`rate-limit`, `auth-required`, `paywall`, `captcha`, `source-or-binary`,
`credentials-in-url`, `private-host`, `redirect`, `unsupported-scheme`,
`disallowed-url`, `too-large`, `fixture-miss`, or `fetch-failed`.

## Limits

HTML extraction is structural. It recognizes headings, lists, and common
pricing markup. It does not execute JavaScript, so a client-rendered page can
produce an empty feature list. That emptiness is unknown coverage, not proof
the product lacks the feature.

The OpenAPI reader keeps operation shape and drops descriptions and examples.
The GraphQL reader extracts field names; it is not a schema validator.
Pricing recognition looks for plan, tier, or price regions and a currency
amount. Unrecognized markup is reported under `coverage.unknowns`.

A cached document is reused until its age passes 24 hours even if `robots.txt`
changes during that window. After a 429, later URLs on that host are refused
instead of sleeping for `Retry-After`.

This command does not call REA providers, does not create Evidence ids, and
does not appear in the Investigation Studio.
