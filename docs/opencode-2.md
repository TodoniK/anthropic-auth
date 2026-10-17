# OpenCode 2

OpenCode 1 and OpenCode 2 use the same native account pool for a given OpenCode configuration. OpenCode 2 uses a registered provider source rather than the OpenCode 1 fetch wrapper. Pi has its own pool and enrollment authority.

## Empty initialization

Stop every OpenCode, LiteCode and Pi process, then run:

```sh
npx @cortexkit/opencode-anthropic-auth setup --yes --opencode=2
```

Without `--login`, generation-2-only local setup registers the main OpenCode config and publishes a version-5 `empty-init` journal, or reuses matching completed authority. The journal records permission for the native runtime to use local storage; empty initialization authorizes a pool that has no accounts yet and does not create credentials. It does not read or write OpenCode 1's auth file, install an OpenCode 1 placeholder, create an OpenCode 2 connection, or open any OpenCode database. It opens nothing under the OpenCode data directory; path inspection for safety is allowed. No production setup code reads `OPENCODE_DB`.

The OpenCode setup callback prints the registered pool-login instruction once:

In OpenCode, sign in to Anthropic with "Claude Pro / Max (native account pool)".

After setup, start OpenCode and select **Claude Pro / Max (native account pool)**. The registered login verifies the Claude account identity and commits its credentials to the native pool. Only the fixed, non-secret plugin marker is returned to OpenCode through the host API. The first plugin-served request uses native pool authorization, never an old OpenCode 1 token. An empty pool cannot serve a request.

Fresh empty initialization writes only its journal, in addition to shared registration's main config update. It leaves legacy account/state/routing sidecars untouched and does not write the TUI sidebar config. Reusing a matching empty-init journal leaves pool, journal and source bytes unchanged, even after later pool logins. Existing native destination files without matching authority, malformed or conflicting journals, and unfinished migrations refuse instead of being overwritten. This is an offline setup operation, not a background repair.

## Setup login and host selection

`setup --login` is an explicit OpenCode 1/Pi sign-in, not an OpenCode 2 login:

- `--login --opencode=2` exits 1 before the runner, prints the pool-login step above and writes nothing, on both real and dry runs.
- A real run that detects or interactively chooses generation 2 alone also refuses `--login` in the first preflight, before any selected host writes. If Pi is selected too, Pi does not proceed alone.
- A dry run without the explicit `--opencode=2` argument invokes no callbacks: it can print `Would sign in locally for opencode.` and exit 0 even when a real run would refuse.
- `--login --claustrum` is separately refused: local sign-in and vault setup are different choices.

`--yes` (or `-y`) selects every detected host. There is no host-exclusion flag. On a machine with OpenCode 2 and Pi, a noninteractive `--login` cannot select Pi alone; use interactive host deselection to choose Pi without OpenCode. `--opencode=2` selects the OpenCode generation, not the host list. Stored Pi auth still requires explicit consent; `--yes` is not consent to remove it.

## Both OpenCode generations

`--opencode=both` is one OpenCode owner with one native path set and one authority journal, not two migrations or two login commits. It runs the OpenCode 1 local operation first and then reuses that authority for OpenCode 2. With all legacy sources absent, that operation produces a retired zero-row legacy-import journal, not an empty-init journal. With `--login`, there is one OpenCode login commit. The generation-2 pool-login step is not printed for `both`.

Shared registration writes the main and TUI sidebar configs for generation 1 or `both`; generation 2 alone writes only the main config. No selection opens an OpenCode database. Generation 1 and `both` may open the OpenCode 1 auth file for migration; that exception does not apply to generation 2 alone.

## Later OpenCode 1 use and routing

Empty initialization does not retire a later OpenCode 1 import. When the native pool holds no account data, offline OpenCode 1 setup imports legacy accounts and metadata, preserves native preferences and gap-fills legacy session pins only where a native pin is absent. Once the pool holds credentials, rows or private account metadata, direct migration refuses `pool-populated` and shared OpenCode 1 setup skips the import. Pins or preferences alone do not make the pool populated. A separate OpenCode 1 login never replaces native tokens just because its account UUID matches.

For an empty-init journal, OpenCode 1 and 2 use `OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE` when set, otherwise `getStickyRoutingStatePath(paths.config)` (normally `anthropic-auth-pool-routing-state.json`). Pi uses the corresponding `PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE` override or the same config-derived rule on Pi paths. Completed legacy migrations use their recorded routing destination; that behavior is independent of empty initialization.

Version-5 journals have no rollback path. Do not delete or rewrite a journal to make an older release accept it. A version-5 legacy-import resume requires unchanged native settings and refuses `settings-changed` before further writes if they differ. Existing version-4 journals retain their version-4 format and recovery behavior. See [upgrade and recovery](releases.md#upgrade-and-recovery).

## Vault and transport boundaries

Generation-2 vault setup also leaves OpenCode 1 auth and all OpenCode databases untouched. In an enrolled host, choose **Claude vault accounts**, not the local-pool login. The vault and local-pool login methods both return only the non-secret marker; startup creates neither connection automatically. Enrollment, not account settings, selects custody. See [vault setup](vault.md#setup) and [custody gates](custody-state-machine.md#opencode-2).

OpenCode 2 supports direct and HTTP relay requests. WebSocket relay is refused before dispatch; select HTTP or direct in [transport settings](transports.md#relay).

## Dependency ownership

The setup CLI lives in `@cortexkit/opencode-anthropic-auth`. Shared detection, generation choice, stopped-host safety checks, registration and enrollment come from `@cortexkit/common-auth`, which remains a devDependency of `@cortexkit/anthropic-auth-core` (Core) bundled into Core's dist. The CLI imports the shared runner through Core's bundle and gains no new runtime common-auth dependency. Anthropic callbacks own identity verification, native migration, Pi consent and vault activation.

The plugin never uses access or refresh tokens from the Anthropic login stored in OpenCode 1's own auth file, separate from the native pool. OpenCode 1.18's own stored-OAuth refresh behavior is not established; this guide makes no host-side refresh claim. The [OC1 admission table](custody-state-machine.md#opencode-1) describes when a separate login can coexist with native serving.
