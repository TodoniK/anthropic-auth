/** @jsxImportSource @opentui/solid */

// The CLAUDE quota sidebar, shared by the OpenCode 1 and OpenCode 2 TUIs.
// Each host supplies the sidebar state, a flat theme token set and the
// preference controller; this module only renders.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatCreditAmounts,
  type QuotaWindowPart,
  quotaDisplayProjection,
  quotaWindowParts,
} from '@cortexkit/anthropic-auth-core'
import { type BoxRenderable, type RGBA, TextAttributes } from '@opentui/core'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  onCleanup,
  Show,
} from 'solid-js'
import {
  type AccountQuota,
  computeQuotaPacing,
  DEFAULT_SIDEBAR_STATE,
  FIVE_HOUR_MS,
  formatPrimeAccountValue,
  formatQuotaRowLabel,
  getCollapsedAccounts,
  getCollapsedQuotaSummary,
  getFableRecoverySummary,
  type QuotaPacing,
  resolveActiveAccount,
  SEVEN_DAY_MS,
  type SidebarState,
} from '../sidebar-state.js'
import {
  type AnthropicAuthTuiPrefs,
  type AppearancePrefs,
  PLUGIN_KEY,
  queueTuiPreferenceUpdate,
  readTuiPreferencesFile,
  resolveAnthropicAuthPrefs,
  watchTuiPreferences,
} from '../tui-preferences.js'

// Read package metadata from either the raw src/ entry or its generated
// src/tui-compiled/tui/ counterpart. Avoid a JSON import because package.json sits
// outside the declaration build's rootDir.
const PLUGIN_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const packageFile of [
    join(here, '..', '..', 'package.json'),
    join(here, '..', '..', '..', 'package.json'),
  ]) {
    try {
      const raw = readFileSync(packageFile, 'utf8')
      const version = (JSON.parse(raw) as { version?: string }).version
      if (version) return version
    } catch {
      // Try the path for the other TUI entry layout.
    }
  }
  return ''
})()

// biome-ignore lint/suspicious/noExplicitAny: opentui border prop not typed in plugin tui surface
const SINGLE_BORDER = { type: 'single' } as any

export type SidebarColor = RGBA | string

/** The flat theme tokens the sidebar draws with; OpenCode 1's `theme.current` has them all. */
export interface SidebarTheme {
  readonly text: SidebarColor
  readonly textMuted: SidebarColor
  readonly success: SidebarColor
  readonly warning: SidebarColor
  readonly error: SidebarColor
  readonly accent: SidebarColor
  readonly background: SidebarColor
  readonly borderActive: SidebarColor
}

type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'accent' | 'text'

// Tone -> theme token. Theme tokens only — never hardcoded colors. Fallbacks
// resolve to other theme tokens so the sidebar always tracks the active theme.
function toneColor(theme: SidebarTheme, tone: Tone): SidebarColor {
  switch (tone) {
    case 'ok':
      return theme.success ?? theme.accent
    case 'warn':
      return theme.warning ?? theme.accent
    case 'err':
      return theme.error ?? theme.accent
    case 'muted':
      return theme.textMuted ?? theme.text
    case 'accent':
      return theme.accent ?? theme.text
    default:
      return theme.text
  }
}

function usageTone(usedPct: number, appearance: AppearancePrefs): Tone {
  if (usedPct < appearance.warnThreshold) return 'ok'
  if (usedPct < appearance.errorThreshold) return 'warn'
  return 'err'
}

interface BarSegment {
  text: string
  tone: Tone
}

const PACE_RESERVE_CHAR = '\u2592'
const PACE_DEFICIT_CHAR = '\u2593'

// Variant C pacing bar: normal fill up to min(used, pace), then a pace
// segment covering the gap — headroom being banked (reserve, ok tone) or the
// overshoot itself (deficit, err tone) — then empty cells. Without pacing the
// bar renders as a single fill+empty pair, identical to the pre-pacing look.
// Empty text nodes still occupy a phantom cell in the opentui flex row, so
// zero-length segments are dropped from every return path (plain and pacing).
function quotaBarSegments(
  usedPct: number,
  appearance: AppearancePrefs,
  pacing: QuotaPacing | null,
): BarSegment[] {
  const width = appearance.barWidth
  const cells = (pct: number) =>
    Math.max(0, Math.min(Math.round((pct / 100) * width), width))
  const usedCells = cells(usedPct)
  const fillTone = usageTone(usedPct, appearance)
  const plain: BarSegment[] = [
    { text: appearance.barFilledChar.repeat(usedCells), tone: fillTone },
    {
      text: appearance.barEmptyChar.repeat(width - usedCells),
      tone: fillTone,
    },
  ]
  if (!pacing) return plain.filter((segment) => segment.text.length > 0)
  const paceCells = cells(pacing.pacePercent)
  const lo = Math.min(usedCells, paceCells)
  const hi = Math.max(usedCells, paceCells)
  if (hi === lo) return plain.filter((segment) => segment.text.length > 0)
  const overspent = usedCells > paceCells
  return (
    [
      { text: appearance.barFilledChar.repeat(lo), tone: fillTone },
      {
        text: (overspent ? PACE_DEFICIT_CHAR : PACE_RESERVE_CHAR).repeat(
          hi - lo,
        ),
        tone: overspent ? 'err' : 'ok',
      },
      { text: appearance.barEmptyChar.repeat(width - hi), tone: fillTone },
    ] as BarSegment[]
  ).filter((segment) => segment.text.length > 0)
}

function formatResetIn(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = new Date(resetsAt).getTime() - now
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) {
    const rm = mins % 60
    return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`
  }
  const days = Math.floor(hrs / 24)
  const rh = hrs % 24
  return rh > 0 ? `${days}d${rh}h` : `${days}d`
}

function formatUntil(until: number | undefined, now: number): string {
  if (!until) return ''
  const ms = until - now
  if (ms <= 0) return 'now'
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rm = mins % 60
  return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`
}

// --- Reusable components (aft-style) ---------------------------------------

function SectionHeader(props: {
  theme: SidebarTheme
  title: string
  marginTop?: number
}) {
  return (
    <box width='100%' marginTop={props.marginTop ?? 1}>
      <text fg={props.theme.text}>
        <b>{props.title}</b>
      </text>
    </box>
  )
}

function StatRow(props: {
  theme: SidebarTheme
  label: string
  value: string
  tone?: Tone
}) {
  return (
    <box width='100%' flexDirection='row' justifyContent='space-between'>
      <text fg={props.theme.textMuted}>{props.label}</text>
      <text fg={toneColor(props.theme, props.tone ?? 'text')}>
        <b>{props.value}</b>
      </text>
    </box>
  )
}

// Compact row for the collapsed view: muted label left, caller-provided value
// right. Mirrors StatRow's layout so columns line up.
function CollapsedRow(props: {
  theme: SidebarTheme
  label: string
  children: JSX.Element
}) {
  return (
    <box width='100%' flexDirection='row' justifyContent='space-between'>
      <text fg={props.theme.textMuted}>{props.label}</text>
      {props.children}
    </box>
  )
}

function CollapsedAccountRow(props: {
  theme: SidebarTheme
  account: ReturnType<typeof getCollapsedAccounts>[number]
  tone: Tone
  now: number
}) {
  const [width, setWidth] = createSignal(40)
  let row: BoxRenderable | undefined
  const summary = () => getCollapsedQuotaSummary(props.account.quota, props.now)
  const value = () => summary().text ?? '—'
  const labelWidth = () => Math.max(0, width() - Bun.stringWidth(value()) - 1)
  const dim = () =>
    !props.account.active || props.account.quotaDated || summary().stale
  const attributes = () => (dim() ? TextAttributes.DIM : TextAttributes.BOLD)
  const color = () =>
    dim() ? props.theme.textMuted : toneColor(props.theme, props.tone)
  return (
    <box
      width='100%'
      height={1}
      flexDirection='row'
      ref={(element: BoxRenderable) => {
        row = element
        setWidth(element.width || 40)
      }}
      onSizeChange={() => setWidth(row?.width || 40)}
    >
      <Show when={labelWidth() > 0}>
        <text
          width={labelWidth()}
          flexShrink={0}
          wrapMode='none'
          fg={color()}
          attributes={attributes()}
        >
          {formatQuotaRowLabel(props.account.name, labelWidth())}
        </text>
        <text width={1} flexShrink={0}>
          {' '}
        </text>
      </Show>
      <text
        width={Bun.stringWidth(value())}
        flexShrink={0}
        wrapMode='none'
        fg={color()}
        attributes={attributes()}
      >
        {value()}
      </text>
    </box>
  )
}

// Quota window row: muted label left, tone-colored bar + shared figure right,
// with an optional muted reset suffix. When pacing data is present, the bar
// gains a pace segment and an off-pace window adds a muted subline with the
// reserve/deficit delta and the projected runout.
function QuotaRow(props: {
  theme: SidebarTheme
  appearance: AppearancePrefs
  label: string
  part: QuotaWindowPart | undefined
  usedPercent: number | undefined
  pacing: QuotaPacing | null
  binding?: boolean
  now: number
}) {
  const used = () => props.usedPercent ?? 0
  const reset = () => props.part?.resetIn
  const paceLine = () => {
    const pacing = props.pacing
    if (!pacing || pacing.state === 'on-pace') return null
    const pct = Math.round(Math.abs(pacing.deltaPercent))
    if (pacing.state === 'reserve') return `reserve ${pct}% \u00b7 lasts`
    return pacing.runsOutAt
      ? `deficit ${pct}% \u00b7 out in ${formatResetIn(pacing.runsOutAt, props.now)}`
      : `deficit ${pct}% \u00b7 lasts`
  }
  return (
    <Show
      when={props.part}
      fallback={
        <box width='100%' flexDirection='row'>
          <text
            fg={props.theme.textMuted}
          >{`${formatQuotaRowLabel(props.label)} `}</text>
          <text fg={props.theme.textMuted}>{'\u2014'}</text>
        </box>
      }
    >
      {/* Left group (label · bar · figure) stays left-aligned in fixed columns so
          bars and figures line up across rows; the reset time is pushed to
          the right edge so reset times align in their own right column. */}
      <box width='100%' flexDirection='row' justifyContent='space-between'>
        <box flexDirection='row'>
          <text
            fg={props.theme.textMuted}
          >{`${formatQuotaRowLabel(props.label)} `}</text>
          {/* Index: the clock rebuilds the segments, which must not remount. */}
          <Index
            each={quotaBarSegments(used(), props.appearance, props.pacing)}
          >
            {(segment) => (
              <text fg={toneColor(props.theme, segment().tone)}>
                {segment().text}
              </text>
            )}
          </Index>
          <text
            fg={toneColor(props.theme, usageTone(used(), props.appearance))}
          >
            {` ${props.part?.figure}${props.binding ? ' •' : ''}`}
          </text>
        </box>
        <Show when={reset()}>
          <text fg={props.theme.textMuted}>{reset()}</text>
        </Show>
      </box>
      <Show when={paceLine()}>
        <box width='100%' flexDirection='row'>
          <text fg={props.theme.textMuted}>{formatQuotaRowLabel('', 11)}</text>
          <text
            fg={toneColor(
              props.theme,
              props.pacing?.state === 'deficit' ? 'warn' : 'muted',
            )}
          >
            {paceLine()}
          </text>
        </box>
      </Show>
    </Show>
  )
}

// The shared credit figure followed by the spent and limit amounts:
// `credits 75% left · $25.00/$100.00`. When that line is wider than the
// measured width, the amounts drop their cents (`$1,250/$5,000`) instead of
// wrapping onto a second line.
function creditLine(
  figure: string,
  extraUsage: AccountQuota['extraUsage'],
  width: number | undefined,
) {
  const amounts = formatCreditAmounts(extraUsage)
  if (!amounts) return figure
  const line = `${figure} · ${amounts}`
  if (width === undefined || Bun.stringWidth(line) <= width) return line
  return `${figure} · ${formatCreditAmounts(extraUsage, { wholeUnits: true })}`
}

// Account block: header row (name + status word) then per-window quota rows.
// Pacing is computed here — per window, against the wall clock at render time
// (re-evaluated on every state poll) — and disabled by passing false.
export function AccountBlock(props: {
  theme: SidebarTheme
  appearance: AppearancePrefs
  name: string
  quota: AccountQuota | null
  active: boolean
  pacingEnabled: boolean
  needsReauth?: boolean
  vaultReauth?: boolean
  stateLine?: string
  quotaDated?: boolean
  tierLabel?: string
  marginTop?: number
  now: number
}) {
  const statusWord = () =>
    props.quotaDated && props.quota
      ? 'dated'
      : props.needsReauth
        ? 're-login'
        : props.vaultReauth
          ? 'needs sign-in in the vault'
          : props.active
            ? 'active'
            : 'idle'
  const statusTone = (): Tone =>
    props.needsReauth || props.vaultReauth || props.stateLine
      ? 'warn'
      : props.active
        ? 'ok'
        : 'muted'
  const pacingFor = (
    window:
      | { usedPercent: number; remainingPercent: number; resetsAt?: string }
      | undefined,
    windowMs: number,
  ) =>
    props.pacingEnabled && !props.quotaDated && window
      ? computeQuotaPacing(window, windowMs, props.now)
      : null
  const parts = () =>
    quotaWindowParts(quotaDisplayProjection(props.quota, props.now), {
      now: props.now,
    })
  const partFor = (name: string) =>
    parts().windows.find((part) => part.name === name)
  return (
    <box width='100%' flexDirection='column' marginTop={props.marginTop ?? 0}>
      <box width='100%' flexDirection='row' justifyContent='space-between'>
        <text fg={props.theme.text}>
          <b>{`${props.name}${props.tierLabel ? ` · ${props.tierLabel}` : ''}`}</b>
        </text>
        <text fg={toneColor(props.theme, statusTone())}>
          <b>{statusWord()}</b>
        </text>
      </box>
      <Show when={props.stateLine}>
        <text fg={props.theme.textMuted}>{props.stateLine}</text>
      </Show>
      <Show
        when={props.quota}
        fallback={<text fg={props.theme.textMuted}>{'checking\u2026'}</text>}
      >
        <QuotaRow
          theme={props.theme}
          appearance={props.appearance}
          label='5h'
          part={partFor('5h')}
          usedPercent={props.quota?.five_hour?.usedPercent}
          pacing={pacingFor(props.quota?.five_hour, FIVE_HOUR_MS)}
          binding={props.quota?.bindingWindow === 'five_hour'}
          now={props.now}
        />
        <QuotaRow
          theme={props.theme}
          appearance={props.appearance}
          label='7d'
          part={partFor('7d')}
          usedPercent={props.quota?.seven_day?.usedPercent}
          pacing={pacingFor(props.quota?.seven_day, SEVEN_DAY_MS)}
          binding={props.quota?.bindingWindow === 'seven_day'}
          now={props.now}
        />
        <For each={props.quota?.scoped ?? []}>
          {(window) => (
            <QuotaRow
              theme={props.theme}
              appearance={props.appearance}
              label={partFor(window.title)?.name ?? window.title}
              part={partFor(window.title)}
              usedPercent={window.usedPercent}
              pacing={pacingFor(window, SEVEN_DAY_MS)}
              binding={props.quota?.bindingWindow === window.id}
              now={props.now}
            />
          )}
        </For>
        <Show when={partFor('credits')}>
          {(budget: () => QuotaWindowPart) => {
            // The line box's laid-out width, read when it mounts and on each
            // resize. It is undefined (amounts keep their cents) until layout.
            const [width, setWidth] = createSignal<number>()
            let line: BoxRenderable | undefined
            return (
              <box
                width='100%'
                ref={(element: BoxRenderable) => {
                  line = element
                  setWidth(element.width || undefined)
                }}
                onSizeChange={() => setWidth(line?.width || undefined)}
              >
                <text
                  fg={toneColor(
                    props.theme,
                    props.quota?.extraUsage?.severity === 'critical'
                      ? 'err'
                      : props.quota?.extraUsage?.severity === 'warning' ||
                          props.quota?.extraUsage?.exhausted
                        ? 'warn'
                        : 'muted',
                  )}
                >
                  {creditLine(
                    budget().figure,
                    props.quota?.extraUsage,
                    width(),
                  )}
                </text>
              </box>
            )
          }}
        </Show>
        <Show when={parts().age}>
          <text fg={props.theme.textMuted}>{parts().age}</text>
        </Show>
        <Show when={props.quota?.fallbackAdvised === true}>
          <text fg={props.theme.textMuted}>{'→ fallback advised'}</text>
        </Show>
      </Show>
    </box>
  )
}

export interface SidebarController {
  prefs: () => AnthropicAuthTuiPrefs
  collapsed: () => boolean
  toggleCollapsed: () => void
  /** Stops the preference watcher; OpenCode 1 keeps it for the process. */
  dispose: () => void
}

// The TUI may unmount and remount sidebar_content when the user switches
// views (e.g. main -> subagent -> main). A remount re-runs the component
// body, so any signal created inside the component would reset to its
// seed. The controller lives in the plugin closure (process lifetime)
// and owns the durable prefs/collapse signals plus the single shared
// watcher subscription, so collapse and live pref reloads survive the
// remount. No effects or memos here — those need a Solid owner, so the
// poll-interval createEffect stays inside the component.
export function createSidebarController(
  initialPrefs: AnthropicAuthTuiPrefs,
): SidebarController {
  const [prefs, setPrefs] = createSignal<AnthropicAuthTuiPrefs>(initialPrefs)
  const seedCollapsed =
    initialPrefs.rememberCollapsed && initialPrefs.collapsed != null
      ? initialPrefs.collapsed
      : initialPrefs.startCollapsed
  const [collapsed, setCollapsed] = createSignal(seedCollapsed)
  let lastPersistedCollapsed: boolean | null = initialPrefs.collapsed
  let lastApplied = JSON.stringify(initialPrefs)

  // OpenCode 1 keeps the watcher for the process lifetime; OpenCode 2 calls
  // dispose when the plugin unloads. Collapse guard mirrors the race-fix in toggleCollapsed:
  // lastPersistedCollapsed is advanced only once our own write lands, so
  // watcher echoes of the previous persisted value are rejected by the
  // `!==` check and cannot revert a user click.
  const dispose = watchTuiPreferences(() => {
    void (async () => {
      const next = resolveAnthropicAuthPrefs(await readTuiPreferencesFile())
      const serialized = JSON.stringify(next)
      if (serialized === lastApplied) return
      lastApplied = serialized
      setPrefs(next)
      if (
        next.rememberCollapsed &&
        next.collapsed != null &&
        next.collapsed !== lastPersistedCollapsed
      ) {
        lastPersistedCollapsed = next.collapsed
        setCollapsed(next.collapsed)
      }
    })()
  })

  function toggleCollapsed() {
    const next = !collapsed()
    setCollapsed(next)
    if (prefs().rememberCollapsed) {
      void queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], next).then(
        () => {
          lastPersistedCollapsed = next
        },
      )
    }
  }

  return { prefs, collapsed, toggleCollapsed, dispose }
}

/** The sidebar panel for one session; the host owns polling and the theme. */
export function ClaudeSidebar(props: {
  state: () => SidebarState
  theme: () => SidebarTheme
  controller: SidebarController
  sessionId: string
}) {
  const prefs = props.controller.prefs
  const collapsed = props.controller.collapsed
  const state = props.state
  const theme = props.theme
  // Countdowns, reading ages and pacing read this clock, so they advance on
  // each tick and state change without a new answer or rebuilt rows.
  const [tick, setTick] = createSignal(0)
  createEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), prefs().pollMs)
    onCleanup(() => clearInterval(timer))
  })
  const now = createMemo(() => {
    tick()
    state()
    return Date.now()
  })
  const enabledFallbacks = () =>
    (state().fallbacks ?? []).filter(
      (f) => f.enabled || (f.custodyState && f.custodyState !== 'off'),
    )
  const hasData = () =>
    state().main?.quota != null ||
    state().main?.stateLine != null ||
    enabledFallbacks().length > 0

  const headerLabel = () => {
    const name = prefs().header.label
    return !hasData() ? name : collapsed() ? `\u25b6 ${name}` : `\u25bc ${name}`
  }
  const activeAccount = () => resolveActiveAccount(state())
  const activeQuotaSummary = () =>
    getCollapsedQuotaSummary(activeAccount().quota, now())
  const activePacingDeficit = () => {
    if (!prefs().sections.pacing) return false
    if (activeAccount().quotaDated) return null
    const quota = activeAccount().quota
    if (!quota) return false
    const windows: Array<
      [
        (
          | { usedPercent: number; remainingPercent: number; resetsAt?: string }
          | undefined
        ),
        number,
      ]
    > = [
      [quota.five_hour, FIVE_HOUR_MS],
      [quota.seven_day, SEVEN_DAY_MS],
      ...(quota.scoped ?? []).map((window): [typeof window, number] => [
        window,
        SEVEN_DAY_MS,
      ]),
    ]
    return windows.some(
      ([w, ms]) =>
        w != null && computeQuotaPacing(w, ms, now())?.state === 'deficit',
    )
  }
  const activeQuotaTone = (): Tone => {
    const summary = activeQuotaSummary()
    const values = [
      summary.fiveHourUsedPercent,
      summary.sevenDayUsedPercent,
      ...summary.scopedUsedPercents,
    ].filter((value): value is number => value != null)
    // Pacing deficit is an advisory projection, not actual quota exhaustion,
    // so it can only BUMP the usage tone up to warn at most — never soften a
    // real warn/err usage reading and never paint a true red.
    const base: Tone =
      values.length > 0
        ? usageTone(Math.max(...values), prefs().appearance)
        : 'muted'
    if (!activePacingDeficit()) return base
    return base === 'ok' || base === 'muted' ? 'warn' : base
  }

  const quotaBackedOff = () => state().main?.quotaBackedOff === true
  const refreshBackedOff = () => state().main?.refreshBackedOff === true
  const needsReauth = () => enabledFallbacks().some((f) => f.needsReauth)
  const vaultReauth = () => enabledFallbacks().some((f) => f.vaultReauth)
  const degraded = () =>
    quotaBackedOff() || refreshBackedOff() || needsReauth() || vaultReauth()

  const fableRecoverySummary = () =>
    getFableRecoverySummary(state(), props.sessionId)
  const fableRecoveryTone = (): Tone =>
    state().fableRecoveries?.find(
      (recovery) => recovery.sessionId === props.sessionId,
    )?.mode === 'fable'
      ? 'ok'
      : 'warn'
  const cacheKeep = () => state().cacheKeep
  const showCache = () =>
    prefs().sections.cache && cacheKeep() != null && cacheKeep()?.window != null
  const prime = () => state().prime
  const showPrime = () => prime() != null
  const primeHasError = () =>
    prime()?.accounts.some((account) => account.lastResult === 'error') ?? false
  const relayValue = () => {
    const r = state().relay
    if (!r) return '\u2014'
    return `${r.transport} \u00b7 ${r.enabled ? 'on' : 'off'}`
  }

  return (
    <box
      width='100%'
      flexDirection='column'
      border={SINGLE_BORDER}
      borderColor={theme().borderActive}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Header: ▼/▶ CLAUDE badge (click to collapse) + version, or LIMITED badge */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui renders to a terminal, not the DOM — ARIA roles do not apply */}
      <box
        width='100%'
        flexDirection='row'
        justifyContent='space-between'
        alignItems='center'
        onMouseDown={() => {
          if (hasData()) props.controller.toggleCollapsed()
        }}
      >
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme().accent}>
          <text fg={theme().background}>
            <b>{headerLabel()}</b>
          </text>
        </box>
        <Show
          when={degraded()}
          fallback={
            <Show when={prefs().header.showVersion && PLUGIN_VERSION !== ''}>
              <text fg={theme().textMuted}>{`v${PLUGIN_VERSION}`}</text>
            </Show>
          }
        >
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme().warning}
          >
            <text fg={theme().background}>
              <b>{'LIMITED'}</b>
            </text>
          </box>
        </Show>
      </box>

      {/* Collapsed accounts keep placement order; only a fresh active row is emphasized. */}
      <Show when={collapsed() && hasData()}>
        {/* Index keys rows by position: each state update builds new account
            objects, so For would rebuild every row and its measured width.
            Passing the accessor's value as a prop keeps the row reactive. */}
        <Index
          each={getCollapsedAccounts(
            state(),
            prefs().sections.fallbackAccounts,
          )}
        >
          {(account) => (
            <CollapsedAccountRow
              theme={theme()}
              account={account()}
              tone={activeQuotaTone()}
              now={now()}
            />
          )}
        </Index>
        <Show when={state().fastMode}>
          <CollapsedRow theme={theme()} label='Mode'>
            <text fg={toneColor(theme(), 'accent')}>
              <b>{'fast'}</b>
            </text>
          </CollapsedRow>
        </Show>
        <Show when={fableRecoverySummary()}>
          {(summary: () => string) => (
            <CollapsedRow theme={theme()} label='Recovery'>
              <text fg={toneColor(theme(), fableRecoveryTone())}>
                <b>{summary()}</b>
              </text>
            </CollapsedRow>
          )}
        </Show>
      </Show>

      {/* Expanded: full sections. Also render when there's no data so the
          sidebar can never go blank if data clears while collapsed. */}
      <Show when={!collapsed() || !hasData()}>
        <Show
          when={hasData()}
          fallback={
            <box marginTop={1} width='100%'>
              <text fg={theme().textMuted}>{'Waiting for quota\u2026'}</text>
            </box>
          }
        >
          {/* Quota */}
          <Show when={prefs().sections.quota}>
            <SectionHeader theme={theme()} title='Quota' />
            <AccountBlock
              theme={theme()}
              appearance={prefs().appearance}
              name='main'
              quota={state().main?.quota}
              active={state().activeId === 'main'}
              pacingEnabled={prefs().sections.pacing}
              tierLabel={state().main?.tierLabel}
              stateLine={state().main?.stateLine}
              quotaDated={state().main?.quotaDated}
              now={now()}
            />
            <Show when={prefs().sections.fallbackAccounts}>
              <For each={enabledFallbacks()}>
                {(fb) => (
                  <AccountBlock
                    theme={theme()}
                    appearance={prefs().appearance}
                    name={fb.label ?? fb.id}
                    quota={fb.quota}
                    active={state().activeId === fb.id}
                    pacingEnabled={prefs().sections.pacing}
                    tierLabel={fb.tierLabel}
                    needsReauth={fb.needsReauth}
                    vaultReauth={fb.vaultReauth}
                    stateLine={fb.stateLine}
                    quotaDated={fb.quotaDated}
                    marginTop={1}
                    now={now()}
                  />
                )}
              </For>
            </Show>
          </Show>
        </Show>

        {/* Routing */}
        <Show when={prefs().sections.routing}>
          <SectionHeader theme={theme()} title='Routing' />
          <StatRow
            theme={theme()}
            label='Route'
            value={state().route}
            tone='accent'
          />
          <StatRow
            theme={theme()}
            label='Mode'
            value={state().fastMode ? 'fast' : 'std'}
            tone={state().fastMode ? 'accent' : 'muted'}
          />
          <StatRow
            theme={theme()}
            label='Relay'
            value={relayValue()}
            tone={state().relay?.enabled ? 'ok' : 'muted'}
          />
        </Show>

        <Show when={fableRecoverySummary()}>
          {(summary: () => string) => (
            <StatRow
              theme={theme()}
              label='Recovery'
              value={summary()}
              tone={fableRecoveryTone()}
            />
          )}
        </Show>

        {/* Cache */}
        <Show when={showCache()}>
          <SectionHeader theme={theme()} title='Cache' />
          <StatRow
            theme={theme()}
            label='1h cache'
            value={`${cacheKeep()?.window} \u00b7 ${cacheKeep()?.enabled ? 'on' : 'off'}`}
            tone={cacheKeep()?.enabled ? 'ok' : 'muted'}
          />
          <Show when={(cacheKeep()?.trackedSessions ?? 0) > 0}>
            <StatRow
              theme={theme()}
              label='Tracked'
              value={String(cacheKeep()?.trackedSessions)}
              tone='text'
            />
          </Show>
        </Show>

        {/* Prime — only when enabled. Expanded view only (no collapsed surface). */}
        <Show when={showPrime()}>
          <StatRow
            theme={theme()}
            label='Prime'
            value={primeHasError() ? 'err' : 'on'}
            tone={primeHasError() ? 'warn' : 'ok'}
          />
          <For each={prime()?.accounts ?? []}>
            {(account) => {
              const value = () => formatPrimeAccountValue(account, now())
              return (
                <StatRow
                  theme={theme()}
                  label={account.label}
                  value={value().text}
                  tone={value().hasError ? 'warn' : 'text'}
                />
              )
            }}
          </For>
        </Show>

        {/* Health — only when something is wrong */}
        <Show when={degraded() && prefs().sections.health}>
          <SectionHeader theme={theme()} title='Health' />
          <Show when={quotaBackedOff()}>
            <StatRow
              theme={theme()}
              label='Quota API'
              value={`backoff ${formatUntil(state().main?.quotaBackoffUntil, now())}`}
              tone='warn'
            />
          </Show>
          <Show when={refreshBackedOff()}>
            <StatRow
              theme={theme()}
              label='Token refresh'
              value={`backoff ${formatUntil(state().main?.refreshBackoffUntil, now())}`}
              tone='warn'
            />
          </Show>
        </Show>
      </Show>
    </box>
  )
}

// --- OpenCode 2 -------------------------------------------------------------

/** The OpenCode 2 theme tokens the sidebar reads (`ResolvedTheme` subset). */
export interface HostTheme {
  readonly text: {
    readonly base: SidebarColor
    readonly muted: SidebarColor
    readonly action: { readonly primary: { readonly base: SidebarColor } }
    readonly feedback: {
      readonly success: { readonly base: SidebarColor }
      readonly warning: { readonly base: SidebarColor }
      readonly error: { readonly base: SidebarColor }
    }
  }
  readonly background: { readonly base: SidebarColor }
  readonly border: { readonly base: SidebarColor }
}

/** OpenCode 2's semantic theme as the flat tokens OpenCode 1 provides. */
export function sidebarThemeFromHost(theme: HostTheme): SidebarTheme {
  return {
    text: theme.text.base,
    textMuted: theme.text.muted,
    success: theme.text.feedback.success.base,
    warning: theme.text.feedback.warning.base,
    error: theme.text.feedback.error.base,
    accent: theme.text.action.primary.base,
    background: theme.background.base,
    borderActive: theme.border.base,
  }
}

/** The OpenCode 2 TUI context members the sidebar uses. */
export interface ClaudeSidebarHost {
  readonly theme: HostTheme
  readonly ui: {
    slot(claim: {
      readonly append: 'sidebar.content'
      readonly render: (input: { readonly sessionID: string }) => JSX.Element
    }): () => void
  }
}

/** Reads one session's sidebar state from the location's server. */
export type ReadSidebarState = (
  sessionID: string,
  signal: AbortSignal,
) => Promise<SidebarState>

function HostSidebar(props: {
  host: ClaudeSidebarHost
  read: ReadSidebarState
  controller: SidebarController
  sessionId: string
}) {
  const [state, setState] = createSignal<SidebarState>(DEFAULT_SIDEBAR_STATE)
  const abort = new AbortController()
  let inFlight = false
  let shown = ''
  const refresh = async () => {
    if (inFlight || abort.signal.aborted) return
    inFlight = true
    try {
      const next = await props.read(props.sessionId, abort.signal)
      // Every answer is stamped now; redraw only when its content changed.
      // Countdowns and ages advance on the sidebar's own clock.
      const content = JSON.stringify({ ...next, lastUpdated: 0 })
      if (!abort.signal.aborted && content !== shown) {
        shown = content
        setState(next)
      }
    } catch {
      // Keep the last state; an older server without `sidebar` keeps waiting.
    } finally {
      inFlight = false
    }
  }
  createEffect(() => {
    const timer = setInterval(refresh, props.controller.prefs().pollMs)
    onCleanup(() => clearInterval(timer))
  })
  void refresh()
  onCleanup(() => abort.abort())
  return (
    <ClaudeSidebar
      state={state}
      theme={() => sidebarThemeFromHost(props.host.theme)}
      controller={props.controller}
      sessionId={props.sessionId}
    />
  )
}

/** Claims the OpenCode 2 session sidebar; the returned function releases it. */
export async function mountClaudeSidebar(
  host: ClaudeSidebarHost,
  read: ReadSidebarState,
): Promise<() => void> {
  const controller = createSidebarController(
    resolveAnthropicAuthPrefs(await readTuiPreferencesFile()),
  )
  let release: () => void
  try {
    release = host.ui.slot({
      append: 'sidebar.content',
      render: (input) => (
        <HostSidebar
          host={host}
          read={read}
          controller={controller}
          sessionId={input.sessionID}
        />
      ),
    })
  } catch (error) {
    controller.dispose()
    throw error
  }
  return () => {
    release()
    controller.dispose()
  }
}
