# Accounts, routing and quota

A native account pool holds the Claude subscription accounts and optional API-key routes for one host. OpenCode 1 and 2 share OpenCode's pool; Pi has a separate pool. Enrollment authority selects either that local pool or the vault, never a mixture of both.

## Local storage

OpenCode defaults to `~/.config/opencode/`; Pi defaults to `~/.pi/agent/`. The directory containing `OPENCODE_ANTHROPIC_AUTH_FILE` or `PI_ANTHROPIC_AUTH_FILE`, when set, determines the corresponding native path set. Files have distinct roles:

| File | Contents |
| --- | --- |
| `anthropic-auth-pool.json` | Local account rows, route definitions, settings and local quota metadata |
| `anthropic-auth-pool-state.json` | Private local credentials |
| `anthropic-auth-native-state.json` | Per-account runtime metadata, including profile, validation and Prime state |
| `anthropic-auth-pool-routing-state.json` | Default local session pins, keyed by hashed session IDs |
| `anthropic-auth-migration.json` | Authority and migration journal |

The legacy `anthropic-auth.json` and `anthropic-auth-state.json` are import sources, not live serving stores. Use [stopped-host setup](installation.md#recommended-setup) to import them. [Empty initialization](opencode-2.md#empty-initialization) is different: it creates authority without importing credentials. Later import preserves native preferences and existing native session pins while the pool has no account data. Once populated, native tokens are never merged from a separate host login, even for the same account UUID.

For empty-init authority, the local routing destination is `OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE` or `PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE` when set, otherwise the path derived from the native pool config. A completed legacy import records its routing destination in the journal, and serving uses that recorded file. Preferences or session pins alone do not make a pool populated; private account entries do, even with no public account rows.

## Adding and managing accounts

Use `/claude` → **Accounts** to start and finish OAuth sign-in, add an API-key fallback, enable/disable, reorder, remove or reset backoff. Local changes refuse while enrolled in the vault. The [OpenCode CLI](commands.md#opencode-cli) also offers `login`, `api add` and `list` for OpenCode local custody only.

OAuth login must resolve a verified Claude account UUID. Credentials and refresh operations stay in the native runtime; the host's inert marker is never a credential. Re-login an account with a permanent `invalid_grant` failure rather than copying tokens between stores. The plugin never uses a separate OC1 login's access or refresh tokens; no claim is made about OpenCode 1.18's own host-side refresh behavior.

## Routing modes

| Mode | Policy |
| --- | --- |
| `main-first` | Prefer the main account, then eligible fallbacks |
| `fallback-first` | Prefer eligible fallback accounts before main |
| `sticky-balanced` | Assign cold sessions using spendable quota and keep session affinity across requests and restarts |

Change mode in `/claude` → **Routing**. **Reset routing session** clears the current session's pin; it does not remove accounts. Pins are quota-aware session-affinity hints, not credentials. Changing the selected model can require a fresh assignment. Model-specific exhaustion can move among OAuth accounts, but paid API-key fallback requires confirmed general OAuth exhaustion, not just an exhausted model-specific limit or a display percentage rounded up to 100%.

## Quota and limits

Quota shows five-hour, seven-day and model-scoped windows when available. OpenCode's **Refresh quota** action requests fresh readings; Pi shows the summary without a refresh action. Passive response headers and quota API polling have different coverage: headers can update standard windows without supplying model-scoped limits.

`quota.minimumRemaining.five_hour` and `.seven_day` are minimum **remaining** percentages, not usage percentages (`5h` and `1w` are menu aliases). `quota.failClosedOnUnknownQuota` controls unknown readings where no positive killswitch floor applies. Killswitch thresholds are separate hard blocks:

- A positive five-hour or seven-day floor blocks missing readings for that window regardless of `failClosedOnUnknownQuota`.
- A positive `scoped` minimum-remaining percentage blocks missing model-specific quota information. An explicitly empty scoped-window list means no separate window applies.
- OpenCode can edit killswitch thresholds in **Limits**; Pi does not expose those edits.

The optional `quotaHeaderFeed.enabled` setting is OpenCode-only, disabled by default and requires restart. It publishes allowlisted quota observations, opaque identity and timestamps to owner-only temporary lease files, not tokens, request bodies, model IDs or refresh errors. It shares observations already obtained from responses rather than making new quota API requests.

## Settings and custody

Use menu actions for routing, cache, CacheKeep, fast mode, diagnostics and supported limits. `claudeCache.mode` accepts `explicit`, `automatic` or `hybrid`; `cacheKeep` controls keepalive, and `relay` controls an optional transport. See [cache](cache.md#cache-modes) and [transports](transports.md#relay) for their effects and costs.

Vault settings, roster and routing use a separate `anthropic-auth-vault-*` namespace. While enrolled, local credentials are not served, refreshed, polled or kept warm. See [vault accounts](vault.md#accounts-while-enrolled) and the [authority table](custody-state-machine.md#authority).
