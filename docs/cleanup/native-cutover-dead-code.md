# Native cutover: dead-code inventory

## Review boundary

This is the **inventory and review stage (Phase 1)**, against published commit
`60e2f28817050acb48cad320a20bf0b741a97219` (2.0.0). It proposes removals;
it does not delete code, change tests, lower count floors, or change packaging.
Phase 2 must wait for approval of individual rows.

“Dead” below means unreachable from a supported **in-repository** host, setup,
migration, seed, or downgrade/refusal path, not merely unimported by a host.
**Public export** notes identify externally reachable Core APIs. DELETE remains a proposal for internally dead public exports, with that
caveat. Whether Core is an internal integration package, and whether removing
an export requires a semver change, remain owner decisions. The external-consumer
survey below is evidence, not a proof about all npm consumers.

Two easily confused facts govern the inventory:

- `native-custody.ts` imports `ClaustrumScopedCustody` from
  **`@cortexkit/common-auth/claustrum`**, not Core's same-named 1.x class
  (`packages/core/src/native-custody.ts:1-4`, constructor at `:248`). Keep that
  common-auth primitive and the native adapter; the separate Core-local class is
  a deletion proposal, not an implementation dependency of native custody.
- OpenCode's current `loadAccounts` and persistent-setting functions are local
  native adapters, not imports of Core's sidecar implementation
  (`packages/opencode/src/index.ts:1321-1367`, `:1368-1485`). An exact-name hit is
  not enough to establish which implementation runs.

## Reachability audit (applies to every candidate row)

The audit identifiers in the following table (P1/P2/P3, B, D, R, G, C, M and N)
refer to the named evidence rows, not priority levels. Later candidate rows
reference this shared audit in addition to their own callers and tests.

Evidence uses **grep** for lexical references, aliases, import specifiers,
string keys, docs and tooling; **call graph** (`callers` and `trace_to`, with and
without tests) for relationships; **outline/zoom/read** for definitions and
entrypoint control flow; and AST searches for nonliteral loading. Negative
results below are scoped search observations, not line-addressable source facts.
Positive claims cite source lines. Broad truncated searches were not used as
absence evidence: the relevant names/scopes were narrowed instead.

| Audit | Evidence and consequences |
| --- | --- |
| P1: Core package surface | Root-only `exports`, no bin, and packaged `dist` at `packages/core/package.json:10-24`. The root wildcard-exports accounts (`packages/core/src/index.ts:1`), Claustrum (`:8`), scoped custody/roster/runtime (`:10-12`), prime (`:223`) and routing (`:241`). These are **public exports**, even if current hosts do not call them. No claim of zero external reachability is made. |
| P2: OpenCode package surface | Root, TUI, server, RPC and TUI-preferences exports, `oc-plugin` server/TUI entries, and CLI bin at `packages/opencode/package.json:10-40`; files include built output and TUI source assets at `:44-55`. There is no exported `setup/claustrum` subpath. |
| P3: Pi package surface | Root export, packaged `dist`, and `pi.extensions = ./dist/index.js` at `packages/pi/package.json:10-26`. No bin or separate custody/setup entry. The extension registers commands/provider at `packages/pi/src/index.ts:68-115`, `:302-336`. |
| B: Build entry lists | Core bundles `src/index.ts` and closes declarations (`packages/core/scripts/build.ts:21-29`, `:35-51`). OpenCode's explicit build list and TUI follow-up are `packages/opencode/package.json:58-67`; the list does not independently bundle `setup/claustrum.ts` or scoped runtime files. Pi uses `tsc -p tsconfig.build.json` (`packages/pi/package.json:30-36`), including source and excluding tests (`packages/pi/tsconfig.json:1-8`, `packages/pi/tsconfig.build.json:1-14`). Declaration/source emission can preserve an otherwise dead module; it is not a host invocation. |
| D: Dynamic import and require | Production TS AST sweep of Core/OpenCode/Pi source and root scripts: 11 `import(...)` nodes in 157 files, including type queries; one `require(...)` in 162 source/script files, `node:fs` (`packages/opencode/src/setup/pi.ts:42-45`). Runtime literal imports are logger (`packages/core/src/accounts.ts:3444`), dump (`packages/core/src/relay.ts:1762-1763`), and Core in old setup (`packages/opencode/src/setup/claustrum.ts:165`, `:249`) and the Pi mapping fixture (`scripts/check-pi-tool-mapping.ts:115-131`). The other source AST import nodes are type queries (`packages/core/src/native-ui.ts:83`, `packages/core/src/accounts.ts:473`, `:4332`, `packages/core/src/prime.ts:57`, `:99`), not runtime loaders. No TSX dynamic-import node was found in the two production TSX files. |
| R: Variable loaders and string registries | The JS source sweep found four import nodes, all in the TUI loader: an OpenTUI runtime probe and fixed legacy/compiled/v2 TUI modules (`packages/opencode/src/tui/entry.mjs:4`, `:15-37`, `:54-60`), not a registry of auth exports. Build-time variable loading is the Solid transform (`packages/opencode/scripts/build-tui.ts:59-63`, `:81-89`); installed-TUI smoke probes load the TUI file (`packages/opencode/scripts/smoke-tui-pack-install.ts:204-206`, `:241-243`). Grep for `eval`, `new Function`, `import.meta.glob`, `require` and Core-object enumeration found no production auth-module registry; test `new Function`/fs mocks are in `packages/opencode/src/tests/index-lifetime.test.ts:28`, `packages/opencode/src/tests/relay.test.ts:46`, `packages/opencode/src/tests/accounts.test.ts:6156-6173`. The active string-keyed Pi command dispatcher is explicit (`packages/pi/src/native-commands.ts:87-324`), not a lookup of legacy Core writers. |
| G: Call-graph corroboration and limits | `ClaustrumScopedRuntime` constructors resolve only to its own test (`packages/core/src/tests/claustrum-scoped-runtime.test.ts:98`, `:161`, `:223`, `:292`, `:327`, `:373`, `:424`, `:439`); `getOrCreateMainAccountId` resolves to `packages/core/src/tests/prime.test.ts:465`. `saveAccounts` has legacy setting/routing callers (`packages/core/src/accounts.ts:2873-3000`, `:3450`, `:3720`, `packages/core/src/routing.ts:47`). The graph misses dynamic imports and some barrel-reexport relationships: grep, not an empty graph, establishes old setup calls (`packages/opencode/src/setup/claustrum.ts:171`, `:249-257`) and the common-auth name collision. Native seed traces reach `readNativeVaultLegacySettings` through `createNativePoolStore` (`packages/core/src/pool-store.ts:10-14`, `:52-79`); migration traces reach `projectNativeMigrationSource` (`packages/core/src/native-migration.ts:338-345`). |
| C: CI and scripts | CI and release build/test the packages and run Pi import, golden, mutation and floor tooling (`.github/workflows/ci.yml:23-37`, `.github/workflows/release.yaml:45-74`). Exact candidate-name grep over `.github/` found no direct invocation. Root `scripts/` candidate-name matches are the import-guard's **synthetic** `loadAccounts` text (`scripts/check-pi-dist-imports.test.ts:117-135`), not a caller. Root script dynamic Core loading prepares a **native** pool (`scripts/check-pi-tool-mapping.ts:115-131`). Core declaration tooling walks emitted declarations, not runtime registries (`packages/core/scripts/check-native-type-closure.ts:118`, `:270`). |
| M: Mutation catalogue | All 36 `id`/`file` pairs in `mutations.toml` were enumerated. None targets `claustrum-scoped*`, old setup, sidecar writers, retired slot creation or the custody-verdict files. The three rows targeting `accounts.ts` guard **live** `killswitchPassesPolicy`, not sidecar persistence (`mutations.toml:490-536`); retain these controls because their quota-evidence fences remain on the request path. Vault affinity rows guard the retained router (`:314-360`), and native authority/enrollment rows stay live (`:554-600`). Do not delete catalogue rows merely because their file also contains dead code. |
| N: Documentation references | Obsolete runtime/sidecar descriptions are in `ARCHITECTURE.md:46-52`, `:68-84`, `:124-130`, `:192-195`, `:252-254`; directory descriptions in `STRUCTURE.md:40`, `:49`, `:94-103`, `:144-145`, and old command guidance at `:177-185`. Additional stale descriptions name scoped runtime in `docs/feature-catalogue.md:65-82` and profile sidecars in `docs/quota-surfaces.md:170-179`. `docs/custody-state-machine.md:3`, `:27-45` correctly distinguishes legacy migration sources from current native storage. Documentation is not runtime reachability, but references must be reconciled after approval, not silently ignored. |

Exact-name grep covered `packages/` including test/support sources, and each
candidate's spelling/module path in `scripts/`, `.github/`, `mutations.toml`,
root documentation and `docs/`. In particular it covered the scoped APIs,
`setupClaustrumForHost`, the loader/writer names in the table, custody helpers,
slot identity APIs and handle/capability spellings. Imports/aliases and type-only
mentions were separated from calls. Old setup's only import sites are its tests
(`packages/opencode/src/tests/setup-command.test.ts:291`, `:400`, `:505`, `:584`);
the actual CLI setup entry calls the native wizard
(`packages/opencode/src/cli.ts:474-505`).

### External Core consumers (read-only survey)

An exact package-string search for `@cortexkit/anthropic-auth-core` covered sibling
projects under `/Users/ufukaltinok/Work/Projects/CortexKit/`. The anthropic-auth
parent checkout was **not read**. Hidden AFT scratch worktrees, ignored dependency
and build directories, binaries, and projects outside that directory were not
surveyed. This does not establish absence of constructed/aliased package strings
or remote/npm consumers.

| Sibling | Evidence / imported exported names |
| --- | --- |
| `synapse` | Actual production named imports: `resolveClaudeCodeIdentity`, `buildBillingHeaderValue`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_IDENTITY`, `applyClaudeCodeMetadata`, `applyClaudeCodeHeaders`, `signRequestBody`, `orderClaudeCodeBody` (`synapse/tools/gather-distill/src/anthropic.ts:1-10`, use at `:139-151`). Dependency is **^1.23.0**, not 2.0 (`synapse/tools/gather-distill/package.json:5-6`). Test imports `CLAUDE_CODE_IDENTITY` (`synapse/tools/gather-distill/tests/anthropic.test.ts:2`, `:47`). No legacy scoped/writer name is among these imports; preserve the live identity/signing APIs. |
| `aft` | Simulated import strings name `PrimeManager` and type `LogTestRecord`; they are fixture/capture data, not package consumers (`aft/scripts/capture-subc-parity.ts:620-623`, `aft/crates/aft/tests/integration/import_test.rs:3845-3873`, `aft/crates/aft/tests/fixtures/subc_parity/format/import_add_partial_names/input.json:1-29`, `aft/docs/v0.49-legacy-vocabulary-allowlist.json:7100-7108`). |
| `prefrontal`, `prefrontal-gate` | Only captured reader transcripts in `test-vectors/sidekick-follow-up-fleet.json:2939` and `test-vectors/sidekick-citation-fleet.json:1758` in each sibling. These are JSON data, not executable imports or evidence those siblings use exported names. |
| Other searched directories | Zero literal hits in `alfonso-desktop`, `alfonso-ios`, `alfonso-tui`, `antigravity-auth`, `astrocyte`, `avatar`, `basal`, `broca`, `callosum`, `cerebellum`, `cingulate`, `claustrum`, `common-auth`, `commons`, `cortex`, `cortexkit-account`, `cortexkit-cloud`, `cortexkit-e2e`, `design-package`, `engram`, `entorhinal`, `fusiform`, `insula`, `magic-context`, `motor`, `openai-auth`, `opencode-interceptor`, `plexus`, `subconscious-design`, `subconscious`, `thalamus`, `wernicke`, `docs`, and `benchmarks` (grep, all searchable files per directory, complete untruncated results). `creative`, `website`, and `benchmark-seed-backups` had zero searchable files under default skips: no content-absence inference for those directories. |

Sibling citations are relative to that named sibling, not this repository.

## Candidate table

Verdicts are proposals, not deletion authorization. **U1** means an internally
dead API is also used to manufacture old-installation fixtures for live tests;
deletion needs the fixture decision in **Ambiguities and approval dependencies**, item 2. Every DELETE row includes
the P/B/D/R/C/M/N audit above, not just its static-import evidence. Rows naming a
symbol are limited to that symbol and private helpers exclusively reached by
approved removals; they never authorize deleting the containing mixed module.

### Retired scoped runtime and sidecar implementation

| File or exported symbol | Evidence it is dead or alive | Verdict |
| --- | --- | --- |
| `packages/opencode/src/setup/claustrum.ts` (`setupClaustrumForHost`) | Old helper definition at `:35-48`; only its own tests dynamically import it (`packages/opencode/src/tests/setup-command.test.ts:291-297`, `:400-406`, `:505`, `:584`). Current CLI dispatch is `packages/opencode/src/cli.ts:474-505`; native wizard dependencies and stopped-host gate are `packages/opencode/src/setup/command.ts:16-18`, `:243-252`, `:298-350`. No independent package entry, build entry or runtime registry entry exists in the OpenCode manifest/build/dynamic-loading audit (P2/B/D/R). Do not confuse this file with the current stopped-host wizard. | **delete** |
| `packages/core/src/claustrum-scoped-runtime.ts` (class, connector and options) | Class constructors only in its dedicated test (G). Connector's only non-test call is the retired helper (`packages/opencode/src/setup/claustrum.ts:170-172`). It starts the legacy roster/loader path (`packages/core/src/claustrum-scoped-runtime.ts:99-159`, `:183-235`). Native connection ownership is separate (`packages/core/src/native-custody.ts:199-275`). **Public export**, `packages/core/src/index.ts:12`. | **delete** |
| `packages/core/src/claustrum-scoped-roster.ts` (projection, refresh, roster/error types) | Refresh is called by the retired runtime (`packages/core/src/claustrum-scoped-runtime.ts:141`) and retired setup (`packages/opencode/src/setup/claustrum.ts:257`); projection is called inside that refresh (`packages/core/src/claustrum-scoped-roster.ts:266`) and its own tests (`packages/core/src/tests/claustrum-scoped-roster.test.ts:154`, `:167`, `:318`, `:325`, `:451`). Pure projection is not inherently live: its consumers are in the same retired closure. Native seed has its own route mapping (`packages/core/src/native-vault-seed.ts:116-158`). **Public export**, `packages/core/src/index.ts:11`. | **delete** |
| `packages/core/src/claustrum-scoped.ts` (Core-local `ClaustrumScopedCustody`, retry helpers/types) | Core class at `:132-156`; constructors are retired runtime (`packages/core/src/claustrum-scoped-runtime.ts:110`), retired setup dynamic import (`packages/opencode/src/setup/claustrum.ts:249-255`), and own tests (`packages/core/src/tests/claustrum-scoped.test.ts:74`, `:332`, `:441`). Retry helper is used by retired runtime (`packages/core/src/claustrum-scoped-runtime.ts:296`) and own tests (`packages/core/src/tests/claustrum-scoped.test.ts:462-494`). **Name collision:** native adapter imports the **common-auth** class (`packages/core/src/native-custody.ts:1-4`, `:248`); native tests spy on that import (`packages/core/src/tests/native-custody.test.ts:13-20`, `:427-447`), not this file. **Public export**, `packages/core/src/index.ts:10`. | **delete** |
| `packages/core/src/accounts.ts::loadAccounts` and exclusive legacy normalization/merge reader closure | Legacy config/state merge at `:1279-1288`, not the deterministic raw-source migration projector (`packages/core/src/native-migration-source.ts:349-375`). Non-test references are legacy persistence, runtime/roster and routing (`packages/core/src/accounts.ts:1677`, `:1883`, `:1941`, `:4407`; `packages/core/src/claustrum-scoped-runtime.ts:132`, `:189`; `packages/core/src/claustrum-scoped-roster.ts:204-216`; `packages/core/src/routing.ts:42`). Current OpenCode shadow reads native runtime (`packages/opencode/src/index.ts:1324-1367`); Pi references are only test fixtures (`packages/pi/src/tests/custody.test.ts:8-9`, `:26-49`). **Public export** (Core root barrel; audit P1); **U1**, native/migration fixtures still use it (`packages/opencode/src/tests/index.test.ts:1828`). Retain independent path/type/policy/seed readers below. | **delete**, conditional on U1 |
| `packages/core/src/accounts.ts::saveAccounts` / `SaveAccountsOptions` and exclusive config-write closure | Writer at `:1855-1862`, options at `:1725-1735`; legacy settings/routing callers in G, not current host writers (`packages/opencode/src/index.ts:1368-1485`). Calls in tests include dedicated persistence (`packages/core/src/tests/accounts-persistence.test.ts:40-59`) and mixed/live fixture manufacture (`packages/opencode/src/tests/index.test.ts:847-869`, `packages/pi/src/tests/custody.test.ts:26`). **Public export** (Core root barrel; audit P1); **U1**. | **delete**, conditional on U1 |
| `packages/core/src/accounts.ts::mutateAccountsPersistent` and exclusive config-mutation closure | Locked mutation at `:1864-1897`; callers are retired roster (`packages/core/src/claustrum-scoped-roster.ts:259`) and legacy CRUD writers (`packages/core/src/accounts.ts:3728`, `:3754`, `:3769`, `:3797`). **Public export** (Core root barrel; audit P1); covered by retired roster tests (`packages/core/src/tests/claustrum-scoped-roster.test.ts:183-229`) and CRUD tests (`packages/opencode/src/tests/accounts.test.ts:6825-6947`). | **delete** |
| `packages/core/src/accounts.ts::saveAccountState` / `AccountStateSaveScope` and exclusive state-write closure | State writer at `:2224-2243`, scope at `:421-427`; non-test caller is legacy manager (`:4411-4414`). Own persistence test at `packages/core/src/tests/accounts-persistence.test.ts:189-191`. Live migration fixtures also invoke it (`packages/opencode/src/tests/index.test.ts:844-865`, `:5313`). **Public export** (Core root barrel; audit P1); **U1**. | **delete**, conditional on U1 |
| `packages/core/src/accounts.ts::saveOAuthProfileState` and exclusive profile-write closure | Legacy state writer at `:2245-2390`; exact-name package grep finds only tests beyond definition, including scoped roster (`packages/core/src/tests/claustrum-scoped-roster.test.ts:384-408`) and old accounts tests (`packages/opencode/src/tests/accounts.test.ts:869-1104`). Native profile fetching/publishing is separate (`packages/core/src/native-account-runtime.ts:86`, `:1524`). **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::getOrCreateMainAccountId` | Sidecar slot allocation at `:1899-1921`; only tests call it (`packages/core/src/tests/prime.test.ts:465`, `packages/opencode/src/tests/accounts.test.ts:209-223`, `:7409`). Native wire identity uses verified UUIDs instead (`packages/opencode/src/index.ts:1531-1541`). **Public export** (Core root barrel; audit P1). Does not authorize removing migration's `formerMainRowId` or native routing alias. | **delete** |
| `packages/core/src/accounts.ts::setClaustrumModePersistent` | Legacy sidecar mode writer at `:1670-1689`; only non-test caller is retired setup (`packages/opencode/src/setup/claustrum.ts:242-260`). Other calls are own/retired tests (`packages/core/src/tests/claustrum-scoped-runtime.test.ts:38`, `:183`, `:365`, `packages/core/src/tests/claustrum-scoped-roster.test.ts:79`, `:259`, `:428`). Native mode derives from enrollment (`packages/opencode/src/index.ts:1346-1356`). **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setCache1hPersistentEnabled` | Legacy writer `:2862-2875`; own tests `packages/opencode/src/tests/accounts.test.ts:3106-3118`. Same-named current host function is a native settings adapter (`packages/opencode/src/index.ts:1404-1417`), not this export. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setCache1hPersistentMode` | Legacy writer `:2877-2889`; own test `packages/opencode/src/tests/accounts.test.ts:3112`. Current same-named local native-settings adapter at `packages/opencode/src/index.ts:1419-1421`. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setDumpPersistentEnabled` | Legacy writer `:2895-2906`; exact-name package grep finds definition and OpenCode's **local** adapter/call (`packages/opencode/src/index.ts:1450-1451`, `:4645`), not a Core import. Pi dispatch uses native settings (`packages/pi/src/native-commands.ts:299-305`). **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setFastModePersistentEnabled` | Legacy writer `:2912-2923`; own tests `packages/opencode/src/tests/accounts.test.ts:3171-3177`; current same-named local native-settings adapter `packages/opencode/src/index.ts:1452-1453`. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setCacheKeepPersistentWindow` | Legacy writer `:2925-2940`; own tests `packages/opencode/src/tests/accounts.test.ts:3125`, `:3143`; current same-named local native-settings adapter `packages/opencode/src/index.ts:1441-1447`. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setCacheKeepPersistentAlways` | Legacy writer `:2942-2955`; own test `packages/opencode/src/tests/accounts.test.ts:3145`; current same-named local native-settings adapter `packages/opencode/src/index.ts:1427-1440`. The live cross-host duplicate is a separate FOLD row, not this sidecar writer. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setCacheKeepPersistentEnabled` | Legacy writer `:2957-2968`; own test `packages/opencode/src/tests/accounts.test.ts:3132`; current same-named local native-settings adapter `packages/opencode/src/index.ts:1422-1423`. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setCacheKeepSubagentsEnabled` | Legacy writer `:2974-2985`; own tests `packages/opencode/src/tests/accounts.test.ts:3142`, `:3159-3163`; current same-named local native-settings adapter `packages/opencode/src/index.ts:1448-1449`. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setPrimePersistentEnabled` | Legacy writer `:2991-3002`; own tests `packages/opencode/src/tests/accounts.test.ts:7117-7140`. OpenCode command calls resolve to the local native adapter (`packages/opencode/src/index.ts:1461-1464`, `:4729-4747`), not Core. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::getOrCreatePrimeAuthLineageId` | Sidecar lineage writer at `:3004-3062`; exact-name package references outside definition are tests (`packages/core/src/tests/prime.test.ts:484-505`, `packages/opencode/src/tests/accounts.test.ts:7387-7458`). Keep native lineage/migration schema, not this writer. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::incrementPrimeUsagePersistent` | Sidecar counter writer at `:3064-3136`; only test references (`packages/core/src/tests/prime-usage-race.test.ts:42-49`, `packages/opencode/src/tests/accounts.test.ts:7148-7367`). The race test uses a generated child **import string**, accounted for here, not a missed production loader. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setLogLevelPersistent` | Legacy writer and logger dynamic import at `:3440-3452`; own tests `packages/opencode/src/tests/accounts.test.ts:7046`, `:7074-7080`. Current host adapter invokes native runtime logging (`packages/opencode/src/index.ts:1455-1459`); Pi does likewise (`packages/pi/src/native-commands.ts:306-309`). **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setKillswitchPersistent` | Legacy writer at `:3714-3722`; own tests `packages/opencode/src/tests/killswitch.test.ts:371-394`; same-named local native-settings adapter `packages/opencode/src/index.ts:1469-1471`, `:5243`. Preserve live policy and its mutation controls (M). **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::removeAccountPersistent` | Legacy writer `:3724-3748`; own tests `packages/opencode/src/tests/accounts.test.ts:6852-6914`; same-named local native-settings adapter `packages/opencode/src/index.ts:1477-1480`, `:5032`. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::reorderAccountsPersistent` | Legacy writer `:3750-3762`; own tests `packages/opencode/src/tests/accounts.test.ts:6924-6931`; same-named local native-settings adapter `packages/opencode/src/index.ts:1481-1485`, `:5034`. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setAccountEnabledPersistent` | Legacy writer `:3764-3791`; own tests `packages/opencode/src/tests/accounts.test.ts:6937-6947`, retired runtime/roster tests (`packages/core/src/tests/claustrum-scoped-runtime.test.ts:125`, `packages/core/src/tests/claustrum-scoped-roster.test.ts:113`, `:193`). Current shadow `packages/opencode/src/index.ts:1472-1476`, `:5026`. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::addAccountPersistent` | Legacy writer `:3793-3829`; own tests `packages/opencode/src/tests/accounts.test.ts:6825-6834`, `:7058-7062` and retired roster test `packages/core/src/tests/claustrum-scoped-roster.test.ts:429`. Native Pi adds through runtime (`packages/pi/src/native-commands.ts:119-132`). **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::persistFallbackQuotaHeaderPersistent` | Sidecar header writer `:4195-4239`; exact package references only definition and own test (`packages/opencode/src/tests/accounts.test.ts:6599`). Do not remove the independent quota-merging policy helper at `packages/core/src/accounts.ts:1453-1482` alongside this writer. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::upsertAccount` | In-memory helper at `:4154-4193`; non-test use is legacy add (`:3807`). Own tests in `packages/opencode/src/tests/accounts.test.ts:6432-6553` (and setup at `:778`). No current host import/call found; Pi has none. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::removeAccount` | In-memory helper at `:4249-4254`; non-test use is legacy remove (`:3740`). Own tests in `packages/opencode/src/tests/accounts.test.ts:6625-6636`. No current host import/call found; Pi has none. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::reorderAccounts` | In-memory helper at `:4256-4262`; non-test use is legacy reorder (`:3755`). Own tests in `packages/opencode/src/tests/accounts.test.ts:6640-6663`. No current host import/call found; Pi has none. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::setAccountEnabled` | In-memory helper at `:4264-4273`; non-test use is legacy enable (`:3770`). Own tests in `packages/opencode/src/tests/accounts.test.ts:6668-6690`. No current host import/call found; Pi has none. **Public export** (Core root barrel; audit P1). | **delete** |
| `packages/core/src/accounts.ts::FallbackAccountManager` / `AccountManagerOptions` and exclusive manager helpers | Class/options at `:4324-5160`, `:469-494`. Exact-name constructor/subclass/namespace grep finds only tests: `packages/core/src/tests/accounts-persistence.test.ts:226`, `packages/core/src/tests/background-error-logging.test.ts:512`, `:719`, `packages/opencode/src/tests/accounts.test.ts:598-599`, `:3249-5299`, `:5979-6131`. Not instantiated by either current host. Native runtime has an explicit no-legacy-dependency regression (`packages/core/src/tests/native-account-runtime.test.ts:110-126`). **Public exports** (Core root barrel; audit P1). Shared quota/policy/lock functions are KEEP below. | **delete** |
| `packages/core/src/routing.ts::setRoutingMode` | Sidecar read/write at `:38-49`. No host import found: OpenCode declares a same-named local native-settings adapter at `packages/opencode/src/index.ts:1465-1468`, and Pi dispatches `setSection` (`packages/pi/src/native-commands.ts:233-235`). Preserve routing parsing/status/modes in the same module (`packages/core/src/routing.ts:10-36`, `:51-124`). **Public export**, `packages/core/src/index.ts:241`. | **delete** |

### Supported migration, seed, setup, refusal and runtime paths

| File or exported symbol | Evidence it is dead or alive | Verdict |
| --- | --- | --- |
| `packages/core/src/native-migration-source.ts` and `packages/core/src/migration-source.ts` | Deterministic old config/state/auth projection and source-row verification (`packages/core/src/native-migration-source.ts:349-375`, `:647-685`) feed offline migration (`packages/core/src/native-migration.ts:32-46`, `:338-345`). Raw bounded source reading is also used for host auth (`packages/core/src/native-host-auth-read.ts:1`). These are 1.x→2.0 readers, not abandoned runtime loaders. | **keep** |
| `packages/core/src/native-migration.ts` / migration journal authority | Supported offline prepare/run paths (`packages/core/src/native-migration.ts:184`, `:624`), refusal/remediation (`:67-84`), and sticky-source transfer (`:500`). Wizard calls native migration (`packages/opencode/src/setup/command.ts:298-320`). **Public exports**, `packages/core/src/index.ts:121-132`, `:214-218`. Preserve committed/retired journal states; they are not the retired main-slot writer. | **keep** |
| `packages/core/src/native-vault-seed.ts` (all legacy JSON/settings/route readers) | Raw JSON/absence readers (`:15-35`), allowlisted old settings (`:56-105`) and verified roster route mapping (`:116-158`). Actual importers include `packages/core/src/pool-store.ts:10-14`, `packages/core/src/native-vault-runtime.ts:66-69`, `packages/core/src/sticky-routing.ts:21-25`, `packages/core/src/native-account-view.ts:25`, `packages/core/src/native-account-runtime.ts:85`. Must survive one-time seed and native startup. | **keep** |
| `packages/core/src/sticky-routing.ts` (including `migrateStickyRoutingState` and legacy seed) | Offline migration imports/calls legacy sticky conversion (`packages/core/src/native-migration.ts:65`, `:500`); one-time vault seed reads old config/routing and marks completion (`packages/core/src/sticky-routing.ts:680-730`). Current host dispatch uses the router (`packages/opencode/src/index.ts:4704`, `packages/pi/src/stream.ts:1-66`). Mutation controls at `mutations.toml:314-360` still guard UUID fences. **Public export**, `packages/core/src/index.ts:253`. | **keep** |
| `packages/core/src/accounts.ts` storage path/constants, account/policy/runtime types and pure policy/codec helpers | Old source locations remain the native storage identity and migration input, not an excuse to erase the whole module: path functions/constants at `:30-31`, `:533-546`; shared types at `:49-99`, `:173-427`; policy at `:3536-3712`. Current native code imports quota functionality (`packages/core/src/native-account-runtime.ts:12`, `:1423`, `packages/core/src/native-vault-runtime.ts:16`, `:743`), while mutation rows guard `killswitchPassesPolicy` (`mutations.toml:490-536`). **Public exports** (Core root barrel; audit P1). Delete only approved dead symbol closures; a normalizer shared with a retained pure codec stays. | **keep** |
| `packages/core/src/accounts.ts::acquireRefreshFileLock` | Local implementation at `:2603-2843`; actual uses include quota physical-dispatch coordination (`packages/core/src/quota-manager.ts:1012`, `:1141`), sticky lock (`packages/core/src/sticky-routing.ts:612`) and enrollment (`packages/core/src/claustrum-enrollment.ts:29`, `:477`, `:660`). Native code also imports a common-auth lock with the same name (`packages/core/src/native-refresh-coordinator.ts:4`, `:643`); do not use that collision as removal evidence. **Public export** (Core root barrel; audit P1). | **keep** |
| `packages/core/src/accounts.ts::fetchOAuthQuotaSnapshot` and quota/error/backoff/merge helpers | Physical fetch at `:4086-4142` is called by native local/vault runtimes (`packages/core/src/native-account-runtime.ts:1423`, `packages/core/src/native-vault-runtime.ts:743`) and quota manager (`packages/core/src/quota-manager.ts:1047`, `:1173`). Dedicated shared tests include `packages/core/src/tests/quota-surfaces.test.ts:3`, `:90`, `packages/core/src/tests/native-quota-codec.test.ts:391`. **Public exports** (Core root barrel; audit P1). Not all old-manager helpers are exclusive to that manager. | **keep** |
| `packages/core/src/oauth-profile.ts` | Native account runtime imports and calls profile fetch (`packages/core/src/native-account-runtime.ts:86`, `:1524`), tested in `packages/core/src/tests/native-account-runtime.test.ts:161-194`. Keep the fetcher; delete only legacy `saveOAuthProfileState`. **Public export**, `packages/core/src/index.ts:212`. | **keep** |
| `packages/core/src/claustrum.ts` (connection discovery and tombstone/refusal helpers) | Native runtime registry imports connection resolution (`packages/core/src/native-runtime-registry.ts:2`). Provider tombstones and refresh/login refusal helpers at `packages/core/src/claustrum.ts:212-272` are used by native host-auth/migration/activation (`packages/core/src/native-host-auth.ts:3`, `packages/core/src/native-migration.ts:11`, `packages/core/src/native-custody-activation.ts:13`) and OAuth/profile code (`packages/core/src/auth.ts:1`, `packages/core/src/oauth-profile.ts:2`). This file is not a handle-era credential service. **Public export**, `packages/core/src/index.ts:8`. | **keep** |
| `packages/core/src/claustrum-enrollment.ts` and native enrollment authority | Per-host token paths are read by native custody (`packages/core/src/native-custody.ts:5`, `:265`); stopped-host enrollment/activation remain wired (`packages/opencode/src/setup/native-enrollment.ts:44-65`, `:89-107`, `:117-160`, `packages/opencode/src/setup/native-activation.ts:79-125`). Host mode is read on native dispatch (`packages/opencode/src/index.ts:5971`). **Public exports**, `packages/core/src/index.ts:9`, `:68`. No whole-file deletion of enrollment state/readers is proposed. | **keep** |
| `packages/core/src/native-custody.ts` and common-auth `ClaustrumScopedCustody` | Correct import source at `:1-4`, constructor at `:248`, native discover/authorize/report/retry at `:315-395`. Native receipt provenance tests import common-auth (`packages/core/src/tests/native-custody.test.ts:13-20`, `:427-447`). **Public Core adapter exports**, `packages/core/src/index.ts:45-57`; the common-auth class is not Core's retired root export. | **keep** |
| `packages/opencode/src/setup/{command,native-enrollment,native-activation,native-login,process-fence}.ts` | CLI setup reaches current wizard (`packages/opencode/src/cli.ts:474-505`); stopped-host gate and migrations/activation (`packages/opencode/src/setup/command.ts:243-252`, `:298-350`). Native enrollment fences grant/poll (`packages/opencode/src/setup/native-enrollment.ts:89-107`, `:117-160`), activation fences host writes and Pi conflicts (`packages/opencode/src/setup/native-activation.ts:79-165`), and login verifies identity (`packages/opencode/src/setup/native-login.ts:10-45`). Not the old `setup/claustrum.ts`. | **keep** |
| OpenCode unmigrated/marker admission and Pi prompt refusal | OpenCode startup passes migration authority to the live custody check (`packages/opencode/src/index.ts:5995-6015`); no committed/retired authority throws `MIGRATION_REQUIRED` (`packages/opencode/src/custody-mode.ts:41-43`). Pi startup installs Anthropic-only refusal after migration-required initialization (`packages/pi/src/index.ts:47-66`, `:256-300`), while migrated stores retain normal auth (`packages/pi/src/tests/unmigrated-upgrade.test.ts:365-398`). Refusal is supported behavior, not dead setup code. | **keep** |
| `packages/opencode/src/custody-mode.ts` (verdict/error table) | Call graph and source both show loader call (`packages/opencode/src/index.ts:5999-6015`); error also appears in status (`:5166-5167`). `LOCAL_SERVE`/`CLAUSTRUM_SERVE` acceptance and fail-closed branch are explicit at `packages/opencode/src/custody-mode.ts:34-61`. Own tests at `packages/opencode/src/tests/custody-mode.test.ts:9`, `:18`, `:34`, `:44` are not its only consumers. The premise that the table is no longer called is false at this commit. | **keep** |
| `packages/opencode/src/custody-dimensions.ts` | Loader uses fallback/main dimensions (`packages/opencode/src/index.ts:5995-6002`); serving/status uses vault membership and custody status (`:2929`, `:4005`, `:5083-5086`, `:7476`). Definitions at `packages/opencode/src/custody-dimensions.ts:11-97` operate on native AccountStorage-shaped projections, not necessarily sidecar reads. Own tests `packages/opencode/src/tests/custody-dimensions.test.ts:42-67` remain relevant. | **keep** |
| `packages/pi/src/custody.ts` | Commands are registered through `createPiNativeCommands` (`packages/pi/src/native-commands.ts:45-50`, `packages/pi/src/index.ts:74-78`). `transition` gives offline guidance without granting authority (`packages/pi/src/custody.ts:33-61`); tests exercise live guidance/refusal (`packages/pi/src/tests/custody.test.ts:40-83`). Not a dead custody-switch implementation. **U1** for test fixture, not production code. | **keep** |
| `packages/core/src/claude-code.ts` identity/bootstrap APIs, including `resolveClaudeCodeIdentity` | Native wire identities use verified-account helper (`packages/opencode/src/index.ts:1531-1541`, `packages/opencode/src/v2/source.ts:495-541`). Offline login still invokes resolver (`packages/opencode/src/setup/native-login.ts:10-45`). External Synapse imports/uses resolver and metadata/headers (`synapse/tools/gather-distill/src/anthropic.ts:1-10`, `:139-151`, pinned ^1.23.0). The slot-replacement test still claims protection against old UUID reuse (`packages/opencode/src/tests/claude-code.test.ts:520-542`). **Public exports**, `packages/core/src/index.ts:7`. No deletion of compatibility branches solely because the main-slot allocator is dead. | **keep** |
| OpenCode `resolveMainQuotaAccountIdentity`, native routing `main`, migration `formerMainRowId` | Live quota resolver/slot fallback at `packages/opencode/src/index.ts:1913-2041`, native wire UUID at `:1531-1541`; `STICKY_ROUTING_MAIN_ACCOUNT_ID` is the routing alias (`packages/core/src/sticky-routing.ts:27`, OpenCode route uses `packages/opencode/src/index.ts:7567-7584`), not a minted provider identity. Migration preserves former main row (`packages/core/src/native-migration-source.ts:378-391`). **Public routing constant** (`packages/core/src/index.ts:253`); do not conflate it with `getOrCreateMainAccountId`. | **keep** |
| `packages/core/src/prime.ts` (manager, marker and pure command/status APIs) | Current OpenCode enables/stops native-backed Prime (`packages/opencode/src/index.ts:4729-4747`); shared Prime imports pure account policy/types rather than sidecar writers (`packages/core/src/prime.ts:7-16`). Only sidecar counter/lineage writers and their tests are DELETE rows. **Public exports**, `packages/core/src/index.ts:223`; external AFT occurrences are simulated fixture imports, not an additional runtime path. | **keep** |

### Cross-host duplicate logic

| File or exported symbol | Evidence it is dead or alive | Verdict |
| --- | --- | --- |
| Native settings section-merge transformation: OpenCode `updateNativeSection`/`plainSettingsSection` and Pi `setSection`/`record` | Both preserve root settings and shallow-merge a record-valued section: `packages/opencode/src/index.ts:1368-1400` versus `packages/pi/src/native-commands.ts:39-59`. Both run against `NativeAccountRuntime.updateSettings`; calls are live native settings dispatch (`packages/opencode/src/index.ts:1441-1471`, `packages/pi/src/native-commands.ts:233-269`, `:283-317`). Move only the host-independent transformation into Core, retaining host return values, logging/effects and validated action routing. No sidecar writer revival. | **fold into Core** |
| Native CacheKeep “always” transformation: OpenCode local `setCacheKeepPersistentAlways` and Pi `cachekeep-always` dispatch case | Both remove `startHour`/`endHour`, preserve other section fields and set `enabled: true, always: true` (`packages/opencode/src/index.ts:1427-1440`, `packages/pi/src/native-commands.ts:270-282`). Live regression tests: `packages/opencode/src/tests/native-menu-settings.test.ts:225-236`, `packages/pi/src/tests/commands.test.ts:276-277`. Fold the pure transformation, not notifications, native effects or command text. | **fold into Core** |
| Native `cache-on` semantics and host dispatch adapters | **Not identical**: OpenCode records an effective mode when absent (`packages/opencode/src/index.ts:1401-1417`, regression `packages/opencode/src/tests/native-menu-settings.test.ts:192`); Pi's case only patches `enabled` (`packages/pi/src/native-commands.ts:261-266`). Also Pi transcript/effort/OAuth transport adapters have host-specific inputs (`packages/pi/src/transcript.ts:8-31`, `:73-144`, `packages/pi/src/effort-history.ts:76-130`, `packages/pi/src/transport.ts:1-42`). Similar intent is not duplicate behavior. Do not unify these semantics during cleanup. | **keep** |

The duplicate detector was also run over both host source trees: 16 groups
touched the scope, but none was a production OpenCode/Pi cross-package pair.
That detector does not prove semantic non-duplication; the two FOLD proposals
above come from direct source comparison, not from a clone-score assumption.

### Test candidates (not blanket package-suite deletions)

| File or exported symbol | Evidence it is dead or alive | Verdict |
| --- | --- | --- |
| `packages/core/src/tests/claustrum-scoped-runtime.test.ts` | Constructs and exercises only the retired runtime class (`:16`, `:98`, `:161`, `:223`, `:292`, `:327`, `:373`, `:424`, `:439`), including legacy mode/roster fixtures (`:37-38`, `:364-365`). Native custody tests are a different file/import (see KEEP row). | **delete** |
| `packages/core/src/tests/claustrum-scoped-roster.test.ts` | Imports old projection/refresh and sidecar writers (`:7-22`); exercises old locked roster and persistence (`:85-146`, `:183-229`, `:346-451`). Native seed tests instead exercise the supported native seed through runtime/store/router imports (`packages/core/src/tests/native-vault-legacy-seed.test.ts:7-20`). | **delete** |
| `packages/core/src/tests/claustrum-scoped.test.ts` | Imports the Core-local custody/retry APIs (`:7-18`) and constructs that class (`:74`, `:332`, `:441`), tests retired retry-site policy (`:462-494`). Native test imports common-auth (`packages/core/src/tests/native-custody.test.ts:13-20`), so it is not deletion evidence for native receipt tests. | **delete** |
| `packages/core/src/tests/accounts-persistence.test.ts` | Dedicated legacy loader/config/state/manager tests (`:9-15`, `:40-59`, `:189-191`, `:226-244`). Supported source/migration tests are separate (`packages/core/src/tests/native-migration-source.test.ts:2-21`, `packages/core/src/tests/native-routing-migration.test.ts:7-11`). | **delete** |
| `packages/core/src/tests/prime-usage-race.test.ts` | Fixture saves sidecar (`:7`, `:32`), generated child imports/increments legacy counter (`:42-49`), then reads sidecar (`:81`). Only guards the proposed-deleted writer; not the live Prime marker or native usage-publication path. | **delete** |
| `packages/core/src/tests/prime.test.ts` — `Prime main identity lineage` block only | Sole test `main identity stays stable across refresh token rotation` checks stable sidecar main-account identity and Prime counter attribution across token rotation, invoking dead slot/lineage/state writers (`:462-509`). The next block begins live `PrimeManager` due-boundary tests (`:511-514`): preserve those and the rest of the suite. | **delete** (named block only) |
| `packages/opencode/src/tests/accounts.test.ts` — unambiguously legacy-only named blocks | Candidate blocks: `main account identity` (`:169-228`), `scoped account-state membership` (`:229-314`), `custody account-state persistence` (`:315-415`), `FallbackAccountManager` (`:3249-5335`), `isPermanentRefreshError across save/load round-trip` (`:5543-5628`), `isTransientRefreshError via duck-typed error classification` (`:5633-5700`), `isTransientQuotaError via duck-typed error classification` (`:5734-5787`), `recordQuotaRefreshError refresh-backoff arming` (`:5962-6146`), `writeJsonAtomic temp cleanup` (`:6150-6177`), `readJsonIfPresent corrupt-store handling` (`:6181-6225`), `saveAccountState lost-update race (#9)` (`:6343-6429`), `upsertAccount` (`:6432-6565`), `removeAccount` (`:6625-6639`), `reorderAccounts` (`:6640-6667`), `setAccountEnabled` (`:6668-6693`), `multi-account persistence` (`:6696-6851`), `removeAccountPersistent` (`:6852-6923`), `reorderAccountsPersistent` (`:6924-6936`), `setAccountEnabledPersistent` (`:6937-6954`), `addAccountPersistent` (`:7058-7071`), `setLogLevelPersistent` (`:7074-7089`), `setPrimePersistentEnabled` (`:7123-7147`), `incrementPrimeUsagePersistent` (`:7148-7386`), `getOrCreatePrimeAuthLineageId` (`:7387-7458`). These names map to legacy loader/writer/manager behavior in the DELETE rows; scope does **not** include neighboring pure policy/fetch/lock tests. | **delete** (listed blocks only) |
| `packages/opencode/src/tests/setup-command.test.ts` — old helper cases/fixture only | Old helper tests begin at `:204`, `:327`, `:411`; `enrollmentSetupFixture` invokes old helper dynamically at `:584-591`, feeding the parameterized cases at `:596-714`. Native wizard/process-fence tests start at `:76-203`, offline login at `:716`, and native setup diagnostics at `:1046`; keep those. | **delete** (old-helper cases only) |
| `packages/core/src/tests/background-error-logging.test.ts` — legacy fallback-only case | `fallback OAuth background refresh failure logs the account id, not the provider body` (`:498`, legacy save/manager at `:510-512`) exercises the retired manager only. The other CacheKeep/Prime/child ownership tests remain live (`:241`, `:282`, `:408`, `:448`, `:617`). | **delete** (one named case only) |
| Mixed/live tests using obsolete fixture helpers — OpenCode `index.test.ts`, Pi `custody.test.ts`, mixed accounts/killswitch/logging suites | **U1/U2:** OpenCode's migration fixture explicitly serializes old config/state with the legacy APIs (`packages/opencode/src/tests/index.test.ts:843-881`); Pi live offline-guidance test fixtures save/read old files (`packages/pi/src/tests/custody.test.ts:8-9`, `:26-49`). `packages/opencode/src/tests/accounts.test.ts` also tests live pure policy/lock/fetch functions (`:1113-1157`, `:2799-3043`, `:5336-5542`, `:5704-5733`, `:5791-5957`, `:6229-6338`, `:7092-7122`). One logging test combines live dump behavior with obsolete cached-quota diagnostics in a generated child (`packages/core/src/tests/background-error-logging.test.ts:673-729`). Cannot delete entire files or invert assertions just to remove a dependency. | **keep** — ambiguous fixture/partial-block boundary |
| Native custody, migration/seed/refusal, lock, quota, killswitch, identity and import/type-closure regression suites | Actual live imports/calls are documented in KEEP rows; the import guard's synthetic `loadAccounts` string is intentional (`scripts/check-pi-dist-imports.test.ts:117-135`), and native runtime's ban on legacy dependencies remains meaningful (`packages/core/src/tests/native-account-runtime.test.ts:110-126`). Keep tests unchanged, including common-auth receipt/version assertions (`packages/core/src/tests/native-custody.test.ts:427-447`). | **keep** |

## Ambiguities and approval dependencies

1. **Public API:** every root-exported DELETE row is internally dead but publicly
   importable. The sibling survey finds no executable consumer of those proposed
   removals, but cannot prove none exists. Owner review decides the export/semver
   policy; this inventory does not decide it (P1, external survey).
2. **U1 — fixture dependency versus unchanged remaining tests:** removing
   `loadAccounts`/`saveAccounts`/`saveAccountState` breaks live test fixture
   construction even though no supported runtime uses those functions. The
   serialized legacy bytes are themselves supported migration inputs
   (`packages/opencode/src/tests/index.test.ts:843-881`). Approval must choose
   either to retain the fixture-required APIs for now, or explicitly allow a
   test-only old-format serializer/reader while preserving every remaining
   assertion and the represented old-installation bytes. The latter is a fixture
   change, so it must not be smuggled into “remaining tests unchanged.” No such
   change is made in Phase 1.
3. **U2 — mixed blocks:** do not approve deletion of whole `accounts.test.ts`,
   `setup-command.test.ts`, `background-error-logging.test.ts` or Pi
   `custody.test.ts`. Named obsolete blocks can go; mixed profile/backoff/mode
   blocks and the combined dump/cached-quota logging test need a narrower decision
   (`packages/opencode/src/tests/accounts.test.ts:416-1157`, `:6955-7057`,
   `packages/core/src/tests/background-error-logging.test.ts:673-729`).
4. **“custody-live” / “handle-era”:** no file/symbol called `custody-live`,
   `custodyLive`, or `CustodyLive`, nor Core handle/capability credential service,
   was located by literal/module-path and handle/capability searches at this
   commit. The concrete verdict table found is still called
   (`packages/opencode/src/custody-mode.ts:34-61`,
   `packages/opencode/src/index.ts:5999`). Handle-era config fields/markers must
   not be erased merely because they are old: migration/refusal readers and
   tombstones remain live (`packages/core/src/native-migration-source.ts:349-375`,
   `packages/core/src/claustrum.ts:212-272`). If those labels refer to another
   exported symbol, identify it before approving deletion; there is no guessed
   DELETE row for an unlocated label.
5. **Private helper closure:** the proposal never deletes a private helper also
   used by kept quota/policy/identity/enrollment code. Verify the retained call
   closure and declaration output while implementing each approved symbol, not
   by deleting all of `accounts.ts` (P1, KEEP rows, mutation controls M).

## Phase 2 handoff (not executed here)

- Apply only approved rows and any explicitly approved U1/U2 resolution. Keep
  supported migration/seed/stopped-host/refusal behavior and remaining assertions.
- Update the stale `ARCHITECTURE.md` and `STRUCTURE.md` references listed in the
  documentation audit row. Review the additional
  stale feature/profile docs rather than leaving a named removed runtime as
  documentation of the current system (`docs/feature-catalogue.md:65-82`,
  `docs/quota-surfaces.md:170-179`); obtain scope approval for extra doc edits.
- Keep all 36 existing mutation controls unless an approved change actually
  removes a guarded code fragment. In particular preserve the three live
  `accounts.ts` killswitch rows (`mutations.toml:490-536`). Revalidate the
  catalogue against the resulting source, not its filename alone.
- Capture old and new full-suite counts per package before deliberately adjusting
  `.ci/test-count-floors.json`; Phase 1 neither runs/removes suites nor lowers
  floors. Do not substitute current floor values for measured old test counts.
- On pinned remote `/usr/local/bin/bun-1.3.14`, no `,net`: rebuild Core before
  dependents, then full Core/OpenCode-offline/Pi suites, every typecheck, Pi
  dist-import guard and packed-type closure. Require comment review, fenced
  commits and a clean worktree. These Phase 2 gates are deferred until approval.

## Phase 2 owner decisions and narrowly approved additions

Core is internal to the hosts except the eight stable Synapse values listed in
`packages/core/README.md` and pinned by `src/tests/export-manifest.test.ts`.
There is no version bump. Conditional fixture removals are unblocked by a
**test-only** archived serializer and checked-in npm-published 1.23.0 golden bytes;
production never imports that serializer. Existing runtime assertions remain.
The named `setKillswitchPersistent` test block accompanying that DELETE symbol
is removed; neighboring killswitch policy/command tests remain.

| Additional file/block | Evidence and retained coverage | Verdict |
| --- | --- | --- |
| OpenCode `accounts.test.ts` — `fallback quota polling` (baseline lines 579–644) | Constructs two retired managers and tests a custody-verification lock versus quota polling; a serializer cannot perform those operations. Owner explicitly approved removing only this additional legacy-only block. Native `quota-sweep.test.ts` tests serialized due sweeps (`a background sweep started during the held startup usage GET...`, baseline `:635`) and coalesced request reads (`:688`); Core `quota-dispatch.test.ts` tests physical dispatch pacing and lock losers (`:72`, `:121`). Those tests cover overlapping/duplicate polls, **not an asserted equivalent of the specific two-instance retired-manager verification/poll race**. | **delete** |
| Core `claustrum-client-compatibility.test.ts` — retired Core receipt type-only tuple entry (baseline lines 84–97), matching `true` | Owner approved removing only the assertion about deleted Core-local `ClaustrumScopedAttempt.accountId`; all runtime and producer/common-auth client compatibility assertions stay. The live common-auth receipt has `assertedAccountIdentity`, already checked by `native-custody.test.ts`'s `actual served identity assertion` (`:217-228`), including receipt provenance checks elsewhere in that suite. No old receipt shim or new contract is introduced. | **delete** |

The combined dump/cached-quota logging case remains. Its removed manager producer
is represented by the archived diagnostic supplied to the **real** production
logger; dump/error redaction and exact log assertions remain unchanged. It no
longer claims to exercise retired manager account selection.

`ARCHITECTURE.md` and `STRUCTURE.md` were present at the inventory commit and are
updated in place; no compatibility documentation path was invented.

| Additional file/block | Evidence and retained coverage | Verdict |
| --- | --- | --- |
| OpenCode `custody-tombstone.test.ts` — `fallback refresh rejects the tombstone without network or refresh classification` | Owner approved removal of only this parameterized legacy-manager case (pre-removal `:846-910`); neighboring native/plugin tombstone cases remain unchanged. Native coordinator regressions in `packages/core/src/tests/native-refresh-coordinator.test.ts:3898-3947` cover Anthropic, OpenAI and unrecognized-provider tombstone keys, before any provider request, with no failed observation or persisted error/backoff state. They exercise a bound native local row named `sentinel`; they are **not an end-to-end OpenCode fallback-route selection test**, so no route-equivalence claim is made. | **delete** |

## Measured cleanup verification

Pinned Bun 1.3.14, TypeScript 7.0.2; Core rebuilt before host gates. The offline
OpenCode suite explicitly excludes the registry-installing
`opencode2-e2e.test.ts`; no remote command requested network. The same offline
selection was used for both measurements, with a 30-second test timeout.

| Package | Before cleanup | After cleanup | Change |
| --- | ---: | ---: | ---: |
| Core | 1799 | 1737 | -62 (including eight new public-export and two golden-byte tests) |
| OpenCode offline | 2130 | 2000 | -130 |
| Pi | 280 | 280 | 0 |

All remaining assertions passed. Fixture code alone now owns both config and
state paths during retained accounts tests, preventing an ambient state override
from another suite from contaminating migration/profile fixtures. The 1.23.0
writer was installed in a local temporary directory and invoked once to generate
the checked-in golden config/state bytes; the test-only serializer matches them.
The Core/host/E2E/scripts type checks, Pi emitted-import guard and declaration
closure passed. All 36 mutation catalogue fragments still exist unchanged, so
no catalogue row was removed.

The fresh **packed** consumer closure test cannot install its temporary dependency
graph on the remote no-network runner. With owner approval, that test file ran
unchanged locally using pinned Bun 1.3.14: seven tests passed, consumer TypeScript
checked 379 files inside its fresh prefix, and Node 26.10.0 passed 18 packed
runtime assertions without common-auth installed. Other gates stayed remote.

Non-vacuity checks: neutralizing `CLAUDE_CODE_IDENTITY` at the actual barrel made
only `stable public Core export: CLAUDE_CODE_IDENTITY` fail (other seven passed).
A forbidden process-launch import in `native-custody.ts` made only the named
custody source-dependency fence fail. Both temporary changes were staged-baseline
mutations, then restored with empty unstaged diffs; neither ships.

The fleet layout adjustment excludes edits to the moved feature/quota documents;
those files were restored and are not part of this cleanup. The inventory stays
at its explicitly approved `docs/cleanup/` delivery path for the owner to relocate
at merge. The runtime/module documentation changes do not change the `docs/`
directory-layout line.

## Required fixture reduction after merge review

The initial 2,673-line archived module was a compatibility shim, not an acceptable
fixture writer. It is replaced by **27 lines**: raw two-space JSON serialization
with a trailing newline, optional state-file output, and a tiny single-file JSON
reader. There are no imports/re-exports of `@cortexkit/anthropic-auth-core`, copies
of account/quota type definitions, normalization,
merges, policy calculations, refresh operations or locks. Golden config/state
bytes are unchanged; fixed, already-shaped payloads are inputs to the byte test.

Live OpenCode migration/refusal tests now write explicit old-format inputs and
read the actual native account runtime. Post-migration settings changes use the
live `updatePoolSettings` service instead of writing a retired sidecar. The quota
ordering fixture explicitly gives its observed snapshot its check time, and the
streaming fallback fixture declares its account identity using the existing test
identity helper. Pi's live custody tests seed raw JSON and read only that JSON;
all mode decisions still call Core directly.

The following **70 legacy-only tests** in
`packages/opencode/src/tests/accounts.test.ts` are deleted, not kept alive by a
fixture implementation. Their subjects were the copied loader/writer/merger or
mutators (including round-trip assertions with a secondary live predicate).
Live profile fetching/freshness, locks, refresh/quota errors, quota/killswitch
policy and in-memory Core predicates remain. The NaN/finite threshold tests now
pass their fixture objects directly to live Core policy, with no legacy loader.

- `an equal-generation stale observation cannot resurrect a clear`
- `a stale main refresh error cannot resurrect a refresh clear`
- `does not echo secrets from corrupt account stores`
- `dedicated main and scoped fallback profiles survive sidecar load`
- `profile runtime fields are omitted from anthropic-auth.json`
- `re-login does not retain a previous account profile`
- `runtime merge clears a fallback profile when OAuth credentials rotate`
- `runtime merge keeps a fallback profile when OAuth credentials match`
- `delayed main profile clear preserves a newer profile for the same token`
- `delayed fallback profile clear preserves a newer profile for the same token`
- `rotated access token reuses the same account profile`
- `older profile cannot overwrite newer profile for the same identity`
- `different identity does not reuse another account profile`
- `legacy profile without identity is adopted under the current identity`
- `missing identity never deletes stored profile state`
- `persists explicit behavior and defaults unknown values safely`
- `persists across save/load round-trip`
- `preserves mixed quota field provenance across a save/load round-trip`
- `keeps a reloaded poll window poll-owned during a partial header harvest`
- `filters unknown quota provenance fields and invalid sources on load`
- `drops provenance for quota fields rejected during normalization`
- `saves and loads sidecar accounts`
- `stores API fallback route secret in runtime state and endpoint in config`
- `prefers newer legacy config OAuth credentials over stale runtime state`
- `keeps newer runtime OAuth credentials over older legacy config credentials`
- `drops API fallback routes with invalid base URLs on load`
- `preserves runtime state when config membership entry is shape-invalid`
- `prunes runtime state for a fully valid config membership set`
- `uses incoming account credentials to establish config membership`
- `does not establish membership from config-owned fields on an incoming api account`
- `keeps runtime state when incoming storage cannot validate config membership`
- `does not establish membership from an id-less shape-valid config entry`
- `prunes runtime state for an explicitly empty config account list`
- `runtime state saves do not rewrite user-editable config`
- `runtime state saves preserve accounts when config is missing`
- `runtime state saves preserve whitespace-padded configured account ids`
- `loads a trimmed legacy state key for a padded configured account`
- `persists rotated credentials under the key the padded loader accepts`
- `runtime state saves preserve all state when config has a whitespace-only account id`
- `runtime state saves preserve accounts when config omits accounts`
- `treats a partially parseable populated config as unknown membership`
- `scoped saves preserve accounts when populated config membership is unknown`
- `a wholly unparseable populated config prunes nothing when storage is loaded from it`
- `generic saves preserve a newer persisted main profile`
- `runtime state saves do not overwrite newer quota snapshots`
- `equal-time stale saves do not overwrite a harvested header snapshot`
- `equal-time poll replaces headers and keeps scoped quota`
- `equal-time header snapshot can replace another header snapshot`
- `main quota ordering ignores the legacy standalone timestamp`
- `main equal-time poll beats headers and source-less saves`
- `fallback header persistence preserves newer poll-owned fields from disk`
- `main header persistence preserves newer poll-owned fields from disk`
- `fallback token rotation never rebinds the previous token quota`
- `runtime token updates drop source-less quota passthrough`
- `malformed config file throws a clear error`
- `preserves relay config when saving storage loaded by older code`
- `persists claudeCache enabled state and mode`
- `persists cacheKeep window`
- `persists cacheKeep always mode, preserves subagents, and clears the old window`
- `persists and reads cacheKeep subagents toggle`
- `persists claudeFast enabled state`
- `returns null when neither config nor state file exists`
- `reads runtime state when config file is absent (no fallback accounts)`
- `lease written via saveAccountState is visible to loadAccounts without a config file`
- `does not persist a harvested UUID after the stored lineage was replaced`
- `drops legacy custody gates rather than using them as authority`
- `defaults invalid persisted global modes to local`
- `persists global mode in config and retains it through a state save`
- `serializes a mode write with another config write without losing either field`
- `survives save/load round-trip`

This section supersedes the earlier archived-writer justification. The earlier
verification counts describe the first delivery; revised measured counts and
floor provenance accompany this reduction.

### Revised clean measurement

The final minimal-writer source commit `33144235be00c946ed1ed449f48e0caedb6010cd`
was measured clean on remote Bun 1.3.14: **Core 1737/77 files, OpenCode offline
1930/86 files, Pi 280/18 files, all zero failures**. This revision removes 70
more legacy-only tests from the first delivery's OpenCode count of 2000; the
initial pre-cleanup count was 2130. Core/Pi counts are unchanged. Floors and the
explicit main-relative lowering marker now use **1737/1930/280**. All six
TypeScript 7.0.2 configurations, Pi emitted-import guard, public-export/golden
checks, layout check and declaration closure pass. The unchanged seven-test
packed fresh-consumer file again passed locally on pinned Bun 1.3.14 as the
owner-authorized network exception (379 declaration/type files and 18 Node
runtime assertions). Production files and published golden bytes were not
changed by the fixture reduction.
