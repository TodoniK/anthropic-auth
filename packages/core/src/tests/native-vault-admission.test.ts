import { expect, test } from 'bun:test'
import type { NativeAccountRuntime } from '../native-account-runtime.ts'
import type { NativeAccountSnapshot } from '../native-account-view.ts'
import { readNativeAccountsForRequest } from '../native-vault-admission.ts'

test('vault admission refuses enabled needs-sign-in inventory until an active account exists', async () => {
  const snapshot: NativeAccountSnapshot = {
    mode: 'claustrum',
    settings: {},
    policyStorage: { version: 1, accounts: [] },
    accounts: [
      {
        id: 'needs-sign-in',
        type: 'oauth',
        source: 'vault',
        enabled: true,
        state: 'needs_reauth',
        credentialId: 'oauth:needs-sign-in',
      },
    ],
  }
  let refreshes = 0
  const roster = { view: 'ready' }
  const runtime = {
    read: async () => snapshot,
    vault: {
      read: async () => roster,
      refresh: async () => {
        refreshes++
        return roster
      },
    },
  } as unknown as NativeAccountRuntime
  await expect(readNativeAccountsForRequest(runtime)).rejects.toMatchObject({
    name: 'NativeVaultNoAccountError',
  })
  expect(refreshes).toBe(1)
  expect(snapshot.accounts[0]?.enabled).toBe(true)
  snapshot.accounts.push({
    id: 'healthy',
    type: 'oauth',
    source: 'vault',
    enabled: true,
    state: 'active',
    credentialId: 'oauth:healthy',
  })
  expect(await readNativeAccountsForRequest(runtime)).toBe(snapshot)
  expect(refreshes).toBe(1)
})
