# Rust binary dependency metadata

`inspect_rust_binary` / `inspect-rust-binary` answers which crate names,
versions, sources, and dependency edges are embedded by cargo-auditable in one
selected local executable or library. It reads the file without running it and
requires no Rust installation, active binary target, Hopper, Ghidra, or IDA.

```bash
rea inspect-rust-binary /absolute/path/to/application --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_rust_binary",
  "arguments": { "path": "/artifacts/application" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, byte length,
container format, architecture, word size, and byte order. When a `.dep-v0`
section is present, `auditable_metadata` contains:

- `section_name`, `.dep-v0` for ELF and PE or `__DATA,.dep-v0` for thin Mach-O;
- `file_offset` and `section_bytes`, the exact file range of the compressed section;
- `compressed_bytes` and `uncompressed_bytes`;
- `format_version`, the embedded integer, or `null` when the field is omitted;
- `packages`, in the section's original order, with `name`, `version`, `source`,
  `kind`, `dependencies`, and `root`;
- `root_package_index`, the single package marked `root`, or `null` when none is marked;
- `dependency_edges`, pairs of package indices in package-then-dependency order;
- `cyclic_dependency_indices`, sorted unique indices that participate in a cycle.

An omitted `kind` stays `null`. The embedded format treats that omission as
runtime, and that default is not stored in the section. An omitted dependency
list is an empty array. An omitted `root` flag is false.

`rustc_commit` is present only when a `/rustc/<40-hex>/` path is found in
read-only data. Its `evidence_kind` is `inferred`. The hash is not a claim that
that compiler produced the binary. Several distinct hashes leave a single
commit unknown.

## Limits and failures

The selected file is limited to 256 MiB. A dependency section is limited to 1
MiB compressed. Inflated JSON is limited to the smaller of 8 MiB and 64 times
the compressed size. The complete report is limited to 8 MiB. Empty sections,
truncated or trailing zlib bytes, invalid JSON, unknown fields, dependency
indices outside the package list, more than one root package, and compressed
dependency sections are typed failures. A cycle is reported and is not walked.

A missing section returns success with `auditable_metadata: null` and a
limitation. Absence of `.dep-v0` does not mean the binary has no dependencies.
Embedded names and versions are file content. They do not authenticate the
packages or the compiler.

Universal Mach-O containers are unsupported. Select a thin slice first. ELF,
PE, and thin Mach-O are the supported containers.

Package and dependency counts are checked against the minimum required JSON
representation before graph allocation or schema cloning. Oversized graphs
report the output byte budget; the compiler-path capacity reports
`maximum_rustc_hashes` in hashes, independently of byte limits.
