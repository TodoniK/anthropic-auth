import { expect, spyOn } from 'bun:test'
import * as filesystem from 'node:fs/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vaultRoster from '@cortexkit/common-auth/claustrum'
import {
  mutateVaultRoster,
  projectVaultRoster,
  readVaultRoster,
} from '@cortexkit/common-auth/claustrum'
import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import type { NativeCustodyClient } from '../native-custody.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { readNativeRuntime, updateNativeRuntime } from '../native-runtime.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import {
  acquireNativeVaultRuntime,
  createNativeVaultRuntime,
  publishNativeVaultRosterSeed,
  publishNativeVaultRuntimeSeed,
} from '../native-vault-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { QuotaManager } from '../quota-manager.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555'
const uuid2 = '22222222-2222-4333-8444-555555555555'
const id = 'oauth:anthropic'
const now = 1_000_000
type Row = Awaited<
  ReturnType<NativeCustodyClient['listScoped']>
>['rows'][number]
const listed: Row = {
  id,
  accountId: uuid,
  credentialType: 'oauth',
  categories: ['anthropic-native'],
  refreshAdapter: 'anthropic',
  serves: ['anthropic'],
  providerIds: [],
  state: 'active',
  operations: ['read'],
  recordVersion: 7,
  createdAtMs: null,
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-vault-runtime-'))
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
          credentialId: id,
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
      primaryAccount: { credentialId: id, accountId: uuid, state: 'active' },
    }
  })
  let rows: readonly Row[] = [listed]
  let version = 7
  let token = '01'.repeat(32)
  const counts = { connects: 0, lists: 0, gets: 0, closes: 0 }
  const reports: Parameters<
    NativeCustodyClient['reportAuthFailureScoped']
  >[0][] = []
  const client: NativeCustodyClient = {
    listScoped: async () => {
      counts.lists++
      return { view: `view-${rows.length}-${rows[0]?.accountId}`, rows }
    },
    getScoped: async (input) => {
      counts.gets++
      return {
        credentialId: input.credentialId,
        accountId: rows.find((row) => row.id === input.credentialId)?.accountId,
        material: `synthetic-bearer-${version}`,
        recordVersion: version,
        expiresAtMs: now + 3_600_000,
      }
    },
    reportAuthFailureScoped: async (report) => {
      reports.push(report)
    },
    close: () => {
      counts.closes++
    },
  }
  const options = {
    paths,
    host: 'opencode' as const,
    env,
    now: () => now,
    connect: async () => {
      counts.connects++
      return client
    },
    readToken: async () => ({ token, token_generation: 1 }),
  }
  const runtime = createNativeVaultRuntime(options)
  deferCleanup(() => runtime.close())
  return {
    paths,
    vaultPaths,
    env,
    options,
    runtime,
    counts,
    reports,
    client,
    store,
    primaryRouteId,
    rows: (value: readonly Row[]) => {
      rows = value
    },
    version: (value: number) => {
      version = value
    },
    token: (value: string) => {
      token = value
    },
  }
}

test('delayed vault fallback GET rejects a newly expired or revoked roster row before HTTP dispatch', async () => {
  for (const state of ['expired', 'revoked']) {
    const f = await fixture()
    const work = { ...listed, id: 'oauth:anthropic:work', accountId: uuid2 }
    f.rows([listed, work])
    const entered = gate(),
      release = gate()
    const backend = {
      ...f.client,
      getScoped: async (
        input: Parameters<NativeCustodyClient['getScoped']>[0],
      ) => {
        const material = await f.client.getScoped(input)
        entered.open()
        await release.wait
        return material
      },
    }
    const runtime = createNativeVaultRuntime({
      ...f.options,
      connect: async () => backend,
    })
    deferCleanup(() => runtime.close())
    const roster = await runtime.refresh()
    const route = roster?.rows.find(
      (row) => row.credentialId === work.id,
    )?.routeId
    if (!route) throw new Error('Missing fixture fallback route')
    let http = 0
    const pending = runtime.authorize(route).then((receipt) => {
      http++
      return receipt
    })
    await entered.wait
    f.rows([listed, { ...work, state }])
    await runtime.refresh()
    release.open()
    await expect(pending).rejects.toMatchObject({ code: 'not-active' })
    expect(f.counts.gets).toBe(1)
    expect(http).toBe(0)
  }
})

test('vault main follows the verified default but rejects a tampered current route binding', async () => {
  const f = await fixture()
  await f.runtime.refresh()
  f.rows([{ ...listed, accountId: uuid2 }])
  await f.runtime.refresh()
  let http = 0
  const pending = f.runtime.authorize('main').then((receipt) => {
    http++
    return receipt
  })
  expect((await pending).accountIdentity).toBe(uuid2)
  expect(f.counts.gets).toBe(1)
  expect(http).toBe(1)
  // Once discovery pins the verified default, changing its route, UUID or
  // credential in the roster must not authorize a different account.
  await mutateVaultRoster(f.vaultPaths.roster, (roster) => {
    if (!roster?.rows[0]) throw new Error('Missing fixture roster')
    roster.rows[0].routeId = f.primaryRouteId
    return { next: roster, result: undefined }
  })
  await expect(f.runtime.authorize('main')).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  await mutateVaultRoster(f.vaultPaths.roster, (roster) => {
    if (!roster?.rows[0]) throw new Error('Missing fixture roster')
    roster.rows[0].accountIdentity = uuid
    roster.rows[0].credentialId = 'oauth:anthropic:other'
    return { next: roster, result: undefined }
  })
  await expect(f.runtime.authorize('main')).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  expect(f.counts.gets).toBe(1)
})

test('persisted vault read never connects while first authorization discovers and every attempt gets a fresh receipt', async () => {
  const f = await fixture()
  expect(await f.runtime.read()).toBeUndefined()
  expect(f.counts.connects).toBe(0)
  const first = await f.runtime.authorize('main')
  const second = await f.runtime.authorize('main')
  expect(first).not.toBe(second)
  expect(f.counts).toEqual({ connects: 1, lists: 1, gets: 2, closes: 0 })
  expect(JSON.stringify(first)).not.toContain('synthetic-bearer')
  expect(first.accessToken).toBe('synthetic-bearer-7')
  expect(JSON.stringify(await f.runtime.read())).not.toContain(
    'synthetic-bearer',
  )
})

test('shared canonical storage and host consumer closes only on final release', async () => {
  const f = await fixture()
  const a = acquireNativeVaultRuntime(f.options)
  const b = acquireNativeVaultRuntime({ ...f.options, paths: { ...f.paths } })
  deferCleanup(() => {
    a.close()
    b.close()
  })
  await a.authorize('main')
  a.close()
  expect(f.counts.closes).toBe(0)
  await b.authorize('main')
  expect(f.counts.connects).toBe(1)
  b.close()
  expect(f.counts.closes).toBe(1)
  expect(() => a.read()).toThrow('closed')
})

test('vault close interrupts a pending connection and closes its late client exactly once', async () => {
  const f = await fixture()
  const connected = gate()
  const entered = gate()
  const lateClosed = gate()
  const client = {
    ...f.client,
    close: () => {
      f.client.close()
      lateClosed.open()
    },
  }
  const runtime = createNativeVaultRuntime({
    ...f.options,
    connect: async () => {
      entered.open()
      await connected.wait
      return client
    },
  })
  deferCleanup(() => runtime.close())
  const pending = runtime.authorize('main')
  await entered.wait
  runtime.close()
  await expect(pending).rejects.toMatchObject({ code: 'closed' })
  connected.open()
  await lateClosed.wait
  expect(f.counts.closes).toBe(1)
})

test('shared discovery publishes the primary pin once for concurrent consumers', async () => {
  const f = await fixture()
  const a = acquireNativeVaultRuntime(f.options)
  const b = acquireNativeVaultRuntime(f.options)
  deferCleanup(() => {
    a.close()
    b.close()
  })
  const publish = spyOn(vaultRoster, 'mutateVaultRoster')
  deferCleanup(() => publish.mockRestore())
  await Promise.all([a.refresh(), b.refresh()])
  expect(f.counts.lists).toBe(1)
  // Discovery and primary-account settings use two roster transactions in
  // total, not another settings transaction for each waiting caller.
  expect(publish).toHaveBeenCalledTimes(2)
})

test('a released observer with a pending notification cannot stop the surviving vault poller', async () => {
  const f = await fixture()
  const a = acquireNativeVaultRuntime(f.options)
  const b = acquireNativeVaultRuntime(f.options)
  const entered = gate()
  const release = gate()
  const thirdTick = gate()
  const timers = new Set<ReturnType<typeof setInterval>>()
  let ticks = 0
  const timerOptions = {
    intervalMs: 200,
    setInterval: ((fn: () => void, ms: number) => {
      const timer = setInterval(() => {
        fn()
        if (++ticks === 3) thirdTick.open()
      }, ms)
      timers.add(timer)
      return timer
    }) as typeof setInterval,
    clearInterval: ((timer: ReturnType<typeof setInterval>) => {
      timers.delete(timer)
      clearInterval(timer)
    }) as typeof clearInterval,
  }
  deferCleanup(() => {
    a.close()
    b.close()
    for (const timer of timers) clearInterval(timer)
  })
  const old = a.watch({
    ...timerOptions,
    onRefresh: () => {
      entered.open()
      return release.wait
    },
  })
  trackDetached(old.ready)
  const current = b.watch(timerOptions)
  trackDetached(current.ready)
  await entered.wait
  a.close()
  await thirdTick.wait
  expect(timers.size).toBe(1)
  expect(f.counts.lists).toBeGreaterThan(1)
  await b.authorize('main')
  release.open()
  b.close()
  expect(timers.size).toBe(0)
  expect(f.counts.closes).toBe(1)
}, 10_000)

test('shared vault consumers isolate connection, enrollment and every store path', async () => {
  const f = await fixture()
  const a = acquireNativeVaultRuntime(f.options)
  deferCleanup(() => a.close())
  await a.authorize('main')
  for (const change of [
    { host: 'pi' as const },
    {
      identity: {
        harness: 'pi',
        project_root: '/other-project',
        session: 'other-session',
      },
    },
    { paths: { ...f.paths, storageId: 'other-store' } },
    { connect: async () => f.client },
    {
      readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    },
    { now: () => now },
    { discover: async () => ({ view: 'other', credentials: [], skipped: [] }) },
    {
      env: {
        ...f.env,
        CLAUSTRUM_SUBC_CONNECTION: join(f.paths.config, 'other-connection'),
      },
    },
    {
      env: {
        ...f.env,
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: `${f.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE}.other`,
      },
    },
    ...(
      [
        'legacyConfig',
        'legacyState',
        'config',
        'state',
        'runtime',
        'journal',
        'roster',
      ] as const
    ).map((field) => ({
      paths: { ...f.paths, [field]: `${f.paths[field]}.other` },
    })),
  ]) {
    const b = acquireNativeVaultRuntime({ ...f.options, ...change })
    deferCleanup(() => b.close())
    // Reporting a receipt from another consumer must never cross the key boundary.
    const receipt = await a.authorize('main')
    await expect(b.reportFailure(receipt, 401, 'direct')).rejects.toMatchObject(
      { code: 'no-receipt' },
    )
    b.close()
  }
})

test('incomplete and unasserted vault lists retain prior accounts and cannot silently delete them', async () => {
  const f = await fixture()
  const first = await f.runtime.refresh()
  const routeId = first?.rows[0]?.routeId
  f.rows([{ ...listed, accountId: undefined }])
  const unclaimed = await f.runtime.refresh()
  expect(unclaimed?.rows[0]?.routeId).toBe(routeId)
  expect(unclaimed?.rows[0]?.unclaimed).toBe(true)
  f.rows([{ ...listed, id: '', accountId: undefined }])
  const malformed = await f.runtime.refresh()
  expect(malformed?.complete).toBe(false)
  expect(malformed?.rows).toHaveLength(1)
  f.rows([])
  expect((await f.runtime.refresh())?.rows).toHaveLength(0)
})

test('closing a pending vault list cannot publish its late result', async () => {
  const f = await fixture()
  const entered = gate(),
    release = gate(),
    settled = gate()
  const runtime = createNativeVaultRuntime({
    ...f.options,
    connect: async () => ({
      ...f.client,
      listScoped: async () => {
        entered.open()
        await release.wait
        settled.open()
        return { view: 'late', rows: [listed] }
      },
    }),
  })
  deferCleanup(() => runtime.close())
  const pending = runtime.refresh()
  await entered.wait
  runtime.close()
  await expect(pending).rejects.toMatchObject({ code: 'closed' })
  release.open()
  await settled.wait
  expect(await readVaultRoster(f.vaultPaths.roster)).toBeUndefined()
})

test('vault background 401 reports only the final rejected receipt and retries only once on strict newer version', async () => {
  const f = await fixture()
  const headers: string[] = []
  const transport: typeof fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get('authorization') ?? '')
      f.version(headers.length === 1 ? 8 : 9)
      return new Response('{}', { status: 401 })
    },
    { preconnect: fetch.preconnect },
  )
  await expect(f.runtime.fetchQuota('main', transport)).rejects.toThrow('401')
  expect(headers).toEqual([
    'Bearer synthetic-bearer-7',
    'Bearer synthetic-bearer-8',
  ])
  expect(f.reports.map((report) => report.recordVersion)).toEqual([8])
  expect(f.counts.gets).toBe(2)
  const served = await f.runtime.authorize('main')
  f.version(9)
  expect(await f.runtime.prepareRetry(served)).toMatchObject({
    retry: false,
    reason: 'version-not-newer',
  })
  expect(await f.runtime.prepareRetry(served)).toMatchObject({ retry: false })
})

// A 401 is reported only for the receipt whose response is final. A strictly
// newer replay makes the served version obsolete whatever the replay's outcome.
const finalReportCases = [
  {
    outcome: 'replay succeeds',
    reports: [],
    http: 2,
    decision: { currentVersion: 8, retry: true, reason: 'rotated' },
  },
  {
    outcome: 'replay is also rejected',
    reports: [8],
    http: 2,
    decision: { currentVersion: 8, retry: true, reason: 'rotated' },
  },
  {
    outcome: 'replay has a network error',
    reports: [],
    http: 2,
    decision: { currentVersion: 8, retry: true, reason: 'rotated' },
  },
  {
    outcome: 'vault holds the same version',
    reports: [7],
    http: 1,
    decision: {
      currentVersion: 7,
      retry: false,
      reason: 'version-not-newer',
    },
  },
  {
    outcome: 're-authorization fails',
    reports: [7],
    http: 1,
    decision: {
      currentVersion: null,
      retry: false,
      reason: 'reauthorize-failed',
    },
  },
] as const

for (const scenario of finalReportCases) {
  test(`vault quota 401 reports only the final rejected record when the ${scenario.outcome}`, async () => {
    const f = await fixture()
    let failGets = false
    const runtime = createNativeVaultRuntime({
      ...f.options,
      connect: async () => ({
        ...f.client,
        getScoped: async (input) => {
          if (failGets) throw new Error('synthetic vault unavailable')
          return f.client.getScoped(input)
        },
      }),
    })
    deferCleanup(() => runtime.close())
    const headers: string[] = []
    const transport: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        headers.push(new Headers(init?.headers).get('authorization') ?? '')
        if (headers.length === 1) {
          if (scenario.outcome === 're-authorization fails') failGets = true
          else if (scenario.outcome !== 'vault holds the same version')
            f.version(8)
          return new Response('{}', { status: 401 })
        }
        if (scenario.outcome === 'replay has a network error')
          throw new TypeError('synthetic replay network failure')
        if (scenario.outcome === 'replay is also rejected')
          return new Response('{}', { status: 401 })
        return new Response('{}', { status: 200 })
      },
      { preconnect: fetch.preconnect },
    )
    const records: LogTestRecord[] = []
    const previousLevel = getLogLevel()
    setLogLevel('debug')
    __setLogTestSink((record) => records.push(record))
    let outcome: unknown
    try {
      outcome = await runtime.fetchQuota('main', transport).then(
        () => 'ok',
        (error: unknown) => error,
      )
    } finally {
      __setLogTestSink(null)
      setLogLevel(previousLevel)
    }
    if (scenario.outcome === 'replay succeeds') expect(outcome).toBe('ok')
    else expect(outcome).toBeInstanceOf(Error)
    expect(headers).toEqual(
      ['Bearer synthetic-bearer-7', 'Bearer synthetic-bearer-8'].slice(
        0,
        scenario.http,
      ),
    )
    expect(f.reports.map((report) => report.recordVersion)).toEqual([
      ...scenario.reports,
    ])
    const decisions = records.filter(
      (record) => record.message === 'scoped 401 re-authorized',
    )
    expect(decisions.map((record) => record.payload)).toEqual([
      {
        site: 'quota-profile',
        credentialId: id,
        servedVersion: 7,
        ...scenario.decision,
      },
    ])
    expect(JSON.stringify(decisions)).not.toContain('synthetic-bearer')
    expect(JSON.stringify(decisions)).not.toContain('synthetic vault')
  })
}

test('vault receipt ownership and version fences reject copied, replaced and delayed observations', async () => {
  const f = await fixture()
  const first = await f.runtime.authorize('main')
  f.version(8)
  const second = await f.runtime.authorize('main')
  expect(
    await f.runtime.publish(second, {
      quota: {
        scoped: [],
        checkedAt: now,
        source: 'poll',
        accountIdentity: uuid,
      },
    }),
  ).toBe(true)
  expect(await f.runtime.publish(first, { lastUsed: now + 1 })).toBe(false)
  await expect(
    f.runtime.publish({ ...second }, { lastUsed: now }),
  ).rejects.toMatchObject({ code: 'no-receipt' })
  const quota = await readNativeRuntime(
    f.vaultPaths.runtime,
    f.vaultPaths.storageId,
  )
  expect(
    quota.status === 'ready'
      ? quota.state.accounts[(await f.runtime.read())!.rows[0]!.routeId]
          ?.binding
      : undefined,
  ).toMatchObject({ recordVersion: 8 })
  f.rows([{ ...listed, accountId: uuid2 }])
  await f.runtime.refresh()
  expect(await f.runtime.publish(second, { lastUsed: now + 1 })).toBe(false)
})

test('vault quota/profile and atomic Prime lineage remain secret-free in durable runtime', async () => {
  const f = await fixture()
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) =>
      Response.json(
        String(input).endsWith('/profile')
          ? {
              organization: {
                organization_type: 'claude_pro',
                rate_limit_tier: 'default',
              },
            }
          : {},
      ),
    { preconnect: fetch.preconnect },
  )
  expect((await f.runtime.fetchQuota('main', transport)).scoped).toEqual([])
  expect(
    (await f.runtime.fetchProfile('main', transport)).accountIdentity,
  ).toBe(uuid)
  const receipt = await f.runtime.authorize('main')
  const lineages = await Promise.all([
    f.runtime.getOrCreateAuthLineage(receipt),
    f.runtime.getOrCreateAuthLineage(receipt),
  ])
  expect(lineages[0]).toBe(lineages[1])
  expect(await f.runtime.incrementPrimeUsage(receipt, { inputTokens: 2 })).toBe(
    true,
  )
  expect(
    await f.runtime.incrementPrimeUsage(receipt, { outputTokens: 3 }),
  ).toBe(true)
  const state = await readNativeRuntime(
    f.vaultPaths.runtime,
    f.vaultPaths.storageId,
  )
  expect(
    state.status === 'ready'
      ? Object.values(state.state.accounts)[0]?.prime
      : undefined,
  ).toEqual({ count: 2, inputTokens: 2, outputTokens: 3, since: now })
  expect(await readFile(f.vaultPaths.runtime, 'utf8')).not.toContain(
    'synthetic-bearer',
  )
})

test('seed publication outer ownership is checked again at actual producer rename', async () => {
  const f = await fixture()
  const input = {
    inventory: {
      view: 'seed-view',
      credentials: [
        {
          credentialId: id,
          credentialType: 'oauth' as const,
          accountIdentity: uuid,
          state: 'active',
        },
      ],
      skipped: [],
    },
    primary: { credentialId: id, accountIdentity: uuid },
    primaryRouteId: 'imported-main',
    legacyRows: [],
    disabledAccountIdentities: [],
    reservedRouteIds: [],
  }
  let assertions = 0
  await expect(
    publishNativeVaultRosterSeed(f.vaultPaths, input, {
      assertOwned: async () => {
        if (++assertions === 2)
          throw new Error('synthetic outer lease lost at rename')
      },
    }),
  ).rejects.toThrow('synthetic outer lease lost at rename')
  expect(assertions).toBe(2)
  expect(await readVaultRoster(f.vaultPaths.roster)).toBeUndefined()
  const seed = await publishNativeVaultRosterSeed(f.vaultPaths, input)
  expect(seed.rows[0]?.routeId).toBe('imported-main')
})

test('custody runtime seed rejects unowned publication and descriptor callbacks before any write', async () => {
  const f = await fixture()
  const roster = await f.runtime.refresh()
  const routeId = roster!.rows[0]!.routeId
  await updateNativeRuntime(
    f.vaultPaths.runtime,
    f.vaultPaths.storageId,
    (current) => current,
  )
  const before = await readFile(f.vaultPaths.runtime)
  const state = {
    version: 1 as const,
    storageId: f.vaultPaths.storageId,
    accounts: {
      [routeId]: {
        binding: {
          kind: 'custody' as const,
          storageId: f.vaultPaths.storageId,
          routeId,
          credentialId: id,
          accountIdentity: uuid,
          recordVersion: 7,
        },
        lastUsed: now,
      },
    },
  }
  await expect(
    publishNativeVaultRuntimeSeed(f.vaultPaths, state, {
      assertOwned: async () => {
        throw new Error('lost outer lease')
      },
    }),
  ).rejects.toMatchObject({ code: 'publication-refused' })
  expect(await readFile(f.vaultPaths.runtime)).toEqual(before)
  let reads = 0
  Object.defineProperty(state.accounts[routeId], 'lastUsed', {
    get: () => {
      reads++
      return now
    },
    enumerable: true,
  })
  await expect(
    publishNativeVaultRuntimeSeed(f.vaultPaths, state),
  ).rejects.toMatchObject({ code: 'publication-refused' })
  expect(reads).toBe(0)
  expect(await readFile(f.vaultPaths.runtime)).toEqual(before)
})

test('vault route disable persists decline and a held roster prevents replaced-account runtime publication', async () => {
  const f = await fixture()
  const receipt = await f.runtime.authorize('main')
  await f.runtime.setEnabled('main', false)
  await f.runtime.refresh()
  await expect(f.runtime.authorize('main')).rejects.toMatchObject({
    code: 'route-declined',
  })
  await mutateVaultRoster(f.vaultPaths.roster, (current) => {
    if (!current) throw new Error('Missing fixture roster')
    current.rows[0]!.accountIdentity = uuid2
    return { next: current, result: undefined }
  })
  expect(await f.runtime.publish(receipt, { lastUsed: now })).toBe(false)
})

test('vault quota auth failures never arm quota backoff while 429 still does', async () => {
  for (const status of [401, 403, 429]) {
    const f = await fixture()
    const transport: typeof fetch = Object.assign(
      async () => new Response('synthetic-private-body', { status }),
      { preconnect: fetch.preconnect },
    )
    await expect(f.runtime.fetchQuota('main', transport)).rejects.toMatchObject(
      { status },
    )
    const state = await readNativeRuntime(
      f.vaultPaths.runtime,
      f.vaultPaths.storageId,
    )
    const error =
      state.status === 'ready'
        ? state.state.accounts[f.primaryRouteId]?.lastQuotaRefreshError
        : undefined
    if (status === 429)
      expect(error).toMatchObject({ status: 429, nextRetryAt: now + 60_000 })
    else expect(error).toBeUndefined()
  }
})

test('vault quota retry admits only after deferred body cleanup so decline prevents a second HTTP', async () => {
  const f = await fixture()
  const entered = gate(),
    release = gate()
  let http = 0
  const transport: typeof fetch = Object.assign(
    async () => {
      if (++http === 1) {
        f.version(8)
        return new Response(
          new ReadableStream({
            cancel: async () => {
              entered.open()
              await release.wait
            },
          }),
          { status: 401 },
        )
      }
      return Response.json({})
    },
    { preconnect: fetch.preconnect },
  )
  const pending = f.runtime.fetchQuota('main', transport)
  await entered.wait
  await f.runtime.setEnabled('main', false)
  release.open()
  await expect(pending).rejects.toMatchObject({ status: 401 })
  expect(http).toBe(1)
  expect(f.counts.gets).toBe(1)
})

test('vault failed failure-report telemetry cannot block its one fresh retry or change rejected versions', async () => {
  const f = await fixture()
  const runtime = createNativeVaultRuntime({
    ...f.options,
    connect: async () => ({
      ...f.client,
      reportAuthFailureScoped: async (input) => {
        await f.client.reportAuthFailureScoped(input)
        throw new Error('synthetic telemetry unavailable')
      },
    }),
  })
  deferCleanup(() => runtime.close())
  let http = 0
  const transport: typeof fetch = Object.assign(
    async () => {
      http++
      f.version(http === 1 ? 8 : 9)
      return new Response('{}', { status: 401 })
    },
    { preconnect: fetch.preconnect },
  )
  await expect(runtime.fetchQuota('main', transport)).rejects.toMatchObject({
    status: 401,
  })
  expect(http).toBe(2)
  expect(f.reports.map((report) => report.recordVersion)).toEqual([8])
})

test('vault quota success and failure cannot inherit another account runtime clear floor', async () => {
  for (const status of [200, 429]) {
    const f = await fixture()
    await f.runtime.refresh()
    await updateNativeRuntime(
      f.vaultPaths.runtime,
      f.vaultPaths.storageId,
      (current) => {
        current.accounts[f.primaryRouteId] = {
          binding: {
            kind: 'custody',
            storageId: f.vaultPaths.storageId,
            routeId: f.primaryRouteId,
            credentialId: id,
            accountIdentity: uuid2,
            recordVersion: 7,
          },
          quotaErrorClearedAt: now + 1_000_000,
        }
        return current
      },
    )
    const transport: typeof fetch = Object.assign(
      async () => new Response('{}', { status }),
      { preconnect: fetch.preconnect },
    )
    if (status === 200) await f.runtime.fetchQuota('main', transport)
    else
      await expect(
        f.runtime.fetchQuota('main', transport),
      ).rejects.toMatchObject({ status: 429 })
    const state = await readNativeRuntime(
      f.vaultPaths.runtime,
      f.vaultPaths.storageId,
    )
    const entry =
      state.status === 'ready'
        ? state.state.accounts[f.primaryRouteId]
        : undefined
    if (status === 200) expect(entry?.quotaErrorClearedAt).toBe(now)
    else expect(entry?.lastQuotaRefreshError?.checkedAt).toBe(now)
  }
})

/**
 * Capture the INFO records native runtimes emit on the `commands` channel,
 * starting from the info level, and restore the previous level and sink after
 * the test. Bun runs tests with NODE_ENV=test, under which the logger
 * delivers records only to this sink and writes no log file.
 */
function captureCommandLogs() {
  expect(process.env.NODE_ENV).toBe('test')
  const previousLevel = getLogLevel()
  const records: LogTestRecord[] = []
  setLogLevel('info')
  __setLogTestSink((record) => {
    if (record.channel === 'commands') records.push(record)
  })
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
  })
  return {
    /** Message and payload of each record captured since the previous call. */
    take() {
      const taken = records.map(({ message, payload }) => ({
        message,
        payload,
      }))
      records.length = 0
      return taken
    },
  }
}

/** A native account runtime over the fixture's pool and vault roster. */
function accountRuntime(f: Awaited<ReturnType<typeof fixture>>) {
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    vault: f.options,
  })
  deferCleanup(() => runtime.close())
  return runtime
}

test('vault setEnabled reports whether the route flag changed, judged on the roster under its lock', async () => {
  const f = await fixture()
  await f.runtime.refresh()
  const row = async () => (await readVaultRoster(f.vaultPaths.roster))?.rows[0]

  expect(await f.runtime.setEnabled('main', false)).toBe(true)
  expect(await f.runtime.setEnabled('main', false)).toBe(false)
  expect((await row())?.enabled).toBe(false)
  expect((await readVaultRoster(f.vaultPaths.roster))?.declined).toEqual([
    { credentialId: id, accountIdentity: uuid },
  ])

  expect(await f.runtime.setEnabled('main', true)).toBe(true)
  expect(await f.runtime.setEnabled('main', true)).toBe(false)
  expect((await row())?.enabled).toBe(true)
  expect((await readVaultRoster(f.vaultPaths.roster))?.declined).toEqual([])

  await expect(
    f.runtime.setEnabled('missing-route', false),
  ).rejects.toMatchObject({ code: 'route-unavailable' })
})

test('two native runtimes disabling the same vault account log one change, judged under the roster lock', async () => {
  const f = await fixture()
  await f.runtime.refresh()
  const a = accountRuntime(f)
  const b = accountRuntime(f)
  const logs = captureCommandLogs()

  // Two operations disable the same account. The first reads it enabled; the
  // second completes the decline before the first writes, so the first
  // changes no enabled flag.
  const read = a.read.bind(a)
  let interleaved = false
  const readSpy = spyOn(a, 'read').mockImplementation(async () => {
    const snapshot = await read()
    if (!interleaved) {
      interleaved = true
      expect(snapshot.accounts.find((row) => row.id === 'main')?.enabled).toBe(
        true,
      )
      await b.setEnabled('main', false)
    }
    return snapshot
  })
  deferCleanup(() => readSpy.mockRestore())
  await a.setEnabled('main', false)
  readSpy.mockRestore()
  expect(interleaved).toBe(true)
  expect(logs.take()).toEqual([
    {
      message: 'account disabled',
      payload: expect.objectContaining({ id: 'main', enabled: false }),
    },
  ])

  // Explicit enable/disable changes only this plugin's use of the vault account.
  // Removing credentials is not a substitute for declining their use.
  await a.setEnabled('main', true)
  await expect(a.remove('main')).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  await a.setEnabled('main', false)
  await a.setEnabled('main', false)
  expect(logs.take()).toEqual([
    {
      message: 'account enabled',
      payload: expect.objectContaining({ id: 'main', enabled: true }),
    },
    {
      message: 'account disabled',
      payload: expect.objectContaining({ id: 'main', enabled: false }),
    },
  ])
})

test('vault account reorder refuses without changing roster, settings, or local state', async () => {
  const f = await fixture()
  f.rows([
    listed,
    { ...listed, id: 'oauth:anthropic:work', accountId: uuid2 },
    {
      ...listed,
      id: 'oauth:anthropic:personal',
      accountId: '33333333-2222-4333-8444-555555555555',
    },
  ])
  await f.runtime.refresh()
  const a = accountRuntime(f)
  const fallbacks = async () =>
    (await a.read()).accounts
      .filter((row) => row.id !== 'main')
      .map((row) => row.id)
  const [first, second] = await fallbacks()
  if (!first || !second) throw new Error('Missing fixture fallback routes')
  const logs = captureCommandLogs()

  const files = [
    f.vaultPaths.roster,
    f.vaultPaths.config,
    f.paths.config,
    f.paths.state,
    f.paths.journal,
  ]
  const readBytes = async (path: string) =>
    readFile(path).catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return undefined
      throw error
    })
  const before = await Promise.all(files.map(readBytes))
  await expect(a.reorder([second, first], second)).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  expect(await fallbacks()).toEqual([first, second])
  await expect(a.reorder([first, second], first)).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  expect(await Promise.all(files.map(readBytes))).toEqual(before)
  expect(logs.take()).toEqual([])
})

test('vault profile I/O failure rechecks non-secret provenance without another GET', async () => {
  const f = await fixture()
  const initial = await f.runtime.authorize('main')
  expect(await f.runtime.publish(initial, { lastUsed: now })).toBe(true)
  const before = await readFile(f.vaultPaths.runtime)
  const originalRename = filesystem.rename
  let failedWrites = 0
  const writer = spyOn(filesystem, 'rename').mockImplementation(
    async (from, to) => {
      if (to === f.vaultPaths.runtime) {
        failedWrites++
        throw Object.assign(
          new Error('Synthetic vault profile rename failure'),
          { code: 'EIO' },
        )
      }
      await originalRename(from, to)
    },
  )
  deferCleanup(() => writer.mockRestore())
  const transport = Object.assign(
    async () =>
      Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      }),
    { preconnect() {} },
  )
  const result = await f.runtime.fetchProfileForDisplay('main', transport)
  expect(await result.persisted).toBe('failed')
  expect(failedWrites).toBe(1)
  expect(await readFile(f.vaultPaths.runtime)).toEqual(before)
  const gets = f.counts.gets
  expect(await result.isCurrent()).toBe(true)
  expect(f.counts.gets).toBe(gets)
  writer.mockRestore()
  f.version(8)
  const peer = createNativeVaultRuntime(f.options)
  deferCleanup(() => peer.close())
  const successor = await peer.authorize('main')
  expect(await peer.publish(successor, { lastUsed: now + 1 })).toBe(true)
  const successorGets = f.counts.gets
  expect(await result.isCurrent()).toBe(false)
  expect(f.counts.gets).toBe(successorGets)
})

test('disabled vault route cannot validate a fetched profile for display', async () => {
  const f = await fixture()
  const transport = Object.assign(
    async () => {
      await f.runtime.setEnabled('main', false)
      return Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      })
    },
    { preconnect() {} },
  )
  const result = await f.runtime.fetchProfileForDisplay('main', transport)
  expect(await result.isCurrent()).toBe(false)
})

test('a newer vault receipt refuses stale profile publication and display', async () => {
  const f = await fixture()
  const transport = Object.assign(
    async () => {
      f.version(8)
      await f.runtime.authorize('main')
      return Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      })
    },
    { preconnect() {} },
  )
  const result = await f.runtime.fetchProfileForDisplay('main', transport)
  expect(await result.persisted).toBe('refused')
  expect(await result.isCurrent()).toBe(false)
})

async function preservedLocalFiles(f: Awaited<ReturnType<typeof fixture>>) {
  const files = [
    f.paths.legacyConfig,
    f.paths.legacyState,
    f.paths.config,
    f.paths.state,
    f.paths.runtime,
    f.paths.journal,
    f.paths.roster,
  ]
  for (const file of files)
    await writeFile(file, 'synthetic-unreadable-local-state', { mode: 0o600 })
  const before = await Promise.all(files.map((file) => readFile(file)))
  return async () =>
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(
      before,
    )
}

test('approved vault recovery discovers its own main without reading local credentials or migration authority', async () => {
  const f = await fixture()
  const unchanged = await preservedLocalFiles(f)
  await f.store.updateSettings((settings) => {
    delete settings.mainAccountId
    delete settings.claustrum
  })
  const facade = accountRuntime(f)
  await facade.vault.refresh()
  const snapshot = await facade.read()
  expect(snapshot.mode).toBe('claustrum')
  expect(snapshot.routingPath).toBe(f.vaultPaths.routing)
  expect(snapshot.accounts).toHaveLength(1)
  expect(snapshot.accounts[0]).toMatchObject({
    id: 'main',
    source: 'vault',
    accountIdentity: uuid,
  })
  const saved = await f.store.readSettings()
  if (saved.status !== 'ready') throw new Error('Vault settings are missing')
  expect(saved.settings.mainAccountId).toBe(f.primaryRouteId)
  expect(saved.settings.claustrum).toEqual({
    primaryAccount: { credentialId: id, accountId: uuid },
  })
  expect(f.counts.gets).toBe(0)
  await unchanged()
})

test('vault-only settings, relay and account controls preserve every local file', async () => {
  const f = await fixture()
  const unchanged = await preservedLocalFiles(f)
  const facade = accountRuntime(f)
  await facade.vault.refresh()
  await facade.updateSettings((settings) => {
    settings.routing = { mode: 'fallback-first' }
  })
  await facade.updateRelay({
    enabled: true,
    url: 'https://relay.example.invalid',
    token: 'synthetic-private-relay',
    transport: 'http',
  })
  expect(await facade.getRelayConfig()).toMatchObject({
    enabled: true,
    token: 'synthetic-private-relay',
  })
  const receipt = await facade.authorizeVault('main')
  expect(
    await facade.vault.publish(receipt, {
      lastQuotaRefreshError: {
        message: 'synthetic quota failure',
        checkedAt: now,
        accountIdentity: uuid,
      },
    }),
  ).toBe(true)
  expect(await facade.resetBackoff('main', receipt, 'quota')).toBe(true)
  await facade.setEnabled('main', false)
  expect((await facade.read()).accounts[0]?.enabled).toBe(false)
  await facade.setEnabled('main', true)
  expect((await facade.read()).accounts[0]?.enabled).toBe(true)
  const saved = await f.store.readSettings()
  if (saved.status !== 'ready') throw new Error('Vault settings are missing')
  expect(saved.settings.routing).toEqual({ mode: 'fallback-first' })
  expect(JSON.stringify(saved.settings)).not.toContain(
    'synthetic-private-relay',
  )
  const metadata = await readNativeRuntime(
    f.vaultPaths.runtime,
    f.vaultPaths.storageId,
  )
  if (metadata.status !== 'ready') throw new Error('Vault metadata is missing')
  expect(metadata.state.relay?.token).toBe('synthetic-private-relay')
  expect(
    metadata.state.accounts[f.primaryRouteId]?.lastQuotaRefreshError,
  ).toBeUndefined()
  await unchanged()
})

test('stale local account actions refuse in vault mode before reading or writing the local pool', async () => {
  const f = await fixture()
  const unchanged = await preservedLocalFiles(f)
  const facade = accountRuntime(f)
  await expect(
    facade.addApi({
      routeId: 'stale',
      apiKey: 'synthetic-private-key',
      baseURL: 'https://api.example.invalid',
    }),
  ).rejects.toMatchObject({ code: 'route-unavailable' })
  await expect(facade.remove('stale')).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  await expect(facade.reorder(['stale'])).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  await expect(facade.captureLocalSubject('main')).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  await expect(
    facade.loginOAuth({
      routeId: 'stale',
      credential: {
        access: 'sk-ant-oat01-synthetic-local',
        refresh: 'synthetic-local-refresh',
        expires: now + 3_600_000,
      },
    }),
  ).rejects.toMatchObject({ code: 'route-unavailable' })
  expect(f.counts.gets).toBe(0)
  await unchanged()
})

test('replacing the verified vault default re-pins a new account without quota or Prime inheritance', async () => {
  const f = await fixture()
  const unchanged = await preservedLocalFiles(f)
  const facade = accountRuntime(f)
  await facade.vault.refresh()
  const old = await facade.authorizeVault('main')
  expect(
    await facade.vault.publish(old, {
      quota: {
        accountIdentity: uuid,
        checkedAt: now,
        five_hour: { usedPercent: 99, remainingPercent: 1, checkedAt: now },
      },
    }),
  ).toBe(true)
  const oldLineage = await facade.getOrCreateAuthLineage('main', old)
  expect(oldLineage).toMatch(/^[a-f0-9-]{36}$/)
  expect(
    await facade.incrementPrimeUsage('main', old, { inputTokens: 2 }),
  ).toBe(true)
  f.rows([{ ...listed, accountId: uuid2 }])
  await facade.vault.refresh()
  const snapshot = await facade.read()
  const main = snapshot.accounts.find((row) => row.id === 'main')
  expect(main?.accountIdentity).toBe(uuid2)
  expect(main?.quota).toBeUndefined()
  expect(main?.prime).toBeUndefined()
  expect(snapshot.settings.mainAccountId).not.toBe(f.primaryRouteId)
  expect(await facade.vault.publish(old, { lastUsed: now })).toBe(false)
  const current = await facade.authorizeVault('main')
  expect(current.accountIdentity).toBe(uuid2)
  expect(await facade.getOrCreateAuthLineage('main', current)).not.toBe(
    oldLineage,
  )
  await unchanged()
})

test('approved enrollment missing its token refuses vault credentials and never opens local recovery files', async () => {
  const f = await fixture()
  const unchanged = await preservedLocalFiles(f)
  const enrollment = getHostClaustrumEnrollmentPaths('opencode', f.env)
  await writeFile(
    enrollment.statePath,
    JSON.stringify({
      version: 1,
      phase: 'approved',
      proposedName: 'anthropic-auth-opencode',
      tokenGeneration: 1,
      updatedAt: now,
    }),
    { mode: 0o600 },
  )
  await rm(enrollment.tokenPath)
  const facade = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    vault: { ...f.options, readToken: undefined },
  })
  deferCleanup(() => facade.close())
  expect((await facade.read()).mode).toBe('claustrum')
  await expect(facade.authorizeVault('main')).rejects.toBeInstanceOf(Error)
  expect(f.counts.gets).toBe(0)
  await unchanged()
})

test('unverified default discovery removes main admission without inheriting a local account identity', async () => {
  const f = await fixture()
  const unchanged = await preservedLocalFiles(f)
  const facade = accountRuntime(f)
  await facade.vault.refresh()
  f.rows([{ ...listed, accountId: undefined }])
  await facade.vault.refresh()
  const snapshot = await facade.read()
  expect(snapshot.mode).toBe('claustrum')
  expect(snapshot.accounts.find((row) => row.id === 'main')).toBeUndefined()
  await expect(facade.authorizeVault('main')).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  expect(f.counts.gets).toBe(0)
  await unchanged()
})

test('offline setup inventory populates only vault files and cannot replace per-send scoped authorization', async () => {
  const f = await fixture()
  const unchanged = await preservedLocalFiles(f)
  let discoveries = 0
  const runtime = createNativeVaultRuntime({
    ...f.options,
    discover: async () => {
      discoveries++
      return {
        view: 'offline-verified-inventory',
        credentials: [
          {
            credentialId: id,
            credentialType: 'oauth',
            accountIdentity: uuid,
            state: 'active',
          },
        ],
        skipped: [],
      }
    },
  })
  deferCleanup(() => runtime.close())
  await runtime.refresh()
  expect(discoveries).toBe(1)
  expect(f.counts.connects).toBe(0)
  expect(f.counts.gets).toBe(0)
  const receipt = await runtime.authorize('main')
  expect(receipt.accountIdentity).toBe(uuid)
  expect(f.counts.connects).toBe(1)
  expect(f.counts.gets).toBe(1)
  await unchanged()
})

for (const change of ['mode', 'subject'] as const) {
  test(`vault ${change} lost during quota spacing drops the attempt without a GET, spacing stamp or 401 report`, async () => {
    const f = await fixture()
    await f.runtime.refresh()
    let gets = 0
    let dispatches = 0
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const transport: typeof fetch = Object.assign(
      async () => {
        gets++
        return Response.json({
          five_hour: { utilization: 4 },
          seven_day: { utilization: 13 },
        })
      },
      { preconnect: fetch.preconnect },
    )
    const manager = new QuotaManager({
      storage: null,
      fetchQuotaSnapshot: (_request, dispatch) =>
        f.runtime.fetchQuota(
          'main',
          transport,
          undefined,
          (send, revalidate) => {
            dispatches++
            if (dispatches === 2) entered()
            return dispatch(send, revalidate)
          },
        ),
    })
    deferCleanup(() => manager.close())
    await manager.refreshMainWithMetadata(uuid, '')
    const firstStamp: unknown = Object.getOwnPropertyDescriptor(
      manager,
      'lastApiCallAt',
    )?.value
    expect(typeof firstStamp).toBe('number')
    const pending = manager.refreshMainWithMetadata(uuid, '').then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await waiting
    if (change === 'mode')
      await rm(f.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE)
    else await f.runtime.setEnabled('main', false)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('An unavailable vault quota attempt was admitted')
    expect(result.error).toMatchObject({
      code: change === 'mode' ? 'route-unavailable' : 'identity-changed',
    })
    expect(gets).toBe(1)
    expect(f.counts.gets).toBe(2)
    expect(f.reports).toEqual([])
    expect(
      Object.getOwnPropertyDescriptor(manager, 'lastApiCallAt')?.value,
    ).toBe(firstStamp)
  })
}
