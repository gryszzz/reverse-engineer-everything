# CLI and Evidence

Use the CLI for a direct inspection or a script. It uses the same application
workflows and evidence contracts as REA's MCP server. Each CLI invocation is a
separate process; save results when you want to use them in a later command.

## Run a command

After [installing REA](installation.md), use `rea`. You can also run a command
without a global installation:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Use an extracted application directory or an ASAR as the target. Static
JavaScript analysis returns the application graph and Evidence directly.
Generic `rea analyze PATH` selects this workflow for directories and `.asar`
files when neither `--provider` nor `--snapshot` is supplied. See
[JavaScript artifact reconstruction](javascript-artifact-reconstruction.md)
for results, integrity checks and coverage.

The complete application Evidence can be hundreds of megabytes for a real
application. When an agent or a person reads the result, save it to a file and
project a summary, a module page or one module from the saved Evidence:

```bash
rea analyze-javascript-application /absolute/path/to/app --json > app-evidence.json
jq -c '{source: {kind: "inline", evidence: .}, view: {kind: "summary"}}' app-evidence.json > app-view.json
rea inspect-analysis-view app-view.json
```

For example, a 334 MB Obsidian application Evidence file yields a summary view
of about 10 KB. Replace the view with
`{"kind": "page", "collection": "modules", "offset": 0, "limit": 32}` for a
module page. See
[JavaScript application workflows](javascript-application-workflows.md) for
views, feature traces and comparisons that take the same saved Evidence.

## Managed assemblies (.NET)

For a .NET PE/CLI assembly, inspect its identity and deployment form before
inspecting members. These commands read metadata and Common Intermediate
Language (CIL) without loading or executing the assembly and require no native
analysis engine:

```bash
rea inspect-managed-artifact /absolute/path/Assembly.dll --json
rea inspect-managed-members /absolute/path/Assembly.dll --json
rea inspect-managed-members /absolute/path/Assembly.dll --type Example.Parser --json
```

Replace `Example.Parser` with an exact `full_name` from the member inspection,
or a declaring type name you already know. Omit `--type` to inspect all members,
or repeat it to select several types.
Selection limits decoding to the selected types; member references remain an
assembly-wide inventory, so the output can still be large.

Choose the workflow from the artifact's contents rather than its `.exe` or
`.dll` extension. The managed parser requires PE/CLI metadata; it does not
unpack .NET single-file hosts or decode IL2CPP metadata. NativeAOT method bodies
require native analysis. See the [managed-code guide](managed-code-analysis.md)
for supported deployment forms, selection semantics, and coverage limits.

## SQLite snapshots

For a local database snapshot, use `rea inspect-sqlite-database PATH --json`.
Add `--table NAME --row-limit 20` to read a bounded sample from an ordinary
table. This command does not require a native analysis provider. See
[SQLite database snapshots](sqlite-databases.md) for database/WAL identity,
source-file handling and row-value semantics.

## Native analysis

Inspect embedded Go build metadata without installing Go or configuring a
disassembler:

```bash
rea inspect-go-binary /absolute/path/to/program --json
```

The shared CLI/MCP workflow reports compiler version, modules, replacements,
build settings, original bytes and SHA-256. See [Go binaries](go-binaries.md)
for supported containers and absent or malformed metadata.

Inspect an embedded cargo-auditable Rust dependency list without installing
Rust or configuring a disassembler:

```bash
rea inspect-rust-binary /absolute/path/to/program --json
```

The same workflow reports package names, versions, sources, the root package,
dependency edges, and the section's file range. A missing `.dep-v0` section is
null metadata, not proof that the binary has no dependencies. See
[Rust binaries](rust-binaries.md).

Configure [Hopper or Ghidra](installation.md#hopper), or the
[IDA adapter](ida-provider.md), before analyzing a native target. Substitute
your target, search text and function name or address in these examples:

```bash
rea analyze /absolute/path/to/program --provider ghidra --json
rea search /absolute/path/to/program "search" --provider ghidra --json
rea function /absolute/path/to/program main --provider ghidra --json
rea decompile /absolute/path/to/program 0x1000 --provider ghidra --json
rea xrefs /absolute/path/to/program 0x1000 --provider ghidra --json
rea trace /absolute/path/to/program "search" --provider ghidra --json
```

`analyze` and `inspect` share the native overview workflow. `function` returns
a function dossier; `decompile` returns pseudocode. For assembly instructions
alone, use `rea instructions`. A macOS `.app` bundle can be supplied directly.

Run `rea --help` or a command's `--help` for arguments and output options.
The [generated catalog](mcp-contracts.md#generated-catalog) lists all CLI commands and MCP
tools. Provider-specific target support is described in the
[native guide](native-investigation.md), [DOS guide](ghidra-dos.md),
[raw binary guide](raw-binary.md), and
[Windows Ghidra guide](windows-ghidra-p0.md).

## Draft and verify a reconstruction specification

Draft typed claims from exact comparison Evidence IDs and dimensions. The
comparison's operation determines whether claims are behavioral,
function-structural, or artifact-structural; unsupported dimensions and
incomplete Evidence closure are rejected:

```bash
rea derive-reconstruction-specification draft-input.json --json
```

The input contains a portable Evidence bundle and explicit selections:

```json
{
  "name": "Bounded process investigation",
  "evidence_bundle": { "...": "complete Evidence bundle" },
  "comparisons": [
    {
      "comparison_evidence_id": "ev_<comparison Evidence ID>",
      "dimensions": ["terminal", "overall"]
    }
  ]
}
```

This is a schematic example: replace the placeholder with a complete Evidence
bundle and use the exact comparison Evidence ID from that bundle.

The returned `rea.reconstruction-specification-draft` Evidence contains the
verifier-ready `normalized_result.specification`, its complete source Evidence
IDs, and limitations. Only selected dimensions become claims. The draft does
not claim that those dimensions cover the target's full behavior.

`verify-reconstruction` runs the same finite-claim verifier exposed by MCP.
Give it a JSON file containing a typed `specification` and the portable
`evidence_bundle` that contains each cited comparison record:

```bash
rea verify-reconstruction verification-input.json --json
```

The command returns a `rea.reconstruction-verification` Evidence record. A
`pass` applies only to every declared claim and its available authority; it
does not establish global implementation equivalence. Missing, incomplete, or
limited comparisons remain `unknown`. The owned C rounding investigation
demonstrates specification drafting and verification after compiling and
capturing both programs:

```bash
npm run verify:ree-investigation-boundary
```

The script is a bounded source-owned lab. It records source and executable
digests, selected probes, capture and comparison Evidence, final verifier
Evidence, and unresolved coverage in its output directory.

For a failed terminal claim backed by one process capture on each side, the
verifier can also return adjacent decimal values for identical plain-decimal
argv entries as candidate probes. Each suggestion cites the comparison and
both capture Evidence records and identifies the argument index and candidate
strings. These are lexical neighbors only: REE does not infer argument
meaning, confirm domain validity, or claim that they distinguish every
possible explanation. The verifier itself never executes recommendations.

The owned C fixture has a separate opt-in for one explicitly approved
follow-up. It validates that the recommendation points to the freshly compiled
fixture binaries and matching recorded arguments, then captures both sides,
compares them, appends their Evidence to the original bundle, and runs
specification derivation and verification again:

```bash
npm run verify:ree-investigation-boundary -- --approve-recommended-probes
```

The C investigation fixture can propose a source change from the terminal
counterexample and the two owned source files. It only supports a single
`printf` call whose format argument matches; it proposes transferring the
differing output expression from the reference. This is source-differential
transfer, not semantic code synthesis. The first run saves the proposal and
does not materialize, build, or execute the proposed candidate:

```sh
npm run verify:ree-investigation-boundary -- /tmp/ree-c-proposal --approve-recommended-probes --refine-candidate
```

Review `candidate-refinement/candidate-patch-proposal.json` and its `.patch`
file. The proposal SHA-256 binds the patch and both source snapshots. To apply
that same proposal in a new disposable run, pass the reviewed digest:

```sh
npm run verify:ree-investigation-boundary -- /tmp/ree-c-approved --approve-recommended-probes --refine-candidate --approve-proposed-patch=<sha256-from-proposal>
```

Only a digest match materializes the candidate copy. The harness then builds
it, rejects a counterexample-only negative control using neighboring and extra
quantity inputs, and verifies the approved proposal against five finite
terminal claims. Builds, captures, comparison Evidence, specifications,
verification Evidence, and the report are saved under `candidate-refinement/`.
The checked-in fixture remains unchanged. A pass does not establish general
behavioral equivalence or independent semantic synthesis.

This experiment is limited to one argument variation, two process captures,
and one comparison. Its approval record and new Evidence are saved alongside
the original run. It does not provide a general-purpose approved probe
executor for arbitrary targets.

The separate Python and Ruby tax fixture checks whether that workflow crosses
implementation languages and executable wrappers. Both programs accept an
amount and a mode. The `tax` branch differs at 99 cents (Python returns 8;
Ruby returns 7), while the `refund` branch agrees. Both reject negative
amounts with matching terminal and exit behavior. The verifier recommends
neighboring amount values while preserving the selected `tax` branch in each
approved scenario. The batch also checks that replaying the same accumulated
Evidence produces the same plan digest, and that an injected capture failure is
reported as partial without retries or later probe execution. These checks
exercise bounded failure handling: partial Evidence accounts for every
approved selection and labels later probes as not run. This does not test
recovery from arbitrary runtime faults.
Run it on macOS with the system Python 3 and Ruby:

```bash
npm run verify:ree-cross-language-tax -- --approve-recommended-probes
```

The fixtures are owned, local command-line programs. Their finite terminal
observations demonstrate this workflow across two languages; they do not prove
the tax policy is correct or establish equivalence beyond these inputs.

## Choose a provider

List the available providers and their supported operations:

```bash
rea providers --json
rea capabilities --json
```

These commands describe binary-session providers and auxiliary capabilities.
For the complete MCP surface, use the connected server's tool list and the
session's advertised availability; individual guides describe prerequisites.

With automatic selection, REA uses the single available provider that supports
the target. When several providers support it, select one explicitly:

```bash
rea analyze /absolute/path/to/program --provider hopper
```

Set `REA_ANALYSIS_PROVIDER` for a standing preference. An explicit `--provider`
overrides it. In MCP, pass `provider_id` to `open_binary`:

```json
{
  "path": "/absolute/path/to/program",
  "provider_id": "hopper"
}
```

The selected provider remains bound to the session until an explicit switch
or close. Provider failures are returned with their original reason. For an
`ambiguous` selection error, choose from `details.candidate_ids`; for
`provider_unavailable`, run `rea doctor --provider ID --json` to diagnose the
selected engine. See [task readiness](installation.md#check-readiness-for-your-task)
and [provider selection](mcp-contracts.md#identity-and-discovery).

The session reports work still in progress through `analysis_activity`.
A client timeout can end its wait while the provider continues analyzing.
`cleanup_incomplete` identifies resources whose shutdown or removal could not
be verified. See [MCP contracts](mcp-contracts.md) for session lifecycle and
[Ghidra first-query deadlines](mcp-contracts.md#ghidra-first-query-deadlines-and-recovery)
for import, client timeouts and recovery.

## Save and reuse analysis snapshots

A snapshot retains successful analysis results for later queries. REA reuses
an exact result when the target bytes, operation, parameters, provider and
settings match. Mutations and cursor-dependent calls are excluded from the
cache. Snapshot files are local and use owner-only permissions.

Dispatching a metadata write invalidates the active session's snapshot cache,
even if its reply fails: the provider may already have applied the write.
Close and reopen the target before importing or saving another snapshot.

Snapshots retain eligible target-scoped question histories in full, including
mutation Evidence recorded while another target was active. Observations and
related questions must still belong to the saved target. If those dependencies
cannot be retained, the entire history is excluded instead of reverting the
question to an earlier revision or disposition.

```bash
rea analyze /absolute/path/to/program --provider ghidra --snapshot /absolute/path/to/analysis/program.json
# Repeat the same query to reuse its saved result.
rea analyze /absolute/path/to/program --provider ghidra --snapshot /absolute/path/to/analysis/program.json
```

An exact CLI cache hit is normally read before starting a provider process.
On Windows, Ghidra first admits the selected source through its native snapshot
owner, so replay can start that provider.
In MCP, `open_binary` accepts `snapshot_path` to import a snapshot atomically
for its matching target; an MCP provider may still start before returning a
cached result. `close_binary` accepts `snapshot_path` and optional
`overwrite: true` to save before releasing provider resources. A failed save
leaves the session open so the caller can resolve the output failure.

The MCP save receipt reports `primitive_entries`, `workflow_entries`, and
`evidence_records` separately. Zero primitive bindings can still accompany retained workflow
results and Evidence. These are cached observations, not a saved provider
database: only eligible exact queries can reuse a result, and new or live
queries can still require provider startup. The CLI uses the same snapshot
format and preserves these records when loading and updating it.

## Import, export and compare Evidence

Evidence records retain artifact identity, source locations, observations,
inferences and unresolved findings. Validate an existing bundle, export its
canonical form, or compare two supplied bundles:

```bash
rea evidence-import /absolute/path/to/evidence/bundle.json
rea evidence-export /absolute/path/to/evidence/bundle.json /absolute/path/to/evidence/canonical.json
rea compare /absolute/path/to/evidence/left.json /absolute/path/to/evidence/right.json
```

Exports preserve an existing destination unless `--overwrite` is explicit.
For application traces and version comparisons, see
[JavaScript application workflows](javascript-application-workflows.md).
MCP [retained Evidence references](mcp-contracts.md#retained-application-evidence-inputs)
belong to one connection. Separate CLI calls consume full saved records.

## Import historical source

Import an older source tree to compare with the current artifact:

```bash
rea import-reference-source /absolute/path/to/source
rea import-reference-source /absolute/path/to/source --detail summary --outline-depth 2 --json
```

The default (`--detail full`) returns the complete `HistoricalSourceGraph`.
Choose `--detail summary` for a `HistoricalSourceSummary` of that same committed
inventory: its `HistoricalSourceManifest` contains the full graph and root
digests, with provenance, VCS facts, languages, manifest paths, entry and
relationship counts, parse-failure counts, file/directory states, exclusions
and limitations. The summary is a presentation view, not a graph accepted by
source-to-bundle comparison; keep the full output for that workflow.

`--outline-depth` requires `--detail summary` and accepts a nonnegative safe
integer. Depth 1 shows root children, depth 2 (the default) also shows their
children, and depth 0 omits all outline entries. Paths retain canonical Unicode
code-point order. `outline.omitted_entry_count` counts only inventoried entries
hidden by the chosen depth; it does not count unexamined children of excluded or
unreadable directories, or change `inventory_state`. Exclusions and source
limitations remain separate from this presentation omission.

`file_sizes.known_bytes` is the exact sum of known inventoried file sizes as
decimal text, so large sums cannot lose integer precision. Unknown sizes count
in `file_sizes.unknown_file_count`; excluded or unexamined paths are not included
in that total. A zero known-byte sum therefore does not establish an empty source
tree. Full output retains individual file hashes, relationships and parse-failure
diagnostics. Summary mode performs the same import and cleanup, then projects
the committed result without rereading source files. It reduces the selected
output, not the amount of source examined. A shallow tree or many exclusions can
still produce a large summary; depth 0 removes the outline but preserves the
other facts. No fixed output-size or runtime improvement is promised.

The import records hashes and metadata for the supplied files, separately
from observations of the current app. For a directory inside a Git checkout,
it records the HEAD of the nearest enclosing repository; whether the working
tree matches that commit remains unknown. It honors the source tree's `.gitignore`
and applies default exclusions for common generated and dependency paths such
as `node_modules/`, `dist/`, and `*.log`. Pattern-based exclusions record the
matched pattern and whether it came from project, default, caller, or sensitive
path policy. Set `REA_REFERENCE_SECRET_PATTERNS_JSON` to a JSON array of ignore
patterns when you want to mark selected paths as sensitive; those patterns are
reported separately as configured-secret exclusions.

Re-import saved graphs whose pattern-based exclusions lack `pattern` before
using them in source-to-bundle comparisons.

JavaScript and TypeScript import parsing requires valid UTF-8. Malformed source
bytes retain their original hashes and sizes with a decoding diagnostic; REA
does not infer module targets from replacement characters.

Historical-source import requires safe no-follow file opens on Linux or
macOS. Native Windows returns `unsupported_host`; use Linux REA inside WSL
or another supported host. See
[source-to-bundle comparison](javascript-application-workflows.md#historical-source-to-bundle-comparison)
for mapping identities, inferences and unknowns.

## Capture runtime behavior

Choose the guide for the target and intended interaction:

- [Browser observation](browser-observation.md): inspect a selected page through CDP.
- [Browser scenarios](browser-scenario-contract.md): run declared interactions and capture their results.
- [Electron observation](electron-observation.md): inspect an Electron renderer or capture an application scenario.
- [Node/Electron Inspector](javascript-runtime-observation.md): record script locations and execution contexts.
- [Process capture](process-capture.md): run an executable and compare terminal, exit and filesystem observations.

Runtime requests name the target and actions. Launched targets run with your
user permissions; consult the chosen guide for host requirements and effects.

## Output and exit status

The default terminal format is TOON. Use `--json` when saving results for a
JSON consumer. `--json` is indented on a terminal and compact when piped or
redirected, which keeps large results smaller for agents and scripts; pipe
through `jq .` for indented files. Output selection and formatting do not change
operation status.

| Status    | Meaning                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | The operation completed. Its result may include partial evidence, warnings or unresolved questions.                                                  |
| `1`       | The operation could not complete. Structured output identifies invalid input, permissions, cancellation, timeouts or another failure when available. |
| `128 + N` | Signal `N` ended the process, where the shell or runtime preserves the conventional signal-derived status.                                           |

`setup --dry-run` returns `planned` and exits `0`; a cancelled setup also exits
`0`. Setup returns `1` for `needs_confirmation` or `needs_human`.
`doctor` returns `1` when required checks in its selected readiness scope fail;
unavailable optional providers remain informational for unrelated tasks.

Enable `pipefail` in a supporting shell so a downstream formatter preserves
REA's failure status:

```bash
set -o pipefail
rea inspect-artifact ./app.asar --json | jq . > inspection.json
```
