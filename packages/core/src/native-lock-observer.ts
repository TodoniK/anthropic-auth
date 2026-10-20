import { AsyncLocalStorage } from 'node:async_hooks'
import { withLock } from '@cortexkit/common-auth/fs'

const detachedLocks = new AsyncLocalStorage<boolean>()

/** Mark work as background-origin without changing how it acquires or releases locks. */
export function withDetachedNativeLocks<T>(work: () => Promise<T>): Promise<T> {
  return detachedLocks.run(true, work)
}

/** Diagnostic evidence, not an ownership assertion or a control hook. */
export type NativeLockEvent = {
  type: 'acquiring' | 'acquired' | 'released' | 'contended'
  /** Marks background-origin work; callers may still await the same shared refresh. */
  detached?: boolean
  name: string
  path: string
}

/**
 * Diagnostics cannot decide whether a lock owner refreshes or saves a token.
 * Consume returned rejections without awaiting: an observer may never settle.
 * With no observer, leave the producer callback absent and allocate no wrapper.
 */
export function nativeLockObserver(
  observer: ((event: NativeLockEvent) => void) | undefined,
): ((event: NativeLockEvent) => void) | undefined {
  if (!observer) return undefined
  return (event) => {
    try {
      const result: unknown = observer(
        detachedLocks.getStore() ? { ...event, detached: true } : event,
      )
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        void Promise.resolve(result).catch(() => {})
      }
    } catch {
      // Includes callback throws and throwing thenable accessors. Ownership and
      // awaited lock-step errors still propagate through their separate paths.
    }
  }
}

/** Observe the real lease without changing acquisition, ownership or release. */
export async function withNativeLock<T>(
  path: string,
  options: Parameters<typeof withLock>[1] & {
    onLockEvent?: (event: NativeLockEvent) => void
  },
  run: (lease: { assertOwned(): Promise<void> }) => Promise<T>,
  acquire: typeof withLock = withLock,
): Promise<T> {
  const observer = nativeLockObserver(options.onLockEvent)
  if (!observer) return acquire(path, options, run)
  observer({ type: 'acquiring', name: options.name, path })
  let acquired = false
  try {
    return await acquire(path, options, async (lease) => {
      acquired = true
      observer({ type: 'acquired', name: options.name, path })
      return run(lease)
    })
  } finally {
    if (acquired) observer({ type: 'released', name: options.name, path })
  }
}

/** Resolve the supplied acquisition function for each operation. */
export function observeNativeLocks(
  acquire: () => typeof withLock,
  observer?: (event: NativeLockEvent) => void,
) {
  return <T>(
    path: string,
    options: Parameters<typeof withNativeLock>[1],
    run: (lease: { assertOwned(): Promise<void> }) => Promise<T>,
  ) =>
    withNativeLock(
      path,
      { ...options, onLockEvent: options.onLockEvent ?? observer },
      run,
      acquire(),
    )
}
