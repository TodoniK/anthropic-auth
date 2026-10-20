import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import { POOL_LOCK_DEFAULTS } from '@cortexkit/common-auth/store'

/** Hold a native-relay writer lease beyond the pool-lock wait budget to exercise requests while it remains held. */
export async function holdNativeRelayLock(
  path: string,
  owner: { deferCleanup(cleanup: () => void | Promise<void>): void },
) {
  const lease = await acquireRefreshFileLock({
    path,
    name: 'native-relay',
    ttlMs: 60_000,
    renew: true,
  })
  if (!lease) throw new Error('Relay fixture could not acquire writer lease')
  let finish!: () => void
  const pastTimeout = new Promise<void>((resolve) => {
    finish = resolve
  })
  const timer = setTimeout(finish, POOL_LOCK_DEFAULTS.timeoutMs + 100)
  owner.deferCleanup(async () => {
    clearTimeout(timer)
    finish()
    await lease.release()
  })
  return {
    pastTimeout,
    assertOwned: () => lease.assertOwned(),
    release: () => lease.release(),
  }
}
