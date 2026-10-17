# Upgrades, recovery and releases

## Upgrade and recovery

Upgrading from 1.x requires stopping every OpenCode, LiteCode and Pi process and running [setup](installation.md#recommended-setup). Legacy sidecars are migration inputs, not live serving stores in the native account release. The 2.0.0-to-2.0.1 patch upgrade requires updating packages and restarting hosts, not rerunning migration; do not generalize that patch instruction to a 1.x upgrade.

OpenCode 2-only setup can initialize an empty native pool without reading OpenCode 1 auth or opening a database. It does not move an OpenCode 2 database or create a host connection; follow the [registered login step](opencode-2.md#empty-initialization) after setup.

Journal versions describe storage compatibility, not package versions:

| Journal | Compatibility and recovery |
| --- | --- |
| Version 4 | Legacy migration format without `kind`; existing recovery preserves that wire format |
| Version 5 `empty-init` | Completed empty local authority; can precede a later legacy import only while the pool has no account data |
| Version 5 `legacy-import` | Includes `kind` and a digest of the native pool's preferences; resuming an unfinished legacy import requires those preferences to remain unchanged |

Version-5 journals have **no rollback path**. There is no supported downgrade recipe that deletes the journal, removes `kind`, discards a digest or points an older release at a version-5 pool. Invalid version-5 metadata is not decoded as version 4. Preserve the files and diagnose a refused resume instead of editing journal fields to bypass the refusal.

Legacy migration advances through `building`, `verified` and `activation-installed` before committing imported state; those phases do not permit local request serving. `committed` and `retired` permit authority reuse. Retirement removes legacy sources only when their captured bytes still match. A later separate OpenCode 1 login is not overwritten: direct completed migration refuses `host-login-present`, while the setup CLI's OpenCode 1 callback skips the import.

A version-5 import resume with changed native settings refuses `settings-changed` without further writes. A conflicting input or journal refuses instead of starting over. These are preservation guards, not transient errors to work around by deleting files. See [custody](custody-state-machine.md#local-custody) and [troubleshooting](troubleshooting.md#local-accounts-and-migration).

## Maintainer release workflow

Pushing a release tag triggers the publishing workflow. No ordinary setup, upgrade or verification command publishes a package. From a clean release checkout, choose the intended new version explicitly, then preview, release and wait:

```sh
./scripts/release.sh "$VERSION" --dry
./scripts/release.sh "$VERSION"
./scripts/wait-release.sh "v$VERSION"
```

Set `VERSION` to the approved release version before these commands; the non-dry command commits, tags and pushes. It is not a local test. The release script checks `bun.lock` against package manifests, runs lint, types, tests, build and packed TUI smoke, synchronizes package versions and creates the tag. The GitHub release workflow publishes Core, OpenCode and Pi to npm with provenance and creates the GitHub release.

Keep pinned historical fixture versions and CI's minimum unit-test counts intact; those count floors are derived from the merge target or previous release tag. Do not change a package version or dependency merely to make a migration fixture pass. For non-publishing checks and dry package inspection, use [development verification](development.md#verification).
