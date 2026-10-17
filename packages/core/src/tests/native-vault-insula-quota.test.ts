import { expect, spyOn } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaustrumConsumer,
  type InsulaUsageEntry,
  projectVaultRoster,
} from '@cortexkit/common-auth/claustrum'
import {
  type AccountStorage,
  getScopedQuotaWindowForModel,
  killswitchPassesPolicy,
  QUOTA_URL,
  quotaSnapshotModelScopeIsExhausted,
} from '../accounts.ts'
import {
  mergeInsulaQuota,
  normalizeInsulaClaudeQuota,
} from '../insula-quota.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import type { NativeCustodyClient } from '../native-custody.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { readNativeRuntime } from '../native-runtime.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import { createNativeVaultRuntime } from '../native-vault-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555'
const uuid2 = '22222222-2222-4333-8444-555555555555'
const uuid3 = '33333333-2222-4333-8444-555555555555'
const now = 1_000_000
const fetchedAt = now - 30_000
type Row = Awaited<
  ReturnType<NativeCustodyClient['listScoped']>
>['rows'][number]
const row = (credentialId: string, accountId: string): Row => ({
  id: credentialId,
  accountId,
  credentialType: 'oauth',
  categories: ['anthropic-native'],
  refreshAdapter: 'anthropic',
  serves: ['anthropic'],
  providerIds: [],
  state: 'active',
  operations: ['read'],
  recordVersion: 7,
  createdAtMs: null,
})
const mainRow = row('oauth:anthropic', uuid)
const workRow = row('oauth:anthropic:work', uuid2)

/** A claude entry in the shape insula's quota monitor publishes. */
function entry(
  account: string,
  overrides: Partial<InsulaUsageEntry> = {},
): InsulaUsageEntry {
  return {
    provider: 'claude',
    account: ` ${account} `,
    fetchedAt: new Date(fetchedAt).toISOString(),
    source: 'vault',
    usage: {
      primary: {
        usedPercent: 40,
        resetsAt: '1970-01-01T05:00:00.000Z',
        windowKind: 'five_hour',
        windowMinutes: 300,
      },
      secondary: {
        usedPercent: 55,
        resetsAt: '1970-01-08T00:00:00.000Z',
        windowKind: 'weekly',
        windowMinutes: 10_080,
        breakdown: [{ title: 'ignored' }],
      },
      extraRateWindows: [
        {
          id: 'Fable',
          title: 'Weekly · Opus only',
          window: {
            usedPercent: 97,
            resetsAt: '1970-01-08T00:00:00.000Z',
            windowKind: 'weekly',
            windowMinutes: 10_080,
            is_active: false,
          },
        },
      ],
    },
    ...overrides,
  }
}

const usageBody = {
  five_hour: { utilization: 10, resets_at: '1970-01-01T05:00:00.000Z' },
  seven_day: { utilization: 20, resets_at: '1970-01-08T00:00:00.000Z' },
}

async function fixture(entries: () => unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'native-vault-insula-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(join(root, 'anthropic-auth.json'))
  await initializeNativeTestAuthority(paths)
  const vaultPaths = nativeVaultPaths(paths)
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'opencode-enrollment.json',
    ),
  }
  await writeFile(
    env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const store = createNativePoolStore({
    paths: vaultPaths,
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  const projected = projectVaultRoster(
    undefined,
    {
      view: 'initial',
      credentials: [
        {
          credentialId: mainRow.id,
          credentialType: 'oauth',
          accountIdentity: uuid,
          state: 'active',
        },
      ],
      skipped: [],
    },
    { now },
  )
  const primaryRouteId = projected.rows[0]?.routeId
  if (!primaryRouteId) throw new Error('Missing fixture primary route')
  await store.updateSettings((settings) => {
    settings.mainAccountId = primaryRouteId
    settings.claustrum = {
      primaryAccount: {
        credentialId: mainRow.id,
        accountId: uuid,
        state: 'active',
      },
    }
  })
  const rows: readonly Row[] = [mainRow, workRow]
  const clock = { now }
  const counts = { insula: 0, usage: [] as string[] }
  const client: NativeCustodyClient = {
    listScoped: async () => ({
      view: 'view-2',
      rows,
      grants: undefined,
      grantTuples: undefined,
    }),
    getScoped: async (input) => ({
      credentialId: input.credentialId,
      accountId: rows.find((entry) => entry.id === input.credentialId)
        ?.accountId,
      material: `synthetic-bearer-${input.credentialId}`,
      recordVersion: 7,
      expiresAtMs: now + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
    insula: {
      // Unique per fixture, so common-auth's shared once-a-minute budget
      // never carries over between tests.
      connectionFile: join(root, 'daemon.json'),
      getUsage: async () => {
        counts.insula++
        return { result: entries() }
      },
    },
  }
  const usage: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) !== QUOTA_URL) throw new Error('unexpected request')
      counts.usage.push(new Headers(init?.headers).get('authorization') ?? '')
      return Response.json(usageBody)
    },
    { preconnect: fetch.preconnect },
  )
  const runtime = createNativeVaultRuntime({
    paths,
    host: 'opencode',
    env,
    now: () => clock.now,
    connect: async () => client,
    readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
  })
  deferCleanup(async () => {
    await runtime.drainQuotaPublications()
    runtime.close()
  })
  await runtime.refresh()
  const roster = await runtime.read()
  const routeOf = (account: string) => {
    const id = roster?.rows.find((r) => r.accountIdentity === account)?.routeId
    if (!id) throw new Error('Missing fixture route')
    return id
  }
  return { runtime, counts, usage, vaultPaths, routeOf, clock }
}

const bearer = (credentialId: string) =>
  `Bearer synthetic-bearer-${credentialId}`

function captureLogs() {
  const records: LogTestRecord[] = []
  const previous = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record) => records.push(record))
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previous)
  })
  return records
}

test('background sweep takes a fresh insula reading and sends no usage GET', async () => {
  const f = await fixture(() => [entry(uuid), entry(uuid2)])
  const quota = await f.runtime.fetchQuota(
    f.routeOf(uuid2),
    f.usage,
    undefined,
    undefined,
    'background',
  )
  expect(f.counts.usage).toEqual([])
  expect(f.counts.insula).toBe(1)
  expect(quota.accountIdentity).toBe(uuid2)
  expect(quota.five_hour).toMatchObject({
    usedPercent: 40,
    remainingPercent: 60,
  })
  expect(quota.seven_day).toMatchObject({
    usedPercent: 55,
    remainingPercent: 45,
  })
  // Every window is dated by insula's fetch, never by the sweep's clock.
  expect(quota.checkedAt).toBe(fetchedAt)
  expect(
    [quota.five_hour, quota.seven_day, ...(quota.scoped ?? [])].map(
      (window) => window?.checkedAt,
    ),
  ).toEqual([fetchedAt, fetchedAt, fetchedAt])
  // Published through the native quota path, bound to the served credential.
  await f.runtime.drainQuotaPublications()
  const state = await readNativeRuntime(
    f.vaultPaths.runtime,
    f.vaultPaths.storageId,
  )
  const stored =
    state.status === 'ready'
      ? state.state.accounts[f.routeOf(uuid2)]
      : undefined
  expect(stored?.binding).toMatchObject({
    kind: 'custody',
    credentialId: workRow.id,
    accountIdentity: uuid2,
    recordVersion: 7,
  })
  expect(stored?.quotaCheckedAt).toBe(fetchedAt)
})

test('a stale, missing or failed insula entry falls back to one usage GET for that account only', async () => {
  for (const work of [
    entry(uuid2, { stale: true }),
    entry(uuid2, { errorClass: 'rate_limited' }),
    entry(uuid2, { fetchedAt: new Date(now - 5 * 60_000).toISOString() }),
    undefined,
  ]) {
    const f = await fixture(() => [entry(uuid), ...(work ? [work] : [])])
    await f.runtime.fetchQuota(
      f.routeOf(uuid),
      f.usage,
      undefined,
      undefined,
      'background',
    )
    expect(f.counts.usage).toEqual([])
    const quota = await f.runtime.fetchQuota(
      f.routeOf(uuid2),
      f.usage,
      undefined,
      undefined,
      'background',
    )
    expect(f.counts.usage).toEqual([bearer(workRow.id)])
    expect(quota.five_hour).toMatchObject({ usedPercent: 10, checkedAt: now })
  }
})

test('an insula entry for a different account never applies', async () => {
  const f = await fixture(() => [
    entry(uuid3),
    // Same account, wrong provider.
    { ...entry(uuid2), provider: 'codex' },
  ])
  const quota = await f.runtime.fetchQuota(
    f.routeOf(uuid2),
    f.usage,
    undefined,
    undefined,
    'background',
  )
  expect(f.counts.insula).toBe(1)
  expect(f.counts.usage).toEqual([bearer(workRow.id)])
  expect(quota.five_hour?.usedPercent).toBe(10)
})

test('admission reads only the insula cache: never refreshes it, polls on a miss', async () => {
  const refresh = spyOn(ClaustrumConsumer.prototype, 'refreshInsulaQuota')
  const cached = spyOn(ClaustrumConsumer.prototype, 'cachedInsulaQuota')
  deferCleanup(() => {
    refresh.mockRestore()
    cached.mockRestore()
  })
  const f = await fixture(() => [entry(uuid2)])
  // Cold cache: no insula fetch on the request path, so the usage poll runs.
  await f.runtime.fetchQuota(
    f.routeOf(uuid2),
    f.usage,
    undefined,
    undefined,
    'admission',
  )
  expect(refresh).toHaveBeenCalledTimes(0)
  expect(cached).toHaveBeenCalledTimes(1)
  expect(f.counts.insula).toBe(0)
  expect(f.counts.usage).toEqual([bearer(workRow.id)])
  // A background tick warms the cache; admission then answers from it.
  await f.runtime.fetchQuota(
    f.routeOf(uuid),
    f.usage,
    undefined,
    undefined,
    'background',
  )
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(f.counts.insula).toBe(1)
  const callsBefore = refresh.mock.calls.length
  const quota = await f.runtime.fetchQuota(
    f.routeOf(uuid2),
    f.usage,
    undefined,
    undefined,
    'admission',
  )
  expect(refresh.mock.calls.length).toBe(callsBefore)
  expect(cached).toHaveBeenCalledTimes(2)
  expect(f.counts.insula).toBe(1)
  expect(f.counts.usage).toEqual([bearer(workRow.id), bearer(mainRow.id)])
  expect(quota.five_hour?.checkedAt).toBe(fetchedAt)
})

test('a quota read without a purpose polls Anthropic and leaves insula alone', async () => {
  const f = await fixture(() => [entry(uuid2)])
  await f.runtime.fetchQuota(f.routeOf(uuid2), f.usage)
  expect(f.counts.insula).toBe(0)
  expect(f.counts.usage).toEqual([bearer(workRow.id)])
})

test('local mode never touches insula', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-local-insula-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(join(root, 'anthropic-auth.json'))
  await initializeNativeTestAuthority(paths)
  const store = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    now: () => now,
  })
  await store.initialize()
  await store.add({
    id: 'imported-main',
    identity: uuid,
    credential: {
      type: 'oauth',
      access: 'sk-ant-oat01-synthetic-access',
      refresh: 'synthetic-refresh',
      expires: now + 3_600_000,
    },
  })
  await store.updateSettings((settings) => {
    settings.mainAccountId = 'imported-main'
  })
  const counts = { insula: 0, connects: 0, usage: 0 }
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          root,
          'none.json',
        ),
      },
      connect: async () => {
        counts.connects++
        throw new Error('local mode must not connect')
      },
    },
    local: {
      now: () => now,
      resolveIdentity: async () => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: uuid,
      }),
      refreshToken: async () => {
        throw new Error('no refresh expected')
      },
    },
  })
  deferCleanup(async () => {
    await runtime.drainQuotaPublications()
    runtime.close()
  })
  const refresh = spyOn(ClaustrumConsumer.prototype, 'refreshInsulaQuota')
  const forRoute = spyOn(
    ClaustrumConsumer.prototype,
    'cachedInsulaQuotaForRoute',
  )
  const cached = spyOn(ClaustrumConsumer.prototype, 'cachedInsulaQuota')
  deferCleanup(() => {
    refresh.mockRestore()
    forRoute.mockRestore()
    cached.mockRestore()
  })
  const usage: typeof fetch = Object.assign(
    async () => {
      counts.usage++
      return Response.json(usageBody)
    },
    { preconnect: fetch.preconnect },
  )
  for (const purpose of ['background', 'admission'] as const) {
    await runtime.fetchQuota('main', usage, undefined, undefined, purpose)
  }
  expect(counts.usage).toBe(2)
  expect(counts.connects).toBe(0)
  expect(refresh).toHaveBeenCalledTimes(0)
  expect(forRoute).toHaveBeenCalledTimes(0)
  expect(cached).toHaveBeenCalledTimes(0)
})

test('the Fable window from extraRateWindows drives scoped routing and the scoped killswitch floor', async () => {
  const f = await fixture(() => [entry(uuid2)])
  const quota = await f.runtime.fetchQuota(
    f.routeOf(uuid2),
    f.usage,
    undefined,
    undefined,
    'background',
  )
  expect(f.counts.usage).toEqual([])
  // Keyed exactly as the usage poll keys Anthropic's model-scoped limit.
  expect(quota.scoped).toEqual([
    {
      id: 'claude-weekly-scoped-fable',
      title: 'Fable only',
      modelName: 'Fable',
      usedPercent: 97,
      remainingPercent: 3,
      resetsAt: '1970-01-08T00:00:00.000Z',
      checkedAt: fetchedAt,
    },
  ])
  expect(getScopedQuotaWindowForModel(quota, 'claude-fable-5-1')?.id).toBe(
    'claude-weekly-scoped-fable',
  )
  expect(
    getScopedQuotaWindowForModel(quota, 'claude-sonnet-4-5'),
  ).toBeUndefined()
  const storage: AccountStorage = {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    accounts: [],
    killswitch: {
      enabled: true,
      main: { five_hour: 5, seven_day: 5, scoped: 10 },
    },
  }
  expect(
    killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5-1'),
  ).toBe(false)
  expect(
    killswitchPassesPolicy(quota, storage, undefined, 'claude-sonnet-4-5'),
  ).toBe(true)
  // An exhausted Fable reading blocks that model's route only.
  const exhausted = normalizeInsulaClaudeQuota(
    entry(uuid2, {
      usage: {
        ...entry(uuid2).usage,
        extraRateWindows: [{ id: 'Fable', window: { usedPercent: 100 } }],
      },
    }),
    { fetchedAt },
  )
  expect(
    quotaSnapshotModelScopeIsExhausted(exhausted, 'claude-fable-5-1'),
  ).toBe(true)
  expect(quotaSnapshotModelScopeIsExhausted(exhausted, 'claude-opus-4-8')).toBe(
    false,
  )
})

test('the source switch is logged once per change with fixed codes and no identity', async () => {
  const records = captureLogs()
  let entries = [entry(uuid2)]
  const f = await fixture(() => entries)
  const sweep = () =>
    f.runtime.fetchQuota(
      f.routeOf(uuid2),
      f.usage,
      undefined,
      undefined,
      'background',
    )
  await sweep()
  await sweep()
  const switches = () =>
    records
      .filter((record) => record.message === 'vault quota source changed')
      .map((record) => record.payload)
  expect(switches()).toEqual([{ source: 'insula', reason: 'insula-reading' }])
  // A minute later insula no longer lists the account: one fallback line.
  entries = []
  f.clock.now = now + 61_000
  await sweep()
  await sweep()
  expect(f.counts.insula).toBe(2)
  expect(f.counts.usage).toEqual([bearer(workRow.id), bearer(workRow.id)])
  expect(switches()).toEqual([
    { source: 'insula', reason: 'insula-reading' },
    { source: 'fallback', reason: 'no-insula-reading' },
  ])
  const after = records.filter(
    (record) => record.message === 'vault quota source changed',
  )
  const text = JSON.stringify(after)
  for (const secret of [
    uuid,
    uuid2,
    mainRow.id,
    workRow.id,
    f.routeOf(uuid),
    f.routeOf(uuid2),
  ])
    expect(text).not.toContain(secret)
})

test('normalizer: unknown shapes return undefined so the poll stays in charge', () => {
  expect(
    normalizeInsulaClaudeQuota(
      entry(uuid, { usage: { primary: entry(uuid).usage?.primary } }),
      { fetchedAt },
    ),
  ).toBeUndefined()
  expect(
    normalizeInsulaClaudeQuota(
      entry(uuid, {
        usage: {
          ...entry(uuid).usage,
          primary: { usedPercent: 40, windowKind: 'weekly' },
        },
      }),
      { fetchedAt },
    ),
  ).toBeUndefined()
  expect(
    normalizeInsulaClaudeQuota(entry(uuid, { stale: 'old' }), { fetchedAt }),
  ).toBeUndefined()
  expect(
    normalizeInsulaClaudeQuota(entry(uuid), { fetchedAt: Number.NaN }),
  ).toBeUndefined()
})

test('normalizer maps the Extra usage pool only when present', () => {
  const plain = normalizeInsulaClaudeQuota(entry(uuid), { fetchedAt })
  expect(plain?.extraUsage).toBeUndefined()
  const pooled = normalizeInsulaClaudeQuota(
    entry(uuid, {
      pools: [
        {
          title: 'Extra usage',
          total: { minor: 5_000, exponent: 2, unit: 'USD' },
          remaining: { minor: 1_250, exponent: 2, unit: 'USD' },
          spendable: true,
        },
      ],
    }),
    { fetchedAt },
  )
  expect(pooled?.extraUsage).toEqual({
    used: { amountMinor: 3_750, currency: 'USD', exponent: 2 },
    limit: { amountMinor: 5_000, currency: 'USD', exponent: 2 },
    utilizationPercent: 75,
    exhausted: false,
  })
})

test('a newer stored window survives an older insula reading', () => {
  const reading = normalizeInsulaClaudeQuota(entry(uuid), { fetchedAt })
  if (!reading) throw new Error('expected a reading')
  const merged = mergeInsulaQuota(reading, {
    five_hour: { usedPercent: 80, remainingPercent: 20, checkedAt: now },
    source: 'headers',
    checkedAt: now,
  })
  expect(merged.five_hour).toMatchObject({ usedPercent: 80, checkedAt: now })
  expect(merged.seven_day).toMatchObject({
    usedPercent: 55,
    checkedAt: fetchedAt,
  })
  expect(merged.scoped?.[0]?.checkedAt).toBe(fetchedAt)
  expect(merged.checkedAt).toBe(now)
})
