# Independent REE distribution readiness

This is a source-based readiness assessment, not a package release plan or
authorization to publish. REE is currently used from this checkout. Do not
install or describe the inherited `rea-agents` package as the REE release.

## Current identity in source

The checked-in package metadata still identifies the inherited REA product:

| Field                             | Current value                         |
| --------------------------------- | ------------------------------------- |
| npm package                       | `rea-agents` version `6.4.0`          |
| MCP Registry name                 | `io.github.morluto/rea`               |
| Repository                        | `morluto/rea`                         |
| Homepage and issue tracker        | `morluto/rea`                         |
| Executable names                  | `rea` and `rea-agents`                |
| Node range                        | `^22.19.0`, `^24.11.0`, or `>=26.0.0` |
| Toolchain pinned by this checkout | Node `24.18.0`, npm `11.16.0`         |

The README already distinguishes this fork from upstream. The package name,
MCP identity, metadata, and setup documentation have not been separated into
an independently installable REE distribution. The `publishConfig` field
declares public access for the inherited package identity; it does not mean
this fork is published or controls that name.

## Existing release workflow boundary

The repository contains an inherited `.github/workflows/release.yml`. Its
release proposal, qualification, npm publish, and MCP Registry publish jobs
are gated to `github.repository == 'morluto/rea'`. That guard prevents this
fork from publishing under upstream REA identities. Keep the guard in place
until REE has an approved independent identity and a separately reviewed
release workflow. No release automation was changed or enabled as part of this
report work.

## Work required before a separate package is safe

1. **Choose and verify ownership.** Select distinct npm and MCP Registry names,
   confirm their availability and account ownership, and decide who controls
   release credentials. This repository has not checked registry availability.
2. **Set the compatibility policy.** Decide whether the fork ships a `ree`
   executable while keeping `rea` as an explicitly documented compatibility
   alias. Avoid silently taking over upstream command or server identities.
3. **Separate package metadata and versions.** Update the package name,
   `mcpName`, repository, homepage, issue tracker, version lineage, and generated
   package/catalog metadata. Keep upstream attribution and the existing license
   and third-party notices intact.
4. **Audit install and maintenance flows.** Trace package-name assumptions
   through `install.sh`, setup, update, uninstall, MCP registration, skills,
   documentation, examples, and client configuration. Confirm an REE install
   cannot replace or remove an independently installed upstream REA copy.
5. **Qualify a clean package.** Review `npm pack --dry-run` contents, verify
   built artifacts and native payloads, and install the tarball into a fresh,
   isolated macOS workspace. Exercise the documented first-run, doctor, owned
   demo, one supported analysis, and report workflow on the pinned toolchain.
   Verify the package-runner, update, and removal paths affect only files owned
   by REE.
6. **Design release automation for this fork.** Replace the upstream-only
   repository guards with explicitly scoped REE release conditions, protected
   release review, provenance checks, exact-revision qualification, and
   separately owned npm/MCP credentials. Do this only after package identity
   and account ownership are decided.
7. **Release only after review.** Publish a versioned install guide and support
   matrix, run fresh-install acceptance from the exact qualified tarball, and
   obtain explicit release authorization before enabling any publish job.

## Not verified here

This audit inspected the checked-in metadata and workflow conditions. It did
not run `npm pack`, create an isolated package installation, query registry
name availability, alter account settings, create credentials, or publish a
package. Until the steps above are completed, the supported REE path remains a
source checkout; `npx rea-agents setup` refers to the inherited upstream REA
package.
