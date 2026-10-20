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
  OAuthExtraUsageSnapshot,
  OAuthQuotaSnapshot,
  QuotaMoney,
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

export type QuotaMoneyFormat = {
  /** Leave out the fractional digits, cutting the amount down to whole units. */
  wholeUnits?: boolean
}

/**
 * A stored money amount in its own currency, such as `$25.00` or `€1,250.00`.
 * An amount whose currency the runtime cannot format reads as its raw minor
 * units and currency code.
 */
export function formatQuotaMoney(
  money: QuotaMoney,
  options: QuotaMoneyFormat = {},
) {
  const digits = options.wholeUnits ? 0 : money.exponent
  const major = money.amountMinor / 10 ** money.exponent
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: money.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(options.wholeUnits ? Math.trunc(major) : major)
  } catch {
    return `${money.amountMinor} ${money.currency}`
  }
}

// The same bounds the usage reader applies when it stores an amount, so a
// damaged or hand-edited file cannot print a nonsense amount.
function isQuotaMoney(value: unknown): value is QuotaMoney {
  if (!value || typeof value !== 'object') return false
  const money = value as Partial<QuotaMoney>
  return (
    typeof money.amountMinor === 'number' &&
    Number.isFinite(money.amountMinor) &&
    typeof money.currency === 'string' &&
    /^[A-Za-z]{3}$/.test(money.currency) &&
    typeof money.exponent === 'number' &&
    Number.isInteger(money.exponent) &&
    money.exponent >= 0 &&
    money.exponent <= 20
  )
}

/**
 * The credit amounts shown after the shared credit figure: `$25.00/$100.00`
 * (spent / monthly limit). Undefined when the limit is zero or either amount
 * is missing or malformed, so the figure is then shown on its own.
 */
export function formatCreditAmounts(
  extraUsage: Partial<OAuthExtraUsageSnapshot> | null | undefined,
  options: QuotaMoneyFormat = {},
) {
  const used = extraUsage?.used
  const limit = extraUsage?.limit
  if (!isQuotaMoney(used) || !isQuotaMoney(limit) || limit.amountMinor <= 0)
    return undefined
  return `${formatQuotaMoney(used, options)}/${formatQuotaMoney(limit, options)}`
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
    // The budget part keeps common-auth's wording (`credits 75% left`); the
    // spent and limit amounts are appended after it.
    const amounts = formatCreditAmounts(account.quota?.extraUsage)
    for (const [index, part] of parts.entries()) {
      const binding =
        bindingName !== undefined && windows[index]?.name === bindingName
      const credits =
        amounts && windows[index]?.kind === 'budget' ? ` · ${amounts}` : ''
      lines.push(`  - ${part}${credits}${binding ? ' •' : ''}`)
    }
    if (!parts.length) lines.push(`  - ${formatQuota(quota, { now })}`)
    if (account.quota?.fallbackAdvised === true) {
      lines.push('  - → fallback advised')
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}
