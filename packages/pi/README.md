# @cortexkit/pi-anthropic-auth

Pi package for CortexKit Anthropic OAuth support. It replaces the implementation of Pi's built-in Anthropic provider, keeping the `anthropic` provider ID and model IDs, and is backed by the shared `@cortexkit/anthropic-auth-core` package.

The Pi provider catalog includes Claude Fable 5 (`claude-fable-5`) and 5.1 (`claude-fable-5-1`), limited-access Claude Mythos 5 (`claude-mythos-5`) and 5.1 (`claude-mythos-5-1`), Claude Opus 5 (`claude-opus-5`), Claude Opus 5.5 (`claude-opus-5-5`), Claude Haiku 5.5 (`claude-haiku-5-5`), Claude Opus 4.8, Claude Opus 4.5, Claude Sonnet 4.5, Claude Sonnet 5 (`claude-sonnet-5`), and Claude Sonnet 5.5 (`claude-sonnet-5-5`). Fable/Mythos reasoning uses Anthropic adaptive thinking with `thinking.display: "summarized"` and `output_config.effort`; the package does not send rejected manual `thinking.budget_tokens` for those models. Opus 5.5 requires adaptive thinking, while Sonnet 5.5 also supports a `between_tools` mode for applications that explicitly turn off up-front thinking. This Pi provider sends adaptive thinking with summarized display for both models. For Sonnet 5.5 it exposes `low` through `max` effort, but not `minimal` (unsupported by the model) or `off` (Pi's simple-provider options cannot request `between_tools`). OAuth Fable 5.1 sessions add effort changes as system messages instead of rewriting earlier history, preserving cached prompt content.

Replayed thinking signatures refer to the messages, instructions and tools that preceded the thinking block. If those earlier inputs change, `thinkingBinding.prefixMismatchBehavior` controls how OAuth Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 requests handle that mismatch: `account-default` sends no local override and uses Anthropic's account settings; `error` rejects the request; `drop_block` removes the affected thinking blocks. These controls require adaptive thinking.

Haiku 5.5 has a 1M context, 128K output and summarized adaptive thinking with `low` through `max` effort. Haiku 5.5 does not support `minimal` effort. The model accepts disabled thinking, but Pi's simple-provider options cannot request it, so Pi does not expose an `off` level. Standard input/output rates are $0.10/$0.50 per million tokens; all rates increase fivefold above 100K total input including cache. Pi's native pricing tiers apply the selected rates to the whole request, including both cache lifetimes.

This package is part of the CortexKit Anthropic Auth monorepo, which supports both OpenCode (`@cortexkit/opencode-anthropic-auth`) and Pi (`@cortexkit/pi-anthropic-auth`) through the same shared core logic.

> [!IMPORTANT]
> These instructions describe the upcoming native release, which is not yet published.

## Setup (recommended)

Setup is an *offline* step: every OpenCode, LiteCode, and Pi process must be closed while it runs. Offline does not mean without network; setup still uses the network, for example to install packages and to sign in to Claude. Quit those processes, then run the setup command from the OpenCode package:

```bash
bunx @cortexkit/opencode-anthropic-auth setup
```

What setup does: it installs this extension with `pi install` and migrates Pi to its local account pool, or, if you choose it, enrolls Pi in the Claustrum vault (Claustrum is a local credential-vault service; `ck` is its command-line tool). Useful flags: `--yes` (no prompts), `--dry-run`, `--login` (sign in to Claude during setup), `--claustrum` / `--no-claustrum`, and `--remove-pi-auth` (consent, with `--yes`, to moving Pi's stored Anthropic login). `--login` and `--claustrum` cannot be combined.

---

## Install

Install with Pi's package manager:

```bash
pi install npm:@cortexkit/pi-anthropic-auth
```

To pin a release, replace `VERSION` with its version number and keep the quotes: `pi install "npm:@cortexkit/pi-anthropic-auth@VERSION"`.

To try it for one run without changing Pi settings:

```bash
pi -e npm:@cortexkit/pi-anthropic-auth
```

The extension keeps Pi's `anthropic` provider ID and the model IDs listed above. It authenticates from the local account pool or the Claustrum vault, not from Pi's `/login anthropic` credential. Run setup before starting Pi.

## Accounts and custody

Pi takes Claude credentials from one source, selected by Pi's own Claustrum enrollment record (`~/.local/state/cortexkit/anthropic-auth/pi-enrollment.json`, or `PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`):

- **Local custody** (default): the local account pool at `~/.pi/agent/anthropic-auth-pool.json`, with private credential state in `anthropic-auth-pool-state.json`. The pool holds Pi's Claude OAuth accounts (one main account, tried first by default, plus fallbacks) and API-key fallback routes. Its files are created next to the old sidecar path, so `PI_ANTHROPIC_AUTH_FILE` moves them too. Every Pi process shares this pool; OpenCode keeps a separate one.
- **Vault custody**: the Claustrum vault, through the `anthropic-auth-pi` enrollment and read access to the `anthropic-native` credential category. Setup grants this with `ck auth grant --principal enrolled:anthropic-auth-pi --selector-kind category --selector anthropic-native --operation read`.

If the enrollment record cannot be read, Pi refuses the requests this extension would serve until the record is repaired or Pi is disconnected. An approved enrollment keeps Pi on the vault even if its token file is missing, so Pi refuses rather than falling back to local accounts. See [the custody contract](https://github.com/cortexkit/anthropic-auth/blob/main/docs/custody-state-machine.md) for details.

### Local custody

Setup imports your fallback Claude OAuth accounts, paid API-key fallback routes, and settings from the old sidecar file (`~/.pi/agent/anthropic-auth.json`, or `PI_ANTHROPIC_AUTH_FILE`) into the pool; the old file is not read afterwards. Pi normally uses its stored login instead of the extension's credentials, so with your consent setup also moves Pi's stored Anthropic OAuth login into the pool as the main account. Until then, Pi refuses to serve with `Pi still has a host Anthropic OAuth credential. Run offline setup to migrate it and approve its removal before using the native pool.`

Before importing a stored main OAuth login, migration checks the Claude account UUID in the legacy main profile. That profile's recorded token fingerprint (a hash) must match the hash of the host login's current access token; migration does not query Anthropic for identity. If it cannot, it changes nothing and asks you to run `bunx @cortexkit/opencode-anthropic-auth setup --login --no-claustrum`. After setup completes, you can add or replace logins from Pi: open `/claude` and use **Start OAuth sign-in** and **Finish OAuth sign-in**. The first account becomes the main account; later sign-ins add fallback accounts.

### Vault custody

Run `bunx @cortexkit/opencode-anthropic-auth setup --claustrum` with the Claustrum daemon running and `ck` installed. Setup writes Pi's enrollment and, with your consent, Pi's auth file. It does not read, import, or change the local pool, its metadata, or routing assignments, and it never copies local OAuth accounts into the vault. If Pi has a stored Anthropic login (OAuth or API key), setup asks for consent, moves it into a private, owner-only stash (`pi-auth-slot/anthropic.json` in the directory of Pi's enrollment record), and leaves an inert placeholder API key in Pi's auth file. The placeholder is a fixed, non-secret value that no provider accepts.

While enrolled, Pi serves only vault accounts; vault accounts added with `ck auth login --provider anthropic` are discovered without a restart. Local accounts are not used, refreshed, quota-polled, kept warm by cache keepalive, or shown, and they return unchanged after disconnect. If the vault has no usable Claude account, requests refuse: add accounts with `ck auth login --provider anthropic`, or disconnect.

**Disconnect from the vault** in `/claude` asks for confirmation, restores the stashed login byte-for-byte, then ends Pi's enrollment. If Pi's auth file already holds a different login, disconnect stops and keeps both logins and the enrollment so you can resolve them with setup. **Disconnect from the vault** is also offered when the enrollment record cannot be read. If the local pool has never been migrated, stop the hosts and run `setup --no-claustrum` before serving local accounts; disconnect does not perform migration.

## Settings

The pool stores the same settings as the OpenCode package: `routing`, `claudeCache`, `cacheKeep`, `prime`, `claudeFast`, `thinkingBinding`, `dump`, `relay`, and the fallback accounts. While Pi is enrolled in the vault, settings are kept separately in `anthropic-auth-vault-settings.json`. `thinkingBinding.prefixMismatchBehavior` accepts `account-default` (default), `error`, or `drop_block` when a Fable 5.1 OAuth request reuses reasoning with an Anthropic signature from an earlier reply after the preceding messages, instructions, or tools change. Sticky session assignments are stored in `anthropic-auth-pool-routing-state.json` (`anthropic-auth-vault-routing-state.json` while enrolled) with SHA-256-hashed session IDs.

## The /claude menu

Pi registers one command, `/claude`. It opens a menu; each action collects its own parameters, and typed arguments are rejected with a pointer to the menu. Without a UI, `/claude` prints the status sections only.

| Group | Status | Actions |
| --- | --- | --- |
| Accounts | Account status and usage | Enable account, Disable account, Remove account, Move account up, Move account down, Reset account backoff, Reset host enrollment, Add API-key fallback, Start OAuth sign-in, Finish OAuth sign-in, Custody setup guidance, Disconnect from the vault |
| Quota | Quota summary | — |
| Routing | Routing status | Routing mode (`main-first`, `fallback-first`, `sticky-balanced`), Reset routing session |
| Cache | Cache status, Cache keep status | Enable cache, Disable cache, Cache mode (`explicit`, `automatic`, `hybrid`), Keep cache warm always, Disable cache keep, Cache keep window, Cache keep for subagents (`on`/`off`) |
| Diagnostics | Dump status, Logging status | Enable request dumps, Disable request dumps, Logging level (`error`, `warn`, `info`, `debug`, `trace`) |
| Extras | Fast mode status, Prime quota window status | Enable fast mode, Disable fast mode |

In local custody, every Accounts action except **Disconnect from the vault** is offered. While Pi is enrolled, or when its enrollment cannot be read, the Accounts group shows only enable, disable, **Reset account backoff**, and **Disconnect from the vault**. **Remove account**, **Reset host enrollment**, and **Disconnect from the vault** ask for confirmation. Killswitch, quota refresh, Prime on/off, and lane start are OpenCode-only.

**Reset account backoff** clears the main OAuth refresh backoff and its matching quota backoff. Persisted refresh backoffs are bound to the refresh token that produced them, so replacing a rejected credential immediately clears the backoff left by the old refresh token. **Quota summary** reports quota for the accounts of the active custody source. **Routing mode** → `fallback-first` prefers usable OAuth fallback accounts before the main account; `main-first` restores the default. `sticky-balanced` assigns each Pi session to an OAuth account according to current 5-hour, 7-day, and model-specific quota headroom, then keeps the session on that account (session affinity), persisting the assignment across transient failures and process restarts. Changing the session model discards the old assignment before quota-based reselection. **Reset routing session** clears the current Pi session's assignment. Direct Opus sessions prefer usable accounts whose Fable quota (the separate weekly limit for Claude Fable models) is exhausted, saving the other accounts for Fable sessions. API-key routes are sent directly to their configured Anthropic-compatible base URL, such as Kie's `https://api.kie.ai/claude`, but Pi only uses them after the main OAuth model response reports HTTP 429 or a streaming rate-limit error and a live quota check confirms 0% remaining. **Keep cache warm always** keeps active hybrid caches warm while Pi remains open; **Cache keep window** limits prewarms to a local time window. Both send `max_tokens: 0` pre-warm requests about five minutes before the 1-hour TTL expires. **Cache keep status** lists live tracked sessions across Pi processes through a temporary lease registry that stores only session IDs and cache timing. **Enable fast mode** adds Anthropic `speed: "fast"` plus the `fast-mode-2026-02-01` beta header for supported Opus models (`claude-opus-4-8`, `claude-opus-5`, and `claude-opus-5-5`).

### Claude quota window priming

Priming is off by default. When enabled from OpenCode's `/claude` menu with **Enable Prime**, it watches each OAuth account's 5-hour quota reset and sends one minimal `claude-haiku-4-5` request about one minute after a confirmed reset. This starts the next window without waiting for a normal prompt. Usage is measured from response accounting.

For an idle account with no cached reset time, one minimal request starts a usage window; the follow-up quota check learns its reset time. When several processes share an account store, each tries to create a claim file for that account and reset; creating the file is atomic, so exactly one process succeeds and sends the request.

Claim files live in a temporary directory, separated by account store and credential lineage. Cleanup removes files older than six hours. Ordinary token refresh keeps the lineage; a new sign-in starts a new one. Private runtime state stores cumulative priming usage counters, not a history of primed windows. Legacy claim files are not migrated. Without the old claim, the new scheduler can treat an already primed window as unclaimed and send one extra request.

Pi's menu shows **Prime quota window status** only; turn priming on or off with **Enable Prime** or **Disable Prime** in OpenCode's `/claude` menu.

## Anthropic-compatible proxy overrides

API-key fallback routes honor `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_MODEL`, and `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL`. These variables never alter OAuth requests. Custom headers may add proxy metadata but cannot replace route authentication, Anthropic protocol headers, body framing, or internal correlation headers; a configuration containing an invalid or protected header is ignored as a whole. Versioned provider base paths are preserved without duplicating `/v1`.

## Relay

The Pi package can use a user-owned Cloudflare relay over HTTP or WebSocket transport. When setup migrates Pi, it imports an existing `relay` block from Pi's old sidecar file (`~/.pi/agent/anthropic-auth.json`, or `PI_ANTHROPIC_AUTH_FILE`). The relay setup helper in the OpenCode package CLI provisions a Worker and saves its settings in OpenCode's local account pool; it does not configure Pi:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bunx @cortexkit/opencode-anthropic-auth relay setup
```

The `/claude` menu has no relay actions.

## License

MIT
