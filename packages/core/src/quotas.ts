import {
  ALL_SCOPE,
  formatQuota,
  isQuotaStale,
  type ProjectedLimit,
  type ProjectedQuota,
  quotaTextParts,
  quotaWindowParts,
} from '@cortexkit/common-auth/quota'
import type {
  AccountQuotaWindow,
  AccountScopedQuotaWindow,
  AccountStorage,
  OAuthAccount,
  OAuthQuotaSnapshot,
} from './accounts.ts'
import { isOAuthAccount } from './accounts.ts'
import { formatOAuthAccountTier } from './oauth-profile.ts'

export const CLAUDE_QUOTAS_COMMAND_NAME = 'claude-quota'

export type { QuotaWindowPart } from '@cortexkit/common-auth/quota'
export { formatQuota, isQuotaStale, quotaTextParts, quotaWindowParts }

type DisplayWindow = Omit<AccountQuotaWindow, 'checkedAt'> & {
  checkedAt?: number
}

/** Sidebar files written by older versions may not retain reading times. */
export type QuotaDisplaySnapshot = Pick<
  OAuthQuotaSnapshot,
  'checkedAt' | 'extraUsage' | 'bindingWindow'
> & {
  five_hour?: DisplayWindow
  seven_day?: DisplayWindow
  scoped?: (Omit<AccountScopedQuotaWindow, 'checkedAt'> & DisplayWindow)[]
}

/** Adapt every reported window without projecting away other model families. */
export function quotaDisplayProjection(
  snapshot: QuotaDisplaySnapshot | null | undefined,
  now: number,
): ProjectedQuota | undefined {
  if (!snapshot) return undefined
  const limits: ProjectedLimit[] = []
  const add = (
    window: DisplayWindow | undefined,
    scope: string,
    label: string,
    windowMinutes: number,
  ) => {
    if (!window) return
    limits.push({
      scope,
      label,
      kind: 'reading',
      windowMinutes,
      usedPercent: window.usedPercent,
      remainingPercent: window.remainingPercent,
      resetsAt: window.resetsAt,
      // Without either reading timestamp, a legacy sidebar cannot establish an age.
      checkedAt: window.checkedAt ?? snapshot.checkedAt ?? now,
    })
  }
  add(snapshot.five_hour, ALL_SCOPE, 'five_hour', 300)
  add(snapshot.seven_day, ALL_SCOPE, 'seven_day', 10080)
  for (const window of snapshot.scoped ?? []) {
    add(window, window.modelId ?? window.modelName, window.title, 10080)
  }
  const checkedAt =
    snapshot.checkedAt ??
    (limits.length ? Math.min(...limits.map((limit) => limit.checkedAt)) : now)
  const extra = snapshot.extraUsage
  return {
    scope: ALL_SCOPE,
    limits,
    checkedAt,
    ...(extra && {
      budget: {
        checkedAt,
        reached: extra.exhausted,
        // Older snapshots have monetary totals but no utilization percentage.
        // Subtract the integer minor units before dividing: `1 - used / limit`
        // lands a few floating-point bits off (7800 of 10000 gives
        // 21.999999999999996), which makes the narrow form pick the budget
        // over a model window that reads the same 22%.
        remainingPercent:
          extra.utilizationPercent !== undefined
            ? 100 - extra.utilizationPercent
            : extra.limit.amountMinor > 0
              ? ((extra.limit.amountMinor - extra.used.amountMinor) * 100) /
                extra.limit.amountMinor
              : undefined,
      },
    }),
  }
}

function quotaBindingName(snapshot: QuotaDisplaySnapshot | null | undefined) {
  const binding = snapshot?.bindingWindow
  if (binding === 'five_hour') return '5h'
  if (binding === 'seven_day') return '7d'
  return snapshot?.scoped?.find((window) => window.id === binding)?.title
}

export type QuotaAccountSummary = {
  name: string
  role: 'main' | 'fallback'
  enabled?: boolean
  quota?: OAuthQuotaSnapshot
  lastRefreshedAt?: number
  error?: string
  tierLabel?: string
}

function formatAge(checkedAt: number, now: number) {
  const elapsedMs = Math.max(0, now - checkedAt)
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1m ago'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (remainder === 0) return `${hours}h ago`
  return `${hours}h ${remainder}m ago`
}

function accountName(account: OAuthAccount) {
  return account.label?.trim() || account.id
}

function accountStoredError(account: OAuthAccount) {
  return (
    account.lastQuotaRefreshError?.message ?? account.lastRefreshError?.message
  )
}

export function buildFallbackQuotaSummaries(
  storage: AccountStorage | null,
  errors: ReadonlyMap<string, string> = new Map(),
) {
  if (!storage?.accounts.length) return []
  return storage.accounts.filter(isOAuthAccount).map((account) => {
    const error = errors.get(account.id) ?? accountStoredError(account)
    return {
      name: accountName(account),
      role: 'fallback' as const,
      enabled: account.enabled !== false,
      quota: account.quota,
      ...(formatOAuthAccountTier(account.profile) && {
        tierLabel: formatOAuthAccountTier(account.profile),
      }),
      lastRefreshedAt: account.lastRefreshedAt,
      ...(error && { error }),
    }
  })
}

export function buildClaudeQuotaSummary(input: {
  accounts: QuotaAccountSummary[]
  refreshedAt?: number
  now?: number
}) {
  const now = input.now ?? Date.now()
  const lines = ['## Claude Quotas', '']

  if (input.refreshedAt) {
    lines.push(`Refreshed: ${formatAge(input.refreshedAt, now)}`, '')
  }

  if (!input.accounts.length) {
    lines.push('No Claude OAuth accounts found yet.')
    return lines.join('\n')
  }

  for (const account of input.accounts) {
    const role = account.role === 'main' ? 'main' : 'fallback'
    const disabled = account.enabled === false ? ' disabled' : ''
    lines.push(`### ${account.name} (${role}${disabled})`)
    if (account.tierLabel) lines.push(`  - Tier: ${account.tierLabel}`)
    if (account.lastRefreshedAt) {
      lines.push(
        `  - Last token refresh: ${formatAge(account.lastRefreshedAt, now)}`,
      )
    }
    if (account.error) {
      lines.push(`  - Error: ${account.error}`)
    }
    const quota = quotaDisplayProjection(account.quota, now)
    const parts = quotaTextParts(quota, { now })
    const windows = quotaWindowParts(quota, { now }).windows
    const bindingName = quotaBindingName(account.quota)
    for (const [index, part] of parts.entries()) {
      const binding =
        bindingName !== undefined && windows[index]?.name === bindingName
      lines.push(`  - ${part}${binding ? ' •' : ''}`)
    }
    if (!parts.length) lines.push(`  - ${formatQuota(quota, { now })}`)
    if (account.quota?.fallbackAdvised === true) {
      lines.push('  - → fallback advised')
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}
