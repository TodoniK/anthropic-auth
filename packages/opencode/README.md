# CortexKit Anthropic Auth for OpenCode and Pi

Claude Pro/Max OAuth support for both [OpenCode](https://opencode.ai) and [Pi](https://pi.dev), maintained by CortexKit.

This repo is a Bun workspace monorepo with two user-facing integrations and one shared core package. The OpenCode package is a CortexKit-maintained fork of the original `@ex-machina/opencode-anthropic-auth` plugin. The Pi package is a native Pi extension that replaces the implementation of Pi's built-in Anthropic provider while keeping its `anthropic` provider ID and model IDs. Both integrations share the same Anthropic OAuth, account-pool, quota, prompt-cache, relay, dump, and request-signing logic through `@cortexkit/anthropic-auth-core`.

> [!IMPORTANT]
> These instructions describe the upcoming native release, which is not yet published.

## Packages

| Package | Agent | Purpose |
| --- | --- | --- |
| `@cortexkit/opencode-anthropic-auth` | OpenCode | OpenCode plugin and CLI for Claude OAuth, request rewriting, fallback accounts, quotas, cache controls, dumps, and relay setup. |
| `@cortexkit/pi-anthropic-auth` | Pi | Pi extension that replaces the implementation of Pi's built-in Anthropic provider, keeping the `anthropic` provider ID and model IDs. |
| `@cortexkit/anthropic-auth-core` | Shared | Reusable OAuth, account, quota, cache, relay, dump, SSE, and request-signing logic used by both integrations. |

## Support matrix

| Capability | OpenCode | Pi |
| --- | --- | --- |
| Claude Pro/Max OAuth (local) | Local account pool, filled by `setup` migration, `setup --login`, or `/connect anthropic` | Local account pool, filled by `setup` migration, `setup --login`, or the `/claude` menu |
| Claude accounts from the Claustrum vault | Optional, enrolled separately through `setup` | Optional, enrolled separately through `setup` |
| Provider integration point | OpenCode plugin fetch/request transform (OpenCode 1 and OpenCode 2) | Pi `registerProvider("anthropic")`, replacing the built-in implementation |
| Local account pool | `~/.config/opencode/anthropic-auth-pool.json` | `~/.pi/agent/anthropic-auth-pool.json` |
| Old sidecar (migration source only) | `~/.config/opencode/anthropic-auth.json` | `~/.pi/agent/anthropic-auth.json` |
| Slash command | `/claude` menu | `/claude` menu |
| Menu actions not available in Pi | — | Refresh quota, killswitch, Prime on/off, lane start |
| Quota sidebar widget | OpenCode TUI plugin via `tui.json` | Not available |
| Fallback accounts, quota routing, relay, dumps, fast mode | Supported | Supported through the same shared core |

## What CortexKit adds over the original plugin

- **Fallback Claude accounts**: keep a main Claude account and route to ordered fallback OAuth accounts or API-key routes on auth/quota/rate-limit failures.
- **Routing modes**: choose **Routing mode** → `sticky-balanced` in the `/claude` menu to spread new sessions across OAuth accounts by current quota headroom while keeping each session on one account, or choose `main-first` / `fallback-first` ordering.
- **Quota-aware routing**: skip main or fallback accounts when their 5-hour or 7-day Claude quota falls below your configured minimum.
- **Persistent Claude cache controls**: manage Anthropic 1-hour prompt caching from the `/claude` menu's Cache group with explicit, automatic, or hybrid modes.
- **Cache keepalive**: use **Keep cache warm always** or **Cache keep window** to pre-warm hybrid cache anchors for active sessions before the 1-hour TTL expires.
- **Quota window priming**: opt in with **Enable Prime** to start each 5-hour quota window about one minute after it resets instead of waiting for the next normal prompt.
- **Lane start (OpenCode only)**: use **Fire lane start** to send one synthetic, one-token turn through the current session's normal model, agent, variant, quota, routing, cache, and request pipeline.
- **Fast mode toggle**: use **Enable fast mode** / **Disable fast mode** to request Anthropic fast mode for supported Opus models (`claude-opus-4-8`, `claude-opus-5`, and `claude-opus-5-5`).
- **Adaptive reasoning visibility**: request summarized adaptive thinking for Claude Fable 5/5.1, Mythos 5/5.1, Opus 5/5.5, and Sonnet 5.5. OpenCode exposes native `low`, `medium`, `high`, `xhigh`, and `max` effort variants for Fable 5.1, Opus 5/5.5, and Sonnet 5.5. On Opus 5.5, thinking is always on (adaptive summarized) per the model specification. OAuth Fable 5.1 sessions can change effort between turns without rewriting the cached prefix.
- **Claude Haiku 5.5**: `claude-haiku-5-5` supports a 1M context, 128K output and native `low` through `max` adaptive effort. Forced tool choice remains supported. Configured `error` or `drop_block` behavior handles replayed thinking after earlier conversation content changes. Explicit disabled thinking is preserved, with incompatible `xhigh`/`max` effort capped to `high`; manual budgets and sampling parameters are removed. Standard input/output rates are $0.10/$0.50 per million tokens, with fivefold request-wide rates above 100K total input including cache. OAuth model costs are zeroed by default. Opt-in quota-window priming uses Haiku 4.5 to start a new quota window.
- **Fable/Opus 5 and 5.5 safety fallback (OpenCode)**: eligible OAuth requests try Anthropic's server-side safety fallback first. The plugin preserves Anthropic's fallback conversation boundary across OpenCode history and automatically starts its deterministic 10-response Opus 4.8 recovery if the response still ends in refusal. The TUI sidebar and OpenCode Desktop report the active target model and restoration. Set `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy` to bypass the server policy and use client-side recovery exclusively.
- **Live quota visibility**: the `/claude` menu's Quota group shows main and fallback quota state, reset times, and refresh errors.
- **Host-local quota feed (OpenCode)**: optionally publish sanitized response-header quota observations so another local CortexKit process can reuse fresh account state without polling Anthropic's rate-limited usage endpoint.
- **Quota sidebar widget**: register the OpenCode TUI plugin in `tui.json` to render a live sidebar with per-account quota, routing, cache, and health state.
- **Killswitch (OpenCode menu)**: per-account hard-block thresholds that stop requests before hitting Anthropic's rate limits, with synthetic 429 retry-after when all accounts are exhausted.
- **User-owned Cloudflare relay**: optionally provision your own Worker relay to reduce repeated client upload bytes for large OpenCode or Pi requests.
- **Optional Claustrum vault custody**: enroll OpenCode or Pi with setup so it serves Claude accounts from the vault instead of its local account pool.
- **Claude-compatible request hardening**: Claude Code 2.1.280 identity and final-body billing signing, user-turn prompt and request lineage across OpenCode tool loops, live-session-stable billing suffixes, Fable 5.1 thinking-prefix recovery, safer token refresh persistence, replay-safe fallback retries, and subagent cache isolation.

## What these integrations do

- Let OpenCode and Pi use Claude Pro/Max OAuth credentials instead of an Anthropic API key.
- In OpenCode, intercept the final Anthropic request and rewrite it into the Claude-compatible shape expected by Anthropic OAuth access.
- In Pi, replace the implementation of Pi's built-in Anthropic provider, keeping its provider and model IDs, with one that uses the same Claude-compatible request path.
- Add Claude billing headers with stable `cc_version`, OpenCode user-turn `cc_prompt_id`/`cc_prev_req` lineage, and body-derived `cch` signing.
- Keep Claude OAuth accounts and API-key routes in a per-host local account pool, or serve accounts from an enrolled Claustrum vault.
- Keep local OAuth tokens fresh in the background.
- Apply quota thresholds before routing to main or fallback accounts.
- Add one `/claude` menu for accounts, quota, routing, limits, cache, diagnostics, fast mode, Prime, and lane start.
- Optionally relay large requests through a Cloudflare Worker owned by the user.

## Quick setup (recommended)

In this guide, a *host* is OpenCode or Pi. Setup is an *offline* step: every OpenCode, LiteCode, and Pi process must be closed while it runs. Offline does not mean without network; setup still uses the network, for example to install packages and to sign in to Claude. Quit those processes, then run:

```bash
bunx @cortexkit/opencode-anthropic-auth setup
```

What setup does:

- detects OpenCode, Pi, `ck`, and a running Claustrum daemon (Claustrum is a local credential-vault service; `ck` is its command-line tool), and lets you select which hosts to configure;
- adds `@cortexkit/opencode-anthropic-auth` to `opencode.jsonc` (or `opencode.json`) and `tui.jsonc` (or `tui.json`), and installs `@cortexkit/pi-anthropic-auth` with `pi install`;
- migrates each selected host to its local account pool, unless you choose Claustrum vault custody;
- enrolls each selected host in the vault when you choose vault custody (it asks, and defaults to no).

Setup refuses to change anything while an OpenCode, LiteCode, or Pi process is running.

| Flag | Effect |
| --- | --- |
| `--yes`, `-y` | Do not prompt. Selects every detected host and keeps local custody unless `--claustrum` is also given. |
| `--dry-run` | Print the planned actions and change nothing. |
| `--login` | Sign in to Claude during setup and store that account as the main account in the local pool. |
| `--claustrum` | Choose vault custody. Takes effect only when the Claustrum daemon is running and `ck` is installed; otherwise setup keeps local custody. Cannot be combined with `--login`. |
| `--no-claustrum` | Keep local custody without asking. |
| `--remove-pi-auth` | With `--yes`, consent to moving a stored Pi Anthropic login (see [Pi stored logins](#pi-stored-logins)). Plain `--yes` is not consent. |

---

## Install

### OpenCode

Add the OpenCode plugin to your OpenCode configuration:

```json
{
  "plugin": ["@cortexkit/opencode-anthropic-auth"]
}
```

Pinning is strongly recommended for any OpenCode plugin. Replace `VERSION` with the release you install:

```json
{
  "plugin": ["@cortexkit/opencode-anthropic-auth@VERSION"]
}
```

OpenCode 1 and OpenCode 2 load the same package. After changing plugin config, restart OpenCode.

> [!TIP]
> If OpenCode keeps using an old build, clear OpenCode's plugin cache with `rm -rf ~/.cache/opencode` and restart.

### Pi

Install the Pi package with Pi's package manager:

```bash
pi install npm:@cortexkit/pi-anthropic-auth
```

To pin a release, replace `VERSION` with its version number and keep the quotes: `pi install "npm:@cortexkit/pi-anthropic-auth@VERSION"`.

To try it for one run without adding it to Pi settings:

```bash
pi -e npm:@cortexkit/pi-anthropic-auth
```

The Pi package replaces the implementation of Pi's built-in Anthropic provider; the `anthropic` provider ID and model IDs stay the same. It authenticates from the local account pool or the vault, not from Pi's `/login anthropic` credential. Run [setup](#quick-setup-recommended) before starting Pi.

Pi's files live in `~/.pi/agent/` by default. `PI_CODING_AGENT_DIR` or `PI_AGENT_DIR` changes that directory, and `PI_ANTHROPIC_AUTH_FILE` changes the old sidecar path from which the pool's location is derived.

## Accounts and credential custody

OpenCode and Pi each take Claude credentials from exactly one source:

- **Local custody** (default): the host's local account pool.
- **Vault custody**: the Claustrum vault, after the host is enrolled through setup.

The host's Claustrum enrollment record decides which credential source requests use; settings files do not. An approved enrollment keeps the host on the vault even if its token file is missing, so the host refuses rather than falling back to local accounts. If the enrollment record cannot be read, requests the plugin would serve refuse until it is repaired or disconnected; ordinary API-key authentication is unaffected. See [the custody contract](https://github.com/cortexkit/anthropic-auth/blob/main/docs/custody-state-machine.md) for the full contract.

### Local account pool

The pool holds the host's Claude OAuth accounts and Anthropic-compatible API-key fallback routes, plus plugin settings. One OAuth account is the main account, tried first by default; the others are fallbacks, tried in order when the main account is unusable. The pool's location follows the host's old sidecar path: its files are created in the same directory, so `OPENCODE_ANTHROPIC_AUTH_FILE` and `PI_ANTHROPIC_AUTH_FILE` move the pool too.

| Host | Pool | Old sidecar (migration source) |
| --- | --- | --- |
| OpenCode | `~/.config/opencode/anthropic-auth-pool.json` | `~/.config/opencode/anthropic-auth.json` |
| Pi | `~/.pi/agent/anthropic-auth-pool.json` | `~/.pi/agent/anthropic-auth.json` |

Private credential state is kept beside the pool in `anthropic-auth-pool-state.json`. Every process of a host shares that host's pool. OpenCode and Pi keep separate pools.

Setup migrates each host once, while OpenCode, LiteCode, and Pi are closed:

- Fallback accounts, API-key routes, and settings from the old sidecar files are imported into the pool. The old sidecar files are not read afterwards.
- OpenCode's stored Claude OAuth login becomes the main account in OpenCode's pool. OpenCode keeps only an inert placeholder: a fixed, non-secret marker that is not a usable credential and only tells OpenCode to route Claude requests through the plugin. A stored OpenCode API key is left unchanged.
- Pi's stored Anthropic OAuth login is moved into the pool only with your consent.

Requests refuse until migration has completed; they never fall back to credentials still stored in OpenCode's or Pi's own auth file. Before importing a stored main OAuth login, migration checks the Claude account UUID in the legacy main profile. That profile's recorded access-token fingerprint must match the host login; migration does not query Anthropic for identity. If it cannot, it changes nothing and tells you to run:

```bash
bunx @cortexkit/opencode-anthropic-auth setup --login --no-claustrum
```

`--login` opens a Claude sign-in during setup and stores the account as the main account.

### Signing in

In local custody, after running setup (see [Local account pool](#local-account-pool)), add the main account in any of these ways:

- **OpenCode 1**: run `/connect anthropic` and choose **Claude Pro/Max**. The account is saved in the local pool; OpenCode stores only the inert placeholder.
- **OpenCode 2**: connect Anthropic and choose **Claude Pro / Max (native account pool)**.
- **Pi**: after setup completes, open `/claude`, then use **Start OAuth sign-in** and **Finish OAuth sign-in**. The first account becomes the main account; later accounts are fallbacks, tried when the main account cannot serve.
- **Any host**: `setup --login`, while the host is stopped.

OpenCode's stock API-key options (**Create an API Key** and **Manually enter API Key** in OpenCode 1) remain ordinary OpenCode API-key authentication. The plugin passes those requests through unchanged.

Local sign-in refuses while the host is enrolled in the vault (see [Claustrum vault custody](#claustrum-vault-custody)), with `Disconnect from the vault first.`

### Claustrum vault custody

Vault custody is optional and chosen per host. Quit every OpenCode, LiteCode, and Pi process, make sure the Claustrum daemon is running and `ck` is installed, then run:

```bash
bunx @cortexkit/opencode-anthropic-auth setup --claustrum
```

For each selected host, setup proposes the `anthropic-auth-opencode` or `anthropic-auth-pi` enrollment, approves it with `ck auth enroll approve`, and grants that enrollment read access to the `anthropic-native` credential category (`ck auth grant --principal enrolled:anthropic-auth-<host> --selector-kind category --selector anthropic-native --operation read`). It then refreshes the vault inventory and requires its default Anthropic credential (`oauth:anthropic`) to have a vault-reported account identity; otherwise it stops with `The vault has no verified default Claude account. Sign in through the vault and rerun setup.`

Vault setup writes the selected host's enrollment and, for Pi with your consent, Pi's auth file (see [Pi stored logins](#pi-stored-logins)). It does not read, import, change, or delete the local pool, migration journal, local runtime metadata, or routing assignments, it never imports local OAuth accounts into the vault, and it does not write OpenCode's auth file. If the vault reports that an earlier enrollment request was replaced by a newer one, already used, or no longer exists, setup clears that request and stops; run setup again.

After setup, select the vault in the host:

- **OpenCode 1**: run `/connect anthropic` and choose **Claude via credential vault**. This option appears only while OpenCode holds a vault enrollment, and it checks OpenCode's Anthropic login slot without changing it. If OpenCode already holds an Anthropic login, or the slot cannot be read, it refuses: remove that login with OpenCode's own tools, then choose the vault login, or disconnect from the vault. An OpenCode OAuth login other than the vault placeholder is never used while enrolled; requests refuse with `This host uses the credential vault, but OpenCode holds a separate Anthropic login. Remove it and choose the vault login, or disconnect from the vault.`
- **OpenCode 2**: connect Anthropic and choose **Claude vault accounts**. It refuses unless OpenCode is enrolled.
- **Pi**: no extra step; see [Pi stored logins](#pi-stored-logins).

API keys stored in OpenCode are never changed and keep working as stock OpenCode authentication in every custody state, including an unreadable enrollment. OpenCode 2 serves a request only when it carries the plugin's placeholder; API keys from OpenCode's login, configuration, or environment, and any other connection, pass through unchanged.

While a host is enrolled:

- Claude accounts come only from the vault's scoped inventory. The vault's default account is the main account. Accounts added with `ck auth login --provider anthropic` are discovered without a restart and receive an initial quota check.
- Every model request, quota or profile query, quota-window priming request, and cache keepalive request obtains fresh vault authorization. A vault refusal never falls back to a local credential.
- Local pool accounts, including API-key routes, are not used, refreshed, quota-polled, kept warm, or shown. They stay unchanged and return after disconnect.
- If the vault's default account changes to a different Claude account, sessions pinned to the old default are assigned afresh; other session pins are kept.
- If the vault has no usable Claude account, requests refuse. Add accounts with `ck auth login --provider anthropic`, or disconnect from the vault.
- The `/claude` menu still enables and disables vault accounts and resets recorded retry waits, but hides local sign-in, API-key additions, account removal and reordering, and enrollment reset.

### Pi stored logins

Pi prefers its stored login over the extension's credentials. Setup asks before moving or stashing that login; with `--yes`, pass `--remove-pi-auth` to consent.

- **Local custody**: setup moves Pi's stored Anthropic OAuth login into the local pool and removes Pi's copy. Until that happens, Pi refuses to serve with `Pi still has a host Anthropic OAuth credential. Run offline setup to migrate it and approve its removal before using the native pool.`
- **Vault custody**: setup moves Pi's stored Anthropic login (OAuth or API key) into a private stash and leaves a fixed, non-secret API-key marker in Pi's auth file so Pi does not refresh the stashed OAuth login. Disconnecting restores the original login byte-for-byte before the enrollment is removed.

### Disconnecting from the vault

Open `/claude` and choose **Disconnect from the vault** in the Accounts group. The action is offered while the host is enrolled, and also when the enrollment record cannot be read, so a damaged record can always be cleared. It asks for confirmation:

```text
Disconnect this host from the vault and return to local accounts? The vault keeps this host's enrollment approved until an operator revokes it there.
```

Disconnect never reads or changes OpenCode's stored sign-ins. For Pi, it restores the stashed login first. If Pi's auth file already holds a different login, disconnect stops, keeps both logins and the enrollment, and asks you to resolve them with setup. After a successful disconnect, the host returns to its local pool. If that pool has never been migrated, stop the hosts and run `setup --no-claustrum`; disconnect does not perform migration.

Only the setup command creates or polls enrollment requests. In local custody, **Reset host enrollment** clears a denied or blocked enrollment request without proposing a new one; run setup afterwards. It never resets a pending request or an approved enrollment.

## Settings

Plugin settings live in the host's local account pool (and, while the host is enrolled in the vault, in a separate `anthropic-auth-vault-settings.json`). Change the settings that have a `/claude` menu action from the menu; see [The /claude menu](#the-claude-menu).

During migration, setup imports these settings from the old sidecar file (`~/.config/opencode/anthropic-auth.json` or `~/.pi/agent/anthropic-auth.json`, or the paths set by `OPENCODE_ANTHROPIC_AUTH_FILE` and `PI_ANTHROPIC_AUTH_FILE`). The old file is not read after migration. The imported shape is:

```json
{
  "version": 1,
  "main": { "type": "opencode", "provider": "anthropic" },
  "fallbackOn": [401, 403, 429],
  "routing": {
    "mode": "main-first"
  },
  "refresh": {
    "enabled": true,
    "intervalMinutes": 10,
    "refreshBeforeExpiryMinutes": 240
  },
  "quota": {
    "enabled": true,
    "checkIntervalMinutes": 5,
    "minimumRemaining": {
      "five_hour": 10,
      "seven_day": 20
    },
    "failClosedOnUnknownQuota": true,
    "showToasts": false
  },
  "quotaHeaderFeed": {
    "enabled": false
  },
  "killswitch": {
    "enabled": false,
    "main": { "five_hour": 5, "seven_day": 10, "scoped": 0 },
    "accounts": {}
  },
  "claudeCache": {
    "enabled": false,
    "mode": "explicit"
  },
  "cacheKeep": {
    "enabled": false,
    "always": false,
    "startHour": 9,
    "endHour": 23
  },
  "dump": {
    "enabled": false
  },
  "claudeFast": {
    "enabled": false
  },
  "thinkingBinding": {
    "prefixMismatchBehavior": "account-default"
  },
  "costZeroing": {
    "enabled": true
  },
  "relay": {
    "enabled": false,
    "url": "https://opencode-anthropic-relay.example.workers.dev",
    "token": "relay-shared-secret",
    "transport": "http",
    "fallbackToDirect": true
  },
  "accounts": []
}
```

The `routing` block holds the routing mode, `claudeCache` the cache mode, `cacheKeep` the cache keepalive schedule, and `claudeFast` the fast-mode switch; the `/claude` menu changes all of them. Killswitch `scoped` thresholds apply to model-specific quota windows, such as a separate weekly limit for Claude Fable models (`claude-fable-*`). OpenCode zeroes Anthropic OAuth model costs by default because OAuth usage is quota-based; set `costZeroing.enabled` to `false` only if you want OpenCode to display the provider's model pricing instead. Set `quota.showToasts` to `true` to opt into OpenCode quota toast notifications after quota refreshes.

`thinkingBinding.prefixMismatchBehavior` controls replayed signed/redacted thinking on OAuth Fable 5.1 requests. `account-default` (the default) sends no explicit prefix-mismatch override. Use `error` to make prefix changes fail deterministically during compaction testing, or `drop_block` to ask Anthropic to discard mismatched thinking blocks. The beta header is added only when an explicit behavior is configured and replayable thinking is present.

`quotaHeaderFeed.enabled` is an OpenCode-only, restart-required opt-in. It publishes only allowlisted quota-window values, an opaque account reference, an observation timestamp, and the configured OAuth-account count; it never publishes tokens, raw headers, request bodies, model IDs, or refresh errors. Per-process lease files use owner-only permissions under `$TMPDIR/opencode-anthropic-auth/quota-header-feed`, expire after three minutes, and can be redirected with `OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR`.

Private runtime data (OAuth tokens, API-route keys, token refresh backoff, quota snapshots, and quota API backoff) is kept in `anthropic-auth-pool-state.json`, separate from settings. `sticky-balanced` session assignments use `anthropic-auth-pool-routing-state.json` in local custody and `anthropic-auth-vault-routing-state.json` in vault custody; session IDs are SHA-256 hashed in both.

## Fallback accounts

Fallback accounts are separate Claude OAuth accounts or Anthropic-compatible API-key routes in the local pool, or additional accounts in the vault while the host is enrolled. By default, the main account is tried first unless quota policy says it is currently unusable. Fallbacks are then tried in account order when the primary request returns a configured fallback status.

In the `/claude` menu, choose **Routing mode** → `fallback-first` to prefer usable fallback accounts before the main account, `main-first` to restore the default, or `sticky-balanced` to allocate each new session to an OAuth account according to its remaining quota above your configured minimums in the 5-hour, 7-day, and any model-specific window. The choice persists and takes effect on the next request without restarting. **Reset routing session** clears only the current session's assignment so its next request is allocated again.

`sticky-balanced` normalizes quota headroom by time until reset and accounts for prompt bytes assigned since the last quota refresh, so new sessions do not crowd the same account before fresh quota arrives. Assignments are persisted by hashed session ID in `anthropic-auth-pool-routing-state.json` (`anthropic-auth-vault-routing-state.json` while enrolled in the vault), shared safely across OpenCode plugin instances and restarts. Sessions whose 1-hour prompt cache is already kept warm by background requests keep their current route when the mode is first enabled, avoiding a cache-losing account switch. Changing the user-selected model discards the old assignment and its model-specific CacheKeep preference before quota-based reselection; transparent safety-recovery model changes retain the original account.

Session affinity, keeping a session on the same account, survives network/relay failures, 5xx responses, unconfirmed 429s, quota-probe failures, and relative quota changes. Confirmed 7-day or matching model-scoped exhaustion migrates a session. Confirmed 5-hour exhaustion migrates only when more than 15 minutes remain; otherwise the plugin retains the route and returns `Retry-After`. When a Claude Fable model returns a content-filter refusal and OpenCode temporarily switches the session to Opus 4.8 (see [Safety fallback](#safety-fallback)), the Fable request, the Opus 4.8 turns, and the cache prewarm sent before returning to Fable stay on the same assigned account. Direct Opus sessions first prefer an otherwise usable account whose Fable quota is exhausted.

Default fallback statuses:

```json
[401, 403, 429]
```

Add and inspect OpenCode fallback accounts with the CLI (local custody only, after running setup for OpenCode):

```bash
bunx @cortexkit/opencode-anthropic-auth login personal-alt
bunx @cortexkit/opencode-anthropic-auth api add kie-opus
bunx @cortexkit/opencode-anthropic-auth list
```

Prefer npm? Use `npx -y @cortexkit/opencode-anthropic-auth ...` with the same subcommands. `login` and `api add` save to OpenCode's local pool and never change OpenCode's auth file; both refuse with `Disconnect from the vault first.` while OpenCode is enrolled in the vault, because vault accounts then replace the local pool. `api add` reads `OPENCODE_ANTHROPIC_AUTH_API_BASE_URL`, `OPENCODE_ANTHROPIC_AUTH_API_KEY`, and `OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER` instead of prompting when they are set.

In both hosts, the `/claude` menu's Accounts group offers the same local changes: **Start OAuth sign-in** / **Finish OAuth sign-in**, **Add API-key fallback**, **Enable account**, **Disable account**, **Remove account**, **Move account up**, and **Move account down**. Account actions ask for the complete account ID shown in the account status.

API fallback routes use `Authorization: Bearer <key>` by default and rewrite requests to the configured Anthropic-compatible base URL. For Kie, use `https://api.kie.ai/claude` as the base URL; the plugin appends `/v1/messages` automatically. API-key routes are only eligible after direct evidence that the main OAuth quota is exhausted: a fresh quota reading for the current Claude account showing 0% remaining, or an actual main OAuth model response with HTTP 429 / streaming rate-limit error followed by a live quota check that confirms 0% remaining. Low-but-nonzero quota, stale cached quota, unconfirmed 429s, 401, or 403 do not trigger API-key routes. API-route keys are stored with the pool's private state, separate from public route settings. **Add API-key fallback** selects either `authorization-bearer` or `x-api-key` for the authentication header.

OpenCode cost accounting stays simple: when the native Anthropic auth entry is OAuth, OpenCode sees zero-cost Claude OAuth models by default. If a request falls through to an API-key route, token accounting is still recorded, but OpenCode's built-in dollar cost is not route-aware. To retain Anthropic model pricing for OAuth sessions during migration, set `costZeroing.enabled` to `false` in the old `anthropic-auth.json` before the first local setup. Setup imports that setting; the menu does not expose it.

The CLI manages only OpenCode's locally stored Claude accounts and API-key fallbacks. Add Pi fallback accounts from Pi's `/claude` menu.

Fallback retries are only attempted when the request body is safely replayable. If the original body is non-replayable or already consumed, the plugin returns the primary response unchanged.

### Token refresh

Local OAuth tokens refresh in the background so idle accounts do not expire before they are needed. Refresh token rotation is persisted immediately. The plugin also re-reads the latest stored account before refreshing, which avoids using stale refresh-token snapshots when multiple background paths run close together. Persisted refresh backoffs are bound to the refresh token that produced them, so replacing a rejected credential immediately clears the backoff left by the old refresh token. In vault custody, the vault alone refreshes credentials.

If Anthropic reports `invalid_grant`, that account must be signed in again. **Reset account backoff** in the `/claude` menu's Accounts group manually clears the main account's refresh backoff and its matching quota backoff.

## Quota-aware routing

When `quota.enabled` is true, the plugin checks Anthropic's OAuth usage endpoint and applies the configured remaining-quota thresholds to both main and fallback accounts.

Example:

```json
"minimumRemaining": {
  "five_hour": 10,
  "seven_day": 20
}
```

With this config, an account is skipped when it has less than 10% remaining in the 5-hour window or less than 20% remaining in the 7-day window. The aliases `5h` and `1w` are also accepted.

Main-account quota is cached. If the main account is known to be exhausted, the plugin skips it until the relevant reset time. If the cached main quota is stale but usable, the request proceeds and quota refresh happens in the background.

Open `/claude` to see current quota state in the Quota group (**Quota summary**). It covers the main account and every fallback from the local pool, or from the vault while enrolled. In OpenCode, **Refresh quota** requests fresh quota; Pi shows the summary without that action.

Reset times are rendered as relative durations, such as `resets in 10m` or `resets in 1h 15m`.

### Quota header feed

The optional quota header feed writes one lease file per process under `${TMPDIR:-/tmp}/opencode-anthropic-auth/quota-header-feed/`. Set `OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR` to override the directory. Each file contains only quota headers observed by the process that wrote it. Each file records `lease_horizon_ms` (default 180000, three minutes). Consumers must discard entries whose `observed_at_ms` is in the future or at least that old, then combine fresh entries from every file and deduplicate by account. "Newest file wins" drops accounts seen by other processes.

For each account, use the entry with the greatest `observed_at_ms` for quota values. Resolve `anthropic_account_uuid` from any entry in that account's group that carries it. During an upgrade, an older plugin process that is still running can write the newest entry without that field while an updated process writes entries that have it.

Each entry always includes `anthropic_account_uuid`; an absent key identifies an older producer. Its value is provider-derived or `null`, never a local substitute. A consumer that sees `null` must count a gap, not fall back to `account_ref`: that field is a row ID local to one account store, not a global account identifier, so it must never be used to match accounts across stores.

## Safety fallback

Eligible Fable 5/5.1 and Opus 5 OAuth requests try Anthropic's server-side safety fallback first. The plugin sends `fallbacks: "default"` with Anthropic's server-side fallback beta, preserves fallback conversation boundaries in OpenCode history, and reports model handoffs and restoration in the TUI sidebar or OpenCode Desktop. Follow-up requests may remain on Anthropic's selected fallback model for approximately one hour.

If an eligible OAuth response still ends in refusal, CortexKit automatically starts its deterministic 10-successful-response Opus 4.8 recovery, prewarms the selected source model without the server-fallback opt-in, and then restores that model. If the refused response already completed a tool call, the plugin preserves that call and continues with its existing tool result instead of replaying the tool.

Custom API-key routes do not receive the server-side fallback beta or request field.

To bypass Anthropic's server policy and use deterministic client recovery from the first refusal, start OpenCode with:

```bash
OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy opencode
```

Legacy mode routes a refused Fable 5/5.1 or Opus 5 session through Opus 4.8 for 10 successful responses, prewarms the selected source model's cache, and then restores that model without first opting into Anthropic's server policy. Unset the variable and restart OpenCode to return to the default server-first policy with the same client recovery as a backstop.

## Killswitch

The killswitch is a per-account hard-block that stops requests when remaining quota drops below configured thresholds, even if Anthropic's API would still accept them. Unlike `minimumRemaining` (which routes to fallback accounts), the killswitch removes accounts from the routing pool entirely.

Killswitch settings have this shape; setup imports an existing `killswitch` block from the old sidecar file (`anthropic-auth.json`):

```json
"killswitch": {
  "enabled": true,
  "main": {
    "five_hour": 5,
    "seven_day": 10,
    "scoped": 0
  },
  "accounts": {
    "work-alt": {
      "five_hour": 10,
      "seven_day": 20,
      "scoped": 0
    }
  }
}
```

Thresholds are remaining-percent values. With `five_hour: 5`, the account is killed when less than 5% of the 5-hour quota window remains. The optional `scoped` threshold applies to model-specific quota windows (for example a separate weekly limit for Claude Fable models, `claude-fable-*`) and blocks when the scoped remaining percent is at or below the threshold. Accounts without an entry in `accounts` fall back to the `main` thresholds. The aliases `5h` and `1w` are also accepted.

Missing quota readings:

- A positive 5-hour or 7-day floor requires a finite quota reading for that window. If the reading is missing or not a number, the account is blocked, whatever `quota.failClosedOnUnknownQuota` says.
- With no positive floor, missing readings follow `quota.failClosedOnUnknownQuota`.
- An explicit positive `scoped` floor requires scoped-window information for the account. If that information is missing, the account is blocked. A reported empty list of scoped windows shows the model has no separate window, so the scoped floor does not apply.

Behavior:

- When an account is killed, it is skipped during routing. Surviving accounts are tried instead.
- When all accounts (main and all enabled fallbacks) are killed, the plugin returns a synthetic 429 response with a `retry-after` header set to the earliest quota reset time across all accounts.
- On the first request after restart, the plugin eagerly fetches main quota so the killswitch evaluates immediately.
- **Killswitch status** in the `/claude` menu's Limits group shows killswitch status and per-account killed/active state.

Manage the killswitch from the `/claude` menu's Limits group: **Enable killswitch**, **Disable killswitch**, and **Set killswitch thresholds**. Enter thresholds as a JSON array of objects with `account` (the account ID shown in account status, or `main`), `fh` (5-hour), `sd` (7-day), and optional `scoped` values, for example:

```json
[{"account":"main","fh":3,"sd":8,"scoped":0},{"account":"<account-id>","fh":5,"sd":10,"scoped":0}]
```

Killswitch changes are persisted with the host's other plugin settings. Pi does not offer killswitch enable, disable, or threshold editing.

## The /claude menu

Both hosts register one slash command, `/claude`. It opens a menu grouped by area; each action collects its own parameters, so typed arguments are not used (Pi rejects them and points you to the menu). Earlier separate `/claude-*` commands are no longer registered.

| Group | Status shown | Actions | Pi |
| --- | --- | --- | --- |
| Accounts | Account status and usage | Enable account, Disable account, Remove account, Move account up, Move account down, Reset account backoff, Reset host enrollment, Add API-key fallback, Start OAuth sign-in, Finish OAuth sign-in, Custody setup guidance, Disconnect from the vault | All |
| Quota | Quota summary | Refresh quota | Summary only |
| Routing | Routing status | Routing mode (`main-first`, `fallback-first`, `sticky-balanced`), Reset routing session | All |
| Limits | Killswitch status | Enable killswitch, Disable killswitch, Set killswitch thresholds | Not available |
| Cache | Cache status, Cache keep status | Enable cache, Disable cache, Cache mode (`explicit`, `automatic`, `hybrid`), Keep cache warm always, Disable cache keep, Cache keep window, Cache keep for subagents (`on`/`off`) | All |
| Diagnostics | Dump status, Logging status | Enable request dumps, Disable request dumps, Logging level (`error`, `warn`, `info`, `debug`, `trace`) | All |
| Extras | Fast mode status, Prime quota window status | Enable fast mode, Disable fast mode, Enable Prime, Disable Prime, Fire lane start | Fast mode actions; Prime status without on/off |

The Accounts actions shown depend on custody:

- **Local custody**: every Accounts action except **Disconnect from the vault**.
- **Vault custody**: the Accounts group shows `Accounts are managed in the vault. Disconnect from the vault to use local accounts.` Enable, disable, **Reset account backoff**, and **Disconnect from the vault** remain. Local sign-in, API-key additions, removal, reordering, **Reset host enrollment**, and **Custody setup guidance** are hidden and refused.
- **Unreadable enrollment**: the Accounts group shows the same actions as vault custody, so **Disconnect from the vault** stays available.

**Custody setup guidance** changes nothing; it explains that custody changes require stopping every OpenCode, LiteCode, and Pi process and running [setup](#quick-setup-recommended). **Remove account**, **Reset host enrollment**, and **Disconnect from the vault** ask for confirmation. Sign-in, API-key, guidance, and disconnect actions need an interactive session.

In the OpenCode TUI, `/claude` opens an interactive dialog. Outside the TUI (OpenCode Desktop or headless), it posts a text summary of the menu. In Pi without a UI, it prints the status sections only.

Command dialogs use a loopback-only RPC server (bound to `127.0.0.1`, bearer-authenticated) so the OpenCode server process can signal the separate TUI process. Its runtime directory defaults to a per-project path under the OpenCode state directory; override it with `OPENCODE_ANTHROPIC_AUTH_RPC_DIR`.

## Claude prompt cache control

Both OpenCode and Pi control Anthropic's 1-hour ephemeral prompt-cache lifetime from the `/claude` menu's Cache group: **Enable cache**, **Disable cache**, and **Cache mode** (`explicit`, `automatic`, or `hybrid`). **Cache status** shows the current setting.

Modes:

- `explicit` keeps OpenCode's explicit cache breakpoints and adds `ttl: "1h"` to them.
- `automatic` removes block-level cache controls and sends a top-level `cache_control` object.
- `hybrid` (recommended) removes top-level automatic caching and uses explicit anchors for Magic Context's leading history plus a moving latest-user boundary. When the first message has multiple cacheable content blocks, hybrid anchors both the first and last block so a stable leading history block remains cached even if a volatile trailing block changes; otherwise it anchors the first two messages. It keeps the last stable system block in normal turns, and uses that slot for the previous user boundary when a tool-heavy step would exceed Anthropic's 20-block lookback.

In OpenCode, subagent requests do not receive 1-hour TTL caching. The plugin detects child sessions through OpenCode's `x-parent-session-id` header, strips that internal header before forwarding to Anthropic, and leaves default ephemeral caching in place for those requests.

### Cache keepalive

Cache keepalive keeps recently used hybrid-mode session caches warm while the agent process is running. Control it from the Cache group: **Keep cache warm always**, **Cache keep window** (start and end hour), **Disable cache keep**, and **Cache keep for subagents** (`on`/`off`).

**Keep cache warm always** keeps tracked sessions warm continuously for as long as the agent process remains open. Windows use local 24-hour time and are start-inclusive/end-exclusive: start `9`, end `23` runs from 09:00 until 22:59, and overnight windows such as start `23`, end `9` are accepted.

Cache keepalive only tracks requests when the cache is enabled in `hybrid` mode. For each active session seen in the configured schedule, the package keeps an in-memory clone of the latest rewritten Anthropic request and sends a non-streaming `max_tokens: 0` pre-warm request about five minutes before the 1-hour cache entry would expire. **Cache keep status** lists every live tracked session across OpenCode projects and plugin processes; Pi reports its own separately scoped live sessions.

Request bodies, headers, and tokens remain in memory. A lease-backed file under the system temporary directory shares only session IDs and cache timing for cross-instance status; records from stopped processes disappear from status after about three minutes.

Pre-warm requests preserve explicit cache anchors but remove response-only fields that Anthropic rejects with `max_tokens: 0`, such as streaming, enabled thinking, structured output format, and forced/any tool choice. The feature works only while OpenCode or Pi is running and the machine is awake, and cache writes are still billed when the cache entry is no longer warm.

## Claude quota window priming

Quota-window priming is off by default. In OpenCode, turn it on or off with **Enable Prime** and **Disable Prime** in the `/claude` menu's Extras group; **Prime quota window status** shows its state and usage.

When enabled, the plugin watches each OAuth account's 5-hour quota reset. About one minute after a confirmed reset, it sends one minimal `claude-haiku-4-5` request so the next window starts without waiting for a normal prompt. Usage is measured from response accounting.

Scheduled fires happen only after the quota window has reset. If an idle account has no cached reset time, the plugin sends one bootstrap request to establish its first observed window. When several processes share an account store, each tries to create a claim file for that account and reset; creating the file is atomic, so exactly one process succeeds and sends the request.

Claim files live in a temporary directory, separated by account store and credential lineage. Cleanup removes files older than six hours. Ordinary token refresh keeps the lineage; a new sign-in starts a new one. Private runtime state stores cumulative priming usage counters, not a history of primed windows. Legacy claim files are not migrated. Without the old claim, the new scheduler can treat an already primed window as unclaimed and send one extra request.

Pi shows **Prime quota window status** but has no Prime on/off actions; enable or disable priming from OpenCode.

## OpenCode lane start

**Fire lane start** in the `/claude` menu's Extras group is OpenCode-only. It queues one synthetic turn for the current session.

The action fires immediately. The synthetic prompt, a turn generated by the plugin rather than typed by you, uses the session's current model, agent, and variant, then travels through the ordinary quota, routing, cache, relay, signing, and response pipeline. OpenCode shapes that OAuth request to `max_tokens: 1` while keeping streaming enabled, and correlates the request by its synthetic message ID. A queued turn means OpenCode accepted it into the session's queue; it does not mean Anthropic has completed the request.

> [!IMPORTANT]
> This is a real billed request. The one-token limit reduces generated output only; Anthropic still charges for prompt-cache reads and any new cache writes. Use it when you plan to resume the session before the refreshed cache expires.

Pi does not offer **Fire lane start**, the command that warms the session's prompt cache.

### Cache diagnostics (beta)

The `cache-diagnosis-2026-04-07` beta is measure-only. It asks Anthropic to report prompt-cache diagnostics; it does not change cache controls or routing. OpenCode captures the provider's top-level response ID as an opaque string and sends it as `diagnostics.previous_message_id` on the next request in the same session. The first request sends `null`.

The `MC-CACHE-DIAG ` line is a versioned, one-line JSON record. Records and their beta side-channel are emitted only at debug level; choose **Logging level** → `debug` in the `/claude` menu's Diagnostics group to capture them. Because emission is gated on the runtime log level, an empty record stream is ambiguous between a quiet system and a level below debug — liveness checks must cross-reference an independent activity witness (billing, usage rows, or dumps) instead of reading silence as absence of cache traffic. Version `2` contains these fields:

| Field | Type | Source |
| --- | --- | --- |
| `v` | `2` | Capture schema |
| `source` | string | Observation path; known values are `"turn"`, `"start"`, and `"prewarm_cachekeep"`, but consumers must tolerate future values |
| `synthetic` | boolean | Whether this observation was generated by plugin machinery rather than a real turn |
| `account_id` | string | Persisted plugin-internal OAuth account identifier used by routing and the sidebar; stable across restarts and token refreshes, so consumers may key timelines on it. Opaque mixed key space (the main account is a sentinel string, fallbacks are UUIDs) — never validate its shape |
| `betas_hash` | 16-character lowercase hex | xxHash64 (seed `0`) of the sorted `anthropic-beta` list actually sent, truncated to its first 16 hexadecimal characters |
| `requested_model` | string, optional | Sent request-body model, present only when it differs from the served Anthropic response model |
| `session_id` | string | OpenCode session affinity |
| `ts_ms_received` | integer | Local response receipt time |
| `model` | string | Anthropic response |
| `is_subagent` | boolean | Original request context |
| `ttl_sent` | `"1h" \| "5m" \| null` | Last valid cache breakpoint in the sent body |
| `cache_read` | number | `usage.cache_read_input_tokens` |
| `cache_creation` | number | `usage.cache_creation_input_tokens` |
| `input_tokens` | number | `usage.input_tokens` |
| `ephemeral_5m_tokens` | number | `usage.cache_creation.ephemeral_5m_input_tokens` |
| `ephemeral_1h_tokens` | number | `usage.cache_creation.ephemeral_1h_input_tokens` |
| `message_id` | string | Anthropic response top-level `id` |
| `previous_message_id` | string \| null | Sent `diagnostics.previous_message_id` |
| `diag_state` | `"absent" \| "server_null" \| "pending" \| "populated"` | Anthropic response envelope |
| `miss_reason` | string, optional | `diagnostics.cache_miss_reason.type` |
| `cache_missed_input_tokens` | number, optional | `diagnostics.cache_miss_reason.cache_missed_input_tokens` |

`cache_missed_input_tokens` is a byte-derived, pre-tokenization magnitude indicator, not a token count: it can differ from and occasionally exceed `input_tokens`, so never difference it against usage fields.

All required usage counters must be finite, non-negative numbers. A malformed required counter rejects the whole record rather than emitting a partial receipt.

Consumers classifying these records should check `cache_read` before `miss_reason`: `cache_read > 0` is a fact and `miss_reason` is an interpretation, and facts win. On multi-turn agent traffic a populated `*_changed` reason routinely coexists with a full prefix hit (each turn appends messages), so a populated-first classifier inverts every such record into a false miss.

Known sources map to `synthetic` as follows:

| `source` | `synthetic` |
| --- | --- |
| `turn` | `false` |
| `start` | `true` |
| `prewarm_cachekeep` | `true` |

Cache observations for the plugin-generated turn queued by **Fire lane start** appear as ordinary `MC-CACHE-DIAG ` records with `source: "start"`.

`synthetic` wins on conflict. A disagreement for a known source is an emitter defect: OpenCode writes one warning and still emits the record with the supplied `synthetic` value. Unknown future sources have no mapping and must not be rejected by consumers.

The first observation of each `betas_hash` in a process also writes `MC-CACHE-DIAG-BETAS {"hash":"…","betas":[…]}` at debug level on the `cache-diagnostics` logger channel. Its sorted beta list makes an observed hash interpretable without reconstructing headers; repeated hashes do not emit another side-channel line.

The trailing space in `MC-CACHE-DIAG ` is load-bearing: a record line has a space after `MC-CACHE-DIAG`, while the beta side-channel line has a hyphen. Do not trim the delimiter or write a trimming consumer. `grep -c "MC-CACHE-DIAG"` over-counts because it includes beta lines; count records with `grep -c "MC-CACHE-DIAG "` or an anchored equivalent.

The four diagnostic states are:

| State | Response shape |
| --- | --- |
| `absent` | No `diagnostics` property |
| `server_null` | `diagnostics: null` |
| `pending` | `diagnostics.cache_miss_reason: null` |
| `populated` | An object `diagnostics.cache_miss_reason` with a non-empty string `type`, including `"unavailable"` |

Only valid Message envelopes produce an `MC-CACHE-DIAG ` record. Malformed or error responses are not mapped to `absent`; they retain ordinary response handling and dumps. `ttl_sent` is reduced from the last valid breakpoint in the actual body sent. A short-gap `previous_message_not_found` result is also recorded as a canary when the previous provider ID was captured less than five minutes earlier.

`unavailable` is expected when any prompt-affecting parameter changes between requests. This includes the active Anthropic beta-header set; structured-output requests use a different beta set and can therefore produce `unavailable`. Diagnostics are scoped to the provider's cache fingerprint, organization, and workspace. Fingerprints expire, so a later request can miss after a long gap even when the body is unchanged. These records measure the result; they do not guarantee a cache hit.

Diagnostics comparison requires a cacheable prefix. Requests below the model's cacheable minimum or without cache breakpoints return `diagnostics: null` even when the request genuinely changed; consumers must gate interpretation of `null` on observed cache activity.

`diag_state` is always a string and never JSON null: `absent | server_null | pending | populated`.

Version 1 records come from the unversioned-source era and cannot distinguish prewarms from turns; consumers must treat their source as unknown and cannot split machinery from traffic retroactively. Version 2 always states the source.

When request dumps are enabled, each response gets a `.response.json` artifact containing status and parsed response metadata, but no response content. Lane-start requests are tagged `-start-`; CacheKeep prewarms retain `-prewarm-cachekeep-`. If Prime prewarming is enabled in a build that supports it, those artifacts use `-prewarm-prime`. Treat request bodies and related dump files as sensitive local debugging data.

## Claude fast mode

Both OpenCode and Pi can save a fast-mode setting that applies to later requests and survives process restarts. It requests Anthropic fast mode for supported Opus models with **Enable fast mode** and **Disable fast mode** in the `/claude` menu's Extras group. **Fast mode status** shows the current setting.

When enabled, supported requests add `speed: "fast"` to the Anthropic JSON body and include the `fast-mode-2026-02-01` beta header. Unsupported models are left at standard speed. Anthropic supports fast mode for `claude-opus-4-8`, `claude-opus-5`, and `claude-opus-5-5`. Opus 4.7 rejects `speed: "fast"`, while Opus 4.6 runs at standard speed; Claude Fable and Mythos 5/5.1 are not fast-mode models.

Fast and standard speeds do not share prompt-cache prefixes, so switching this setting can cause cache misses.

### Estimate cache savings from OpenCode history

The repo includes an OpenCode SQLite analyzer that compares estimated Claude cost under three scenarios: no prompt cache, Anthropic's default 5-minute cache, and this plugin's 1-hour cache mode.

From a repo checkout:

```bash
bun run analyze:cache -- --days 7
```

Useful variants:

```bash
# Restrict to one OpenCode session
bun run analyze:cache -- --session ses_... --days 4

# Emit machine-readable output
bun run analyze:cache -- --days 7 --json

# Use a non-default OpenCode DB path
bun run analyze:cache -- --db ~/.local/share/opencode/opencode.db --days 30
```

The script reads OpenCode usage data from `~/.local/share/opencode/opencode.db` by default. It uses recorded prompt, cache-read, cache-write, and output tokens, then estimates counterfactual 5-minute and no-cache costs from the same turns. Its pricing table includes Claude Opus 4.5 through 4.8. The default 5-minute expiry threshold is 5 minutes; override it with `--idle-threshold-min <minutes>` if needed.

This analyzer is OpenCode-specific because it reads OpenCode's local message database.

## Optional Cloudflare relay

The relay is opt-in and user-owned. CortexKit does not run shared relay infrastructure for this plugin.

When enabled, the package sends large Anthropic request bodies to a Cloudflare Worker that you own. The first request for a session sends a full body; later requests send compact patches keyed by session affinity (`x-session-affinity` in OpenCode, Pi's stream `sessionId` in Pi). The Worker reconstructs the full Anthropic `/v1/messages` request and streams Anthropic's SSE response back to the client.

`relay setup` saves HTTP transport:

```json
"transport": "http"
```

HTTP is the default because it also works with relay Workers deployed by older releases. It still sends compact payloads through your Worker: the full request body for a session's first request, then only the changes for later requests. WebSocket is an opt-in persistent session transport for OpenCode 1 and Pi:

```json
"transport": "websocket"
```

WebSocket mode uses protocol v2 on `/ws`, keeps one connection per session (OpenCode `x-session-affinity`, Pi stream `sessionId`), and serializes same-session requests until the previous stream finishes. Existing deployed Workers must be redeployed with this package's current Worker script before `"transport": "websocket"` will work; older relay Workers only understand the legacy protocol. OpenCode 2 supports direct and HTTP relay transport only; with WebSocket selected, it refuses requests before sending them with `request refused: WebSocket relay is not supported on OpenCode 2; select HTTP relay or direct transport`.

Set up a relay in your Cloudflare account with the OpenCode package CLI. The CLI saves relay settings in OpenCode's local account pool, so run [setup](#quick-setup-recommended) for OpenCode first to prepare the local account pool before the CLI saves settings:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bunx @cortexkit/opencode-anthropic-auth relay setup
```

Or with npm:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx -y @cortexkit/opencode-anthropic-auth relay setup
```

The setup command:

1. Creates a Cloudflare KV namespace.
2. Uploads the relay Worker module.
3. Generates a relay shared secret.
4. Enables the Worker.
5. Saves the relay URL, shared secret, and HTTP transport in OpenCode's local account pool.

`relay setup` configures OpenCode's relay settings, not Pi's. During the first local setup, existing relay settings (including `transport`) are copied from `anthropic-auth.json` into that application's pool; the `/claude` menu has no relay actions.

The Cloudflare API token is used only during setup and is not stored by the plugin. Re-running setup with the same Worker name uploads the current Worker script again; this is how existing relay Workers are upgraded for protocol changes such as WebSocket v2.

If relay setup or transport fails before streaming begins, the plugin falls back to direct Anthropic requests unless `fallbackToDirect` is set to `false`.

> [!NOTE]
> The relay reduces upload bytes from your machine to Cloudflare. Anthropic still receives the complete `/v1/messages` request from the Worker, so the relay does not reduce Anthropic input tokens or billing by itself. Use prompt caching for server-side cache benefits.

### Relay diagnostics

Relay diagnostics are written to a temp-file log:

```bash
tail -f "$(node -p 'require("node:os").tmpdir()')/opencode-anthropic-auth.log"
```

Successful relay usage logs entries such as:

```text
configured transport=websocket protocol=2
used relay transport=websocket protocol=2 mode=patch
used relay transport=http protocol=1 mode=full_sync
```

Direct fallback logs `falling back direct`.

### Request dumps

For relay/cache debugging, enable exact request dumps from inside OpenCode or Pi with **Enable request dumps** and **Disable request dumps** in the `/claude` menu's Diagnostics group. **Dump status** shows the current setting.

When enabled, the plugin writes artifacts under the OS temp directory:

```bash
ls "$(node -p 'require("node:os").tmpdir()')/opencode-anthropic-auth-dumps"
```

Each filename includes a sanitized session/affinity segment so dumps from different sessions are easier to find. Each request gets:

- `*.body.json` — final rewritten Anthropic request body.
- `*.meta.json` — hashes, byte counts, diff ranges, model, `messages[0]` hash, later-message hash, and cache-relevant structure.
- `*.relay.json` — redacted relay payload/frame metadata for relay requests.
- `*.request.json` — redacted direct request URL, method, and headers for direct requests.

The dump setting is saved with the host's other plugin settings. Dumps may contain prompt content and should be treated as sensitive local debugging artifacts.

## Environment variables

| Variable | Description |
| --- | --- |
| `ANTHROPIC_BASE_URL` | Override the Anthropic API endpoint. Must be HTTP(S). |
| `ANTHROPIC_CUSTOM_HEADERS` | Add proxy-specific headers on API-key and proxy routes. Authentication, protocol, framing, and internal correlation headers cannot be overridden. Ignored for OAuth requests. |
| `ANTHROPIC_MODEL` | Default proxy alias for any `claude-*` model. Ignored for OAuth requests. |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Proxy alias for `claude-sonnet-*` models. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Proxy alias for `claude-opus-*` models. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Proxy alias for `claude-haiku-*` models. |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | Proxy alias for `claude-fable-*` and `claude-mythos-*` models. |
| `ANTHROPIC_INSECURE` | Set to `1` or `true` to skip TLS verification when `ANTHROPIC_BASE_URL` is set. |
| `OPENCODE_ANTHROPIC_AUTH_FILE` | Override OpenCode's old sidecar path. The local account pool and its related files are created next to it. |
| `OPENCODE_ANTHROPIC_AUTH_STATE_FILE` | Override the old sidecar state file that setup reads during migration. |
| `OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE` | Override the owner-only OpenCode Claustrum enrollment-token path. |
| `OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE` | Override the Claustrum connection file OpenCode uses. |
| `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE` | Set to `legacy` to bypass Anthropic's server policy and use deterministic 10-response client recovery exclusively. The default tries server-side safety fallback first and uses client recovery as a backstop. |
| `OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE` | Override the persistent sticky-balanced session assignment file. |
| `OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR` | Override the temporary OpenCode CacheKeep session lease directory. |
| `OPENCODE_ANTHROPIC_AUTH_RPC_DIR` | Override the directory for the OpenCode TUI menu RPC bridge (port file + token). Defaults to a per-project path under the OpenCode state directory. |
| `PI_ANTHROPIC_AUTH_FILE` | Override Pi's old sidecar path. The local account pool and its related files are created next to it. |
| `PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE` | Override the owner-only Pi Claustrum enrollment-token path. |
| `PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE` | Override the Claustrum connection file Pi uses. |
| `PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE` | Override the persistent Pi sticky-balanced session assignment file. |
| `PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR` | Override the temporary Pi CacheKeep session lease directory. |
| `PI_CODING_AGENT_DIR`, `PI_AGENT_DIR` | Override Pi's agent directory when deriving default paths. |
| `XDG_STATE_HOME` | Base directory for the default enrollment files (`cortexkit/anthropic-auth/<host>-enrollment.json`). Defaults to `~/.local/state`. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare token used by `bunx @cortexkit/opencode-anthropic-auth relay setup`. Not stored. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID used by relay setup. |

`ANTHROPIC_CUSTOM_HEADERS` and the model-alias variables apply only to API-key and proxy routes. OAuth requests keep the Claude Code header and model identity unchanged. Custom headers accept either a JSON object or comma/newline-separated `name: value` entries. A configuration containing an invalid or protected header is ignored as a whole with one redacted warning; it cannot replace route authentication, Anthropic protocol headers, body framing, or plugin-internal correlation headers.

An `ANTHROPIC_BASE_URL` path is preserved. For example, `https://proxy.example/anthropic` sends requests to `/anthropic/v1/messages`, while a versioned base such as `https://proxy.example/anthropic/v2` sends to `/anthropic/v2/messages`. Existing version segments are not duplicated, and unrelated paths ending in `/messages` are not rewritten.

## Request rewriting

For Claude Pro/Max OAuth requests, the plugin works at the final Anthropic wire-request layer:

1. Rewrites request URLs when `ANTHROPIC_BASE_URL` is configured.
2. Normalizes Claude-compatible OAuth headers and beta flags.
3. Removes OpenCode-specific identity text from system blocks.
4. Prepends Claude Code identity and billing-header blocks.
5. Rewrites cache controls according to the configured cache mode.
6. Renames MCP tool names into Claude-compatible PascalCase form.
7. Opts eligible Fable 5/5.1 and Opus 5 OAuth requests into Anthropic's server-side safety fallback, restores stored fallback boundaries, and activates replay-safe client recovery if the response still refuses.
8. Computes final-body `cch` over the fully serialized request body.

The sanitizer is anchor-based: it removes paragraphs containing known OpenCode documentation or source anchors, performs a small set of inline replacements, and preserves the rest of the prompt including user/project instructions, tool policy, environment context, and file paths.

## Development

Workspace layout:

```text
packages/core      Shared Anthropic auth core
packages/opencode  OpenCode plugin and CLI
packages/pi        Pi package/extension
```

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run typecheck
bun run test
bun run build
bun run lint
bun run format:check
```

### Build modes

Two build modes are available:

```bash
bun run build      # Deploy: bun build → bundled dist/ with all deps inlined (core + xxhash-wasm)
bun run build:dev  # Dev: tsc → individual dist/*.js files (requires workspace node_modules)
```

The default `build` uses `bun build` to bundle `@cortexkit/anthropic-auth-core` and all transitive dependencies into self-contained output files. No `node_modules/` needed at runtime — the plugin works via `file://` path in OpenCode config:

```json
{
  "plugin": ["file:///path/to/anthropic-auth/packages/opencode"]
}
```

`@opencode-ai/plugin` remains external (peer dep provided by OpenCode).

Inspect package contents:

```bash
bun run pack:core:dry
bun run pack:opencode:dry
bun run pack:pi:dry
```

Test a local build with OpenCode:

```bash
bun run dev
```

This builds the plugin, symlinks the output into `.opencode/plugins/`, and starts `tsc --watch`. Restart OpenCode after starting the dev script and after rebuilds.

Clean the local dev symlink with:

```bash
bun run dev:clean
```

## Release

This repo uses CortexKit's tag-driven release workflow.

Preview a release:

```bash
./scripts/release.sh 1.9.0 --dry
```

Create and push the release tag:

```bash
./scripts/release.sh 1.9.0
```

Wait for GitHub Actions:

```bash
./scripts/wait-release.sh v1.9.0
```

The release workflow runs checks, publishes the core, OpenCode, and Pi packages to npm with provenance, and creates the GitHub release.

## Troubleshooting

- Clear OpenCode's plugin cache after plugin config changes: `rm -rf ~/.cache/opencode`.
- Start OpenCode or Pi again only after setup finishes; setup requires every host process to be stopped.
- If an OpenCode fallback account shows `invalid_grant`, run `bunx @cortexkit/opencode-anthropic-auth login <label>` again for that account. For the main account, sign in again from the host (see [Signing in](#signing-in)) or stop the hosts and run `setup --login --no-claustrum`.
- If requests refuse because the enrollment record cannot be read, repair the enrollment files or use **Disconnect from the vault** in `/claude`, which removes them and returns the host to local accounts.
- If requests refuse because OpenCode holds a separate Anthropic login while enrolled in the vault, remove that login, then choose **Claude via credential vault** (OpenCode 1) or **Claude vault accounts** (OpenCode 2); or disconnect from the vault.
- Tail relay diagnostics when debugging relay setup: `tail -f "$(node -p 'require("node:os").tmpdir()')/opencode-anthropic-auth.log"`.
- Open `/claude` to inspect account status, quota, and refresh errors surfaced by the plugin.

## License

MIT
