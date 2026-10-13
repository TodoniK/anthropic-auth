import {
  getQuotaCheckIntervalMs,
  logger,
  type NativeAccountRuntime,
  oauthProfileIsFresh,
  quotaSnapshotCheckedAt,
} from '@cortexkit/anthropic-auth-core'

/**
 * Background quota and profile reads obtain their own account credentials.
 * They must not inherit the model policy of the latest user request.
 */
export function startNativeAnthropicLifecycle(
  runtime: NativeAccountRuntime,
  fetchImpl?: typeof fetch,
) {
  const abort = new AbortController()
  let inFlight: Promise<void> | undefined
  let stopped = false
  const run = async () => {
    const snapshot = await runtime.read()
    abort.signal.throwIfAborted()
    if (
      snapshot.policyStorage.relay?.enabled === true &&
      snapshot.policyStorage.relay.transport !== 'http'
    )
      return
    const current = snapshot
    const interval = getQuotaCheckIntervalMs(current.policyStorage)
    for (const account of current.accounts) {
      if (abort.signal.aborted) return
      if (!account.enabled || account.type !== 'oauth') continue
      if (
        current.policyStorage.quota?.enabled !== false &&
        Date.now() - quotaSnapshotCheckedAt(account.quota) >= interval
      ) {
        // Each quota reading or failure is bound to the credential version
        // used for its request, so a late result cannot affect a newer login.
        await runtime
          .fetchQuota(account.id, fetchImpl, abort.signal)
          .catch(() => {})
      }
      if (!oauthProfileIsFresh(account.profile) && !abort.signal.aborted)
        await runtime
          .fetchProfile(account.id, fetchImpl, abort.signal)
          .catch(() => {})
    }
  }
  const tick = () => {
    if (stopped || inFlight) return inFlight
    inFlight = run()
      .catch(() => {
        if (!abort.signal.aborted)
          logger.debug(
            'opencode2',
            'native background readings did not complete',
          )
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }
  const watch = runtime.vault.watch({
    intervalMs: 60_000,
    onRefresh: tick,
    shouldRefresh: async () => {
      const snapshot = await runtime.read()
      return (
        snapshot.policyStorage.relay?.enabled !== true ||
        snapshot.policyStorage.relay.transport === 'http'
      )
    },
  })
  void watch.ready.catch(() => {})
  return {
    async dispose() {
      stopped = true
      watch.close()
      abort.abort()
      await inFlight
    },
  }
}
