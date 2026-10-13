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

/** A missing roster may be discovery still in progress, not an empty pool. */
export async function readNativeAccountsForRequest(
  runtime: NativeAccountRuntime,
  signal?: AbortSignal,
): Promise<NativeAccountSnapshot> {
  signal?.throwIfAborted()
  const snapshot = await runtime.read()
  if (snapshot.mode !== 'claustrum') return snapshot
  const ready = Boolean((await runtime.vault.read())?.view)

  // Wait at most two seconds for the vault to publish its account inventory.
  // Concurrent requests share discovery: cancelling this request only ends
  // its wait, while runtime.close() cancels discovery for all callers.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), 2000)
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal
  try {
    while (!combined.aborted) {
      try {
        const roster = await runtime.vault.refresh(combined)
        if (roster?.view) return await runtime.read()
      } catch {
        signal?.throwIfAborted()
        if (ready) return await runtime.read()
      }
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
    signal?.throwIfAborted()
    if (ready) return await runtime.read()
    throw new NativeVaultNoAccountError()
  } finally {
    clearTimeout(timer)
  }
}
