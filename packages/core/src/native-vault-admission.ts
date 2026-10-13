import type { NativeAccountRuntime } from './native-account-runtime.ts'
import type { NativeAccountSnapshot } from './native-account-view.ts'

export const NATIVE_VAULT_NO_ACCOUNT_MESSAGE =
  'No vault account can serve this request. Open /claude to see which account needs signing in again.'

export class NativeVaultNoAccountError extends Error {
  constructor() {
    super(NATIVE_VAULT_NO_ACCOUNT_MESSAGE)
    this.name = 'NativeVaultNoAccountError'
  }
}

const refreshing = new WeakMap<
  NativeAccountRuntime,
  Promise<NativeAccountSnapshot>
>()

function hasActiveVaultAccount(snapshot: NativeAccountSnapshot): boolean {
  return snapshot.accounts.some(
    (account) =>
      account.source === 'vault' &&
      account.type === 'oauth' &&
      account.enabled &&
      account.state === 'active',
  )
}

/** A missing roster may be discovery still in progress, not an empty pool. */
export async function readNativeAccountsForRequest(
  runtime: NativeAccountRuntime,
  signal?: AbortSignal,
): Promise<NativeAccountSnapshot> {
  signal?.throwIfAborted()
  const snapshot = await runtime.read()
  signal?.throwIfAborted()
  if (snapshot.mode !== 'claustrum') return snapshot
  const ready = Boolean((await runtime.vault.read())?.view)
  signal?.throwIfAborted()
  // A usable published roster is sufficient for routing. Its background watch
  // owns discovery; model requests must not contend on the roster write lock.
  if (ready && hasActiveVaultAccount(snapshot)) return snapshot

  let pending = refreshing.get(runtime)
  if (!pending) {
    pending = refreshForRequest(runtime, ready).finally(() =>
      refreshing.delete(runtime),
    )
    refreshing.set(runtime, pending)
  }
  return waitForRequest(pending, signal)
}

async function refreshForRequest(
  runtime: NativeAccountRuntime,
  ready: boolean,
): Promise<NativeAccountSnapshot> {
  // Wait at most two seconds for the vault to publish its account inventory.
  // Concurrent requests share discovery: cancelling this request only ends
  // its wait, while runtime.close() cancels discovery for all callers.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), 2000)
  const combined = deadline.signal
  try {
    while (!combined.aborted) {
      let roster: Awaited<ReturnType<NativeAccountRuntime['vault']['refresh']>>
      try {
        roster = await runtime.vault.refresh(combined)
      } catch {
        if (ready || combined.aborted) break
      }
      if (roster?.view) {
        const snapshot = await runtime.read()
        if (snapshot.mode !== 'claustrum' || hasActiveVaultAccount(snapshot))
          return snapshot
        throw new NativeVaultNoAccountError()
      }
      if (ready) break
      if (combined.aborted) break
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(pause)
          combined.removeEventListener('abort', finish)
          resolve()
        }
        const pause = setTimeout(finish, 25)
        combined.addEventListener('abort', finish, { once: true })
        if (combined.aborted) finish()
      })
    }
    throw new NativeVaultNoAccountError()
  } finally {
    clearTimeout(timer)
  }
}

function waitForRequest<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}
