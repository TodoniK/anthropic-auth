import { expect } from 'bun:test'
import { acquireRefreshFileLock, fetchOAuthQuotaSnapshot } from '../accounts.ts'
import { NativeCustodyError } from '../native-custody.ts'
import { QuotaManager } from '../quota-manager.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const quotaResponse = {
  five_hour: { utilization: 4 },
  seven_day: { utilization: 13 },
}

function lastDispatch(manager: QuotaManager): unknown {
  return Object.getOwnPropertyDescriptor(manager, 'lastApiCallAt')?.value
}

function ownManager(manager: QuotaManager) {
  deferCleanup(() => manager.close())
  return manager
}

test('two unusable quota rows consume no dispatch spacing before the sole usable GET', async () => {
  let gets = 0
  const transport: typeof fetch = Object.assign(
    async () => {
      gets++
      return Response.json(quotaResponse)
    },
    { preconnect: fetch.preconnect },
  )
  const manager = ownManager(
    new QuotaManager({
      storage: null,
      now: () => 1_000,
      fetchQuotaSnapshot: (request, dispatch) => {
        if (request.accountId !== 'usable')
          throw new NativeCustodyError('route-unavailable')
        return fetchOAuthQuotaSnapshot({
          accessToken: 'OAT-synthetic-usable',
          fetchImpl: Object.assign(
            (
              input: Parameters<typeof fetch>[0],
              init?: Parameters<typeof fetch>[1],
            ) =>
              dispatch(
                () => transport(input, init),
                async () => {},
              ),
            { preconnect: transport.preconnect },
          ),
        })
      },
    }),
  )
  for (const id of ['unusable-one', 'unusable-two']) {
    await expect(
      manager.refreshFallbackWithMetadata(id, '', undefined),
    ).rejects.toMatchObject({ code: 'route-unavailable' })
    expect(lastDispatch(manager)).toBeUndefined()
  }
  expect(gets).toBe(0)
  const result = await manager.refreshFallbackWithMetadata(
    'usable',
    '',
    undefined,
  )
  expect(result.fetched).toBe(true)
  expect(gets).toBe(1)
  expect(lastDispatch(manager)).toBe(1_000)
})

test('physical quota GET starts stay one second apart when the first GET fails', async () => {
  const starts: number[] = []
  const methods: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      methods.push(request.method)
      return methods.length === 1
        ? new Response('provider unavailable', { status: 500 })
        : Response.json(quotaResponse)
    },
  })
  deferCleanup(() => server.stop(true))
  const manager = ownManager(
    new QuotaManager({
      storage: null,
      fetchImpl: Object.assign(
        async (
          _input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          starts.push(Date.now())
          return fetch(server.url, init)
        },
        { preconnect: fetch.preconnect },
      ),
    }),
  )
  await expect(
    manager.refreshFallbackWithMetadata(
      'first',
      'OAT-synthetic-first',
      undefined,
    ),
  ).rejects.toThrow()
  expect(starts.length).toBe(1)
  expect(lastDispatch(manager)).toBeGreaterThanOrEqual(starts[0]!)
  const result = await manager.refreshFallbackWithMetadata(
    'second',
    'OAT-synthetic-second',
    undefined,
  )
  expect(result.fetched).toBe(true)
  expect(starts.length).toBe(2)
  expect(methods).toEqual(['GET', 'GET'])
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1_000)
})

test('a quota lock loser neither sends a GET nor advances physical dispatch spacing', async () => {
  const held = await acquireRefreshFileLock({
    name: 'opencode-fallback-quota-refresh-held',
    ttlMs: 30_000,
  })
  if (!held) throw new Error('Fixture failed to hold the quota lock')
  deferCleanup(() => held.release())
  let gets = 0
  const manager = ownManager(
    new QuotaManager({
      storage: null,
      fetchImpl: Object.assign(
        async () => {
          gets++
          return Response.json(quotaResponse)
        },
        { preconnect: fetch.preconnect },
      ),
    }),
  )
  await expect(
    manager.refreshFallbackWithMetadata(
      'held',
      'OAT-synthetic-held',
      undefined,
    ),
  ).rejects.toThrow('already in progress')
  expect(gets).toBe(0)
  expect(lastDispatch(manager)).toBeUndefined()
  expect(
    (
      await manager.refreshFallbackWithMetadata(
        'free',
        'OAT-synthetic-free',
        undefined,
      )
    ).fetched,
  ).toBe(true)
  expect(gets).toBe(1)
})
