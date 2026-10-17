# Settings and routing reference

## Settings

Plugin settings live in the host's local account pool, or in separate `anthropic-auth-vault-settings.json` while enrolled. Change settings with a `/claude` menu action where available. Setup imports supported preferences from the old sidecar once; editing a retired `anthropic-auth.json` does not change live settings. Do not copy credential or journal bytes into a settings example. See [configuration ownership](installation.md#configuration-ownership) and the [storage map](accounts-and-routing.md#local-storage).

The imported preference fields are listed below. Values such as quota thresholds and schedules are user choices, not a complete default configuration.

| Section | Fields / purpose |
| --- | --- |
| `routing` | `mode`: `main-first`, `fallback-first`, `sticky-balanced` |
| `fallbackOn` | Retryable OAuth fallback statuses; default `[401, 403, 429]` |
| `refresh` | `enabled`, `intervalMinutes`, `refreshBeforeExpiryMinutes` |
| `quota` | `enabled`, `checkIntervalMinutes`, `refreshEveryNRequests`, `minimumRemaining`, `failClosedOnUnknownQuota`, `showToasts` |
| `quotaHeaderFeed` | `enabled`: OpenCode 1 opt-in, disabled by default; restart required |
| `killswitch` | `enabled`, `main` thresholds and per-account `accounts` overrides |
| `claudeCache` | `enabled`, `mode`: `explicit`, `automatic`, `hybrid` |
| `cacheKeep` | `enabled`, `always`, `startHour`, `endHour`, `subagents` |
| `prime` | `enabled`: opt-in quota-window priming |
| `dump`, `logging` | `enabled` request dumps; `level`: `error`, `warn`, `info`, `debug`, `trace` |
| `claudeFast` | `enabled`: supported Opus fast mode |
| `thinkingBinding` | `prefixMismatchBehavior`: `account-default`, `error`, `drop_block` |
| `costZeroing` | `enabled`: OpenCode OAuth price display, true by default |
| `relay` | `enabled`, `url`, `transport` (`http` / `websocket`), `fallbackToDirect`; its token is private credential state |

[Cache](cache.md), [models](models.md) and [transports](transports.md) describe the effects. `quota.showToasts: true` opts into OpenCode quota notifications. Local credential state and per-account runtime metadata are separate from preferences; quota, profile, validation and Prime state are not all in the same file.

## Fallback accounts and session affinity

Fallbacks are separate OAuth accounts or Anthropic-compatible API-key routes in the active custody source. By default the main account is tried first, then eligible OAuth fallbacks in order. `fallback-first` reverses that preference. `sticky-balanced` assigns a new session using remaining quota above configured minimums in five-hour, seven-day and model-scoped windows.

The balanced allocator normalizes headroom by time until reset and accounts for the initial prompt before the next quota refresh. It persists the assignment by hashed session ID across processes and restarts. **Reset routing session** clears only the current session. A user-selected model change discards its old assignment; transparent safety recovery retains the account. Existing hybrid CacheKeep sessions can seed their warm route instead of changing accounts unnecessarily.

Affinity survives network/relay failures, 5xx responses, unconfirmed 429s, quota-probe failures and relative weight changes. Confirmed seven-day or matching model-scoped exhaustion can move the session. Confirmed five-hour exhaustion moves it only when more than 15 minutes remain before reset; within 15 minutes the route stays and returns `Retry-After`. Disabled/removed accounts, permanent re-login failures and killswitch blocks can also cause reselection. Direct Opus sessions prefer usable accounts whose Fable quota is exhausted, preserving Fable-capable quota.

### API-key fallback

API-key routes are not part of balanced first assignment. They require confirmed **general** OAuth exhaustion, not just model-specific exhaustion, stale readings, low-but-nonzero quota, unconfirmed 429s, 401 or 403. A live quota check can confirm the exhaustion after a model response reports a rate limit. Requests must be safely replayable for a retry; an already-consumed/non-replayable body returns the original response unchanged.

Routes use `Authorization: Bearer <key>` by default, or `x-api-key` when selected. An Anthropic-compatible base such as `https://api.kie.ai/claude` gains `/v1/messages` without duplicating a versioned path. Keys remain in private pool state. OpenCode CLI `login`, `api add` and `list` manage only OpenCode's local pool; add Pi accounts through Pi's menu. OpenCode's account-writing CLI commands and Pi's account-addition actions refuse local changes while the corresponding host is enrolled in the Claustrum vault. See [CLI commands](commands.md#opencode-cli).

### Token refresh

Local refresh and its persisted retry delay are bound to the refresh-token generation, so a rejected token's backoff does not block a replacement sign-in. Re-login after a permanent `invalid_grant`; **Reset account backoff** clears the matching refresh and quota backoff. The plugin refreshes credentials in its account pool, never credentials from a separate login stored by OpenCode 1. OpenCode's own handling of that separate login is outside this plugin's refresh policy.

## Quota and killswitch

Quota routing compares **remaining** percentages. `five_hour` / `seven_day` accept menu aliases `5h` / `1w`. A killswitch floor is the minimum remaining percentage required to use an account. A positive five-hour or seven-day floor blocks requests on that account when its reading is missing, regardless of `quota.failClosedOnUnknownQuota`; without a positive floor, unknown readings follow that setting. A positive `scoped` floor requires a model-specific quota reading; an explicitly empty scoped list means no separate window applies. OpenCode offers the threshold edits in **Limits**; Pi does not.

## Quota header feed

The OpenCode 1 plugin can publish quota observations from Anthropic model-response headers; the feed does not independently poll the quota API. Enable `quotaHeaderFeed.enabled` and restart. Owner-only files under `$TMPDIR/opencode-anthropic-auth/quota-header-feed` expire after three minutes; `OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR` redirects them.

The allowlisted record contains quota-window values and provenance (which values came from response headers or quota polling), observation time, configured OAuth-account count and account identity references (including a resolved Anthropic account UUID when available). It does not contain tokens, raw headers, request bodies, model IDs or refresh errors. Treat the directory as local account metadata, not an anonymous public telemetry feed.

Implementation: [settings import whitelist](../packages/core/src/native-migration-source.ts), [native account view](../packages/core/src/native-account-view.ts), [sticky routing](../packages/core/src/sticky-routing.ts), [account policy](../packages/core/src/accounts.ts), [native credential runtime](../packages/core/src/native-account-runtime.ts), [quota feed](../packages/core/src/quota-header-feed.ts), and [OpenCode publisher](../packages/opencode/src/index.ts).
