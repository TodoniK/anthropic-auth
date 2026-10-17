import { expect, test } from 'bun:test'

import { getPersistedMainQuota } from '../accounts.ts'
import { QuotaManager } from '../quota-manager.ts'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

const quotaResponse = {
  five_hour: { utilization: 4 },
  seven_day: { utilization: 13 },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
  spend: null,
}

test('a completed older main request does not clear a newer in-flight refresh', async () => {
  const firstStarted = deferred()
  const releaseFirst = deferred()
  const secondStarted = deferred()
  const releaseSecond = deferred()
  let fetches = 0
  const manager = new QuotaManager({
    storage: null,
    fetchImpl: (async () => {
      fetches += 1
      if (fetches === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
      } else if (fetches === 2) {
        secondStarted.resolve()
        await releaseSecond.promise
      }
      return Response.json(quotaResponse)
    }) as unknown as typeof fetch,
  })

  const first = manager.refreshMainWithMetadata('main', 'token-a')
  await firstStarted.promise
  const second = manager.refreshMainWithMetadata('main', 'token-b')
  releaseFirst.resolve()
  await secondStarted.promise
  const joinedSecond = manager.refreshMainWithMetadata('main', 'token-b')
  releaseSecond.resolve()

  await Promise.all([first, second, joinedSecond])

  expect(fetches).toBe(2)
})

test('persisted main quota derives ordering only from the account-bound snapshot', () => {
  const persisted = getPersistedMainQuota({
    version: 1,
    accounts: [],
    quota: {
      mainQuota: {
        accountIdentity: 'account-a',
        checkedAt: 100,
        five_hour: {
          usedPercent: 80,
          remainingPercent: 20,
          checkedAt: 100,
        },
      },
      mainQuotaCheckedAt: 900,
    },
  })

  expect(persisted?.accountIdentity).toBe('account-a')
  expect(persisted?.checkedAt).toBe(100)
})

test('an unbound future timestamp cannot replace a newer in-memory main snapshot', () => {
  const manager = new QuotaManager({ storage: null, now: () => 1_000 })
  manager.setMain('account-a', {
    quota: {
      accountIdentity: 'account-a',
      checkedAt: 200,
      five_hour: {
        usedPercent: 20,
        remainingPercent: 80,
        checkedAt: 200,
      },
    },
    checkedAt: 200,
    refreshAfter: 500,
  })

  manager.seedMainFromStorage(
    {
      version: 1,
      accounts: [],
      mainAccountId: 'account-a',
      quota: {
        mainQuota: {
          accountIdentity: 'account-a',
          checkedAt: 100,
          five_hour: {
            usedPercent: 80,
            remainingPercent: 20,
            checkedAt: 100,
          },
        },
        mainQuotaCheckedAt: 900,
      },
    },
    'account-a',
  )

  expect(manager.getMain('account-a')).toMatchObject({
    checkedAt: 200,
    quota: { five_hour: { usedPercent: 20 } },
  })
})

test('custody quota transport authorizes only actual fetches and supports secret-free routes', async () => {
  const calls: Array<{
    kind: string
    accountId: string | undefined
    accessToken: string
  }> = []
  let directFetches = 0
  let now = Date.now()
  const manager = new QuotaManager({
    storage: null,
    now: () => now,
    fetchImpl: (async () => {
      directFetches += 1
      throw new Error('local transport must not run')
    }) as unknown as typeof fetch,
    fetchQuotaSnapshot: async (request) => {
      calls.push(request)
      return {
        checkedAt: now,
        five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt: now },
      }
    },
  })
  const main = await manager.refreshMainWithMetadata('scoped-main', '')
  expect(main.fetched).toBe(true)
  now += 2_000
  const fallback = await manager.refreshFallbackWithMetadata(
    'scoped-fallback',
    '',
    undefined,
  )
  expect(fallback.fetched).toBe(true)
  expect(calls).toEqual([
    { kind: 'main', accountId: 'scoped-main', accessToken: '' },
    { kind: 'fallback', accountId: 'scoped-fallback', accessToken: '' },
  ])
  expect(directFetches).toBe(0)
})

test('custody quota authorization refusal never falls back to the supplied local token', async () => {
  let directFetches = 0
  const manager = new QuotaManager({
    storage: null,
    fetchImpl: (async () => {
      directFetches += 1
      return Response.json(quotaResponse)
    }) as unknown as typeof fetch,
    fetchQuotaSnapshot: async () => {
      throw new Error('custody authorization revoked')
    },
  })
  await expect(
    manager.refreshMainWithMetadata('scoped-main', 'must-not-use-local-token'),
  ).rejects.toThrow('custody authorization revoked')
  expect(directFetches).toBe(0)
  expect(manager.getMain('scoped-main')).toBeNull()
})

test('an absent local fallback token is rejected before HTTP dispatch', async () => {
  let fetches = 0
  const manager = new QuotaManager({
    storage: null,
    fetchImpl: Object.assign(
      async () => {
        fetches++
        return Response.json(quotaResponse)
      },
      { preconnect: fetch.preconnect },
    ),
  })
  await expect(
    manager.refreshFallback('missing-token-account', '', undefined),
  ).rejects.toThrow('access token is unavailable')
  expect(fetches).toBe(0)
})

test('fallback quota poller skips enabled vault accounts needing sign-in before resolving credentials', async () => {
  const resolved: string[] = []
  const polled: Array<string | undefined> = []
  const manager = new QuotaManager({
    storage: null,
    now: () => 1000,
    fetchQuotaSnapshot: async ({ accountId }) => {
      polled.push(accountId)
      return { checkedAt: 1000 }
    },
  })
  const accounts = ['needs_reauth', 'active'].map((state) => ({
    id: state,
    type: 'oauth' as const,
    refresh: '',
    enabled: true,
    claustrumScopedCredentialId: `oauth:${state}`,
    claustrumScopedState: state,
  }))
  await manager.refreshAllFallbacks(accounts, (account) => {
    resolved.push(account.id)
    return 'synthetic-poll-access'
  })
  expect(resolved).toEqual(['active'])
  expect(polled).toEqual(['active'])
})

test('fallback quota routing cache does not seed a needs-sign-in vault account', () => {
  const manager = new QuotaManager({ storage: null, now: () => 1000 })
  manager.seedFallbacksFromAccounts(
    ['needs_reauth', 'active'].map((state) => ({
      id: state,
      type: 'oauth',
      refresh: '',
      enabled: true,
      claustrumScopedCredentialId: `oauth:${state}`,
      claustrumScopedState: state,
      quota: { checkedAt: 1000, accountIdentity: state },
    })),
  )
  expect(manager.getFallback('needs_reauth')).toBeNull()
  expect(manager.getFallback('active')?.quota.checkedAt).toBe(1000)
})
