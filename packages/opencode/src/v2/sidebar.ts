import {
  buildPrimeAccountStatuses,
  effectiveRelayStatus,
  formatNativeAccountState,
  formatOAuthAccountTier,
  getCacheKeepWindow,
  getRoutingMode,
  isCacheKeepAlways,
  isCacheKeepHybridActive,
  isPermanentRefreshError,
  isPrimePersistentlyEnabled,
  type NativeAccountSnapshot,
  type NativeAccountView,
  nativeAccountCanServe,
  refreshBackoffActive,
} from '@cortexkit/anthropic-auth-core'
import type { SidebarAccountState, SidebarState } from '../sidebar-state'

export interface NativeSidebarExtras {
  /** The account that served the requested session, if any. */
  readonly activeId: string | undefined
  readonly trackedSessions: number
  readonly now: number
}

// Why an account cannot serve, shown in place of its quota; undefined when it can.
const stateLineOf = (account: NativeAccountView) =>
  nativeAccountCanServe(account)
    ? undefined
    : formatNativeAccountState(account) || undefined

const retryPending = (retryAt: number | undefined, now: number) =>
  typeof retryAt === 'number' && retryAt > now

/**
 * The OpenCode 1 sidebar state, projected from the native account snapshot.
 * The snapshot carries no tokens, keys or receipts, and neither does this.
 */
export function buildNativeSidebarState(
  snapshot: NativeAccountSnapshot,
  extras: NativeSidebarExtras,
): SidebarState {
  const { now } = extras
  const storage = snapshot.policyStorage
  const oauth = snapshot.accounts.filter((account) => account.type === 'oauth')
  const main = oauth.find((account) => account.id === 'main')
  const mainStateLine = main ? stateLineOf(main) : undefined
  const quotaRetryAt = main?.lastQuotaRefreshError?.nextRetryAt
  const refreshError = main?.lastRefreshError
  const window = getCacheKeepWindow(storage)
  return {
    main: {
      quota: main?.quota ?? null,
      enabled: main?.enabled,
      tierLabel: formatOAuthAccountTier(main?.profile),
      quotaBackedOff: retryPending(quotaRetryAt, now),
      quotaBackoffUntil: quotaRetryAt,
      refreshBackedOff: refreshBackoffActive(
        refreshError,
        undefined,
        now,
        undefined,
      ),
      refreshBackoffUntil: refreshError?.nextRetryAt,
      stateLine: mainStateLine,
      quotaDated: Boolean(mainStateLine),
    },
    fallbacks: oauth
      .filter((account) => account.id !== 'main' && account.enabled)
      .map((account): SidebarAccountState => {
        const stateLine = stateLineOf(account)
        const vault = account.source === 'vault'
        return {
          id: account.id,
          label: account.label,
          quota: account.quota ?? null,
          enabled: account.enabled,
          tierLabel: formatOAuthAccountTier(account.profile),
          // Only a permanently dead refresh token whose backoff still runs
          // needs a new sign-in; transient failures recover on their own.
          needsReauth:
            isPermanentRefreshError(account.lastRefreshError) &&
            refreshBackoffActive(
              account.lastRefreshError,
              undefined,
              now,
              undefined,
            ),
          ...(vault && account.state === 'needs_reauth'
            ? { vaultReauth: true }
            : {}),
          ...(vault && account.state === 'active' ? { vaultServed: true } : {}),
          stateLine,
          quotaDated: Boolean(stateLine),
        }
      }),
    activeId: extras.activeId,
    route: getRoutingMode(storage),
    relay: effectiveRelayStatus(storage.relay),
    fastMode: storage.claudeFast?.enabled === true,
    cacheKeep: {
      enabled: isCacheKeepHybridActive(storage),
      window: isCacheKeepAlways(storage)
        ? 'always'
        : window
          ? `${window.startHour}-${window.endHour}`
          : undefined,
      trackedSessions: extras.trackedSessions,
    },
    prime: isPrimePersistentlyEnabled(storage)
      ? { enabled: true, accounts: buildPrimeAccountStatuses(storage, { now }) }
      : undefined,
    lastUpdated: now,
  }
}
