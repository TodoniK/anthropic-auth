# OpenCode sidebar and TUI preferences

## Quota sidebar

OpenCode 1 can render a live quota sidebar without opening `/claude`. This is an OpenCode 1 TUI plugin, not a Pi widget or an OpenCode 2-only setup requirement.

OpenCode 1 loads TUI plugins from `tui.json` or `tui.jsonc` in its config directory, separately from the main `plugin` array:

```json
{
  "plugin": ["@cortexkit/opencode-anthropic-auth@VERSION"]
}
```

Replace `VERSION` with the installed release and use the same package version as the main `opencode.json`/`opencode.jsonc` plugin entry. Restart after changing registration. [Setup](installation.md#recommended-setup) registers the main `opencode.json`/`opencode.jsonc` and separate `tui.json`/`tui.jsonc` for OpenCode 1 or `--opencode=both` (OpenCode 1 and 2 together). OpenCode 2-only setup registers just the main config.

The sidebar polls plugin state and refreshes on session/message events using the active theme:

- **Quota:** per-account five-hour and seven-day usage bars, active/blocked/idle status and reset times.
- **Routing:** current route, standard/fast mode, relay state and safety-recovery status.
- **Cache:** keepalive window and tracked-session count when configured.
- **Health:** quota API and token-refresh backoffs; hidden without an active backoff. A `LIMITED` badge appears when an account has an active quota-API or token-refresh backoff.

Click `CLAUDE` to collapse or expand. The collapsed view shows one line per visible account in placement order, using only vault accounts while enrolled. Remaining quotas use the narrow form `5h 92% · 7d 66% · Fa 98% left`; `cr N%` adds extra-usage credits. Both account-wide windows remain visible, with a dash for a missing reading, followed by only the tightest model-specific window. Model names start with two letters and extend if needed to distinguish colliding names. Account labels are ellipsized to preserve the quota text. Only a fresh active account retains the bold quota color; other accounts and stale readings are dim, with reading age shown in the expanded view instead. Fast mode is shown when enabled. Collapse state persists across restarts by default; set `rememberCollapsed: false` for per-session behavior.

## TUI preferences

The optional `tui-preferences.jsonc` is a user configuration file, not a repository file. Its location is `OPENCODE_TUI_PREFERENCES_FILE` when set; otherwise it is in `OPENCODE_CONFIG_DIR`, `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`, in that order. Each plugin owns one nonnumeric top-level key; this plugin uses `anthropic-auth`.

The following example retains the defaults. Omitting `collapsed` lets `startCollapsed` decide the initial state:

```jsonc
{
  "anthropic-auth": {
    "forceToTop": false,
    "order": 160,
    "startCollapsed": false,
    "rememberCollapsed": true,
    "pollMs": 1500,
    "refreshDebounceMs": 200,
    "header": { "label": "CLAUDE", "showVersion": true },
    "sections": {
      "quota": true,
      "fallbackAccounts": true,
      "routing": true,
      "cache": true,
      "health": true,
      "pacing": true
    },
    "appearance": {
      "barWidth": 10,
      "barFilledChar": "█",
      "barEmptyChar": "░",
      "warnThreshold": 50,
      "errorThreshold": 80
    }
  }
}
```

The plugin writes `collapsed` on header clicks, preserving comments and unrelated keys. Most edits are picked up live; layout (`forceToTop` and `order`) is applied at TUI startup and requires restart.

| Preference | Accepted range |
| --- | --- |
| `order` | -10000 to 10000 |
| `pollMs` | 500 to 30000 |
| `refreshDebounceMs` | 50 to 5000 |
| `header.label` | Nonempty, truncated to 20 characters |
| `appearance.barWidth` | 4 to 40 |
| `appearance.warnThreshold` | 0 to 99 used percent |
| `appearance.errorThreshold` | 0 to 100, adjusted to exceed the warning threshold |

Out-of-range numbers are clamped; wrong types fall back per key. Missing or malformed files use defaults. The `LIMITED` badge remains visible when degraded regardless of display preferences.

With `sections.pacing` enabled, bars show even-burn headroom (`▒`) or overshoot (`▓`). Off-pace windows report reserve/deficit and projected exhaustion time when appropriate. An amber collapsed summary is a pacing projection, not quota exhaustion; red still follows actual usage thresholds.

### forceToTop convention

Slots render in ascending order. A forced plugin uses `-100000 + indexOfKeyInFile`, so forced plugins precede manual orders and follow their top-level key positions. Reorder keys to reprioritize them. Use nonnumeric plugin names: JavaScript orders integer-like keys ahead of other keys.

Other plugins can use the exported helpers:

```ts
import {
  computeEffectiveOrder,
  readTuiPreferencesFile,
} from '@cortexkit/opencode-anthropic-auth/tui-prefs'

const root = await readTuiPreferencesFile()
const order = computeEffectiveOrder(root, 'my-plugin', 200)
```

Implementation: [preferences and ordering](../packages/opencode/src/tui-preferences.ts), [sidebar state](../packages/opencode/src/sidebar-state.ts), and [TUI renderer](../packages/opencode/src/tui.tsx).
