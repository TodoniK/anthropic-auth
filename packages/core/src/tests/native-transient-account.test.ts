import { expect, spyOn } from 'bun:test'
import { existsSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import type { PoolRow } from '@cortexkit/common-auth/store'
import type { ProviderAccountUuid } from '../claude-code.ts'
import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import {
  nativeLocalRowAwaitsTornWrite,
  projectNativeAccountViews,
} from '../native-account-view.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import {
  isNativeTransientAccountError,
  joinNativePoolWrite,
  NativeTransientAccountError,
} from '../native-transient-account.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

/*
 * A refresh that learns a row's first account UUID writes the state file
 * (a credential stamp naming the UUID) before the config file (the roster
 * accountId), holding the pool's config and state locks across both writes.
 * A lock-free read between the two writes loads the row as torn and not a
 * candidate. These tests hold a genuine common-auth `store.refresh` at that
 * point and check what Core's local authorization does with the row.
 */

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()

const now = 1_000_000
const MAIN_ID = 'imported-main'
const MAIN_UUID = '11111111-2222-4333-8444-555555555555'
const MAIN_ACCESS = 'sk-ant-oat01-synthetic-main-access'
const FALLBACK_ID = 'unknown-fallback'
const FALLBACK_UUID = '22222222-3333-4444-8555-666666666666'
const FALLBACK_ACCESS = 'sk-ant-oat01-synthetic-fallback-access'
const UUID_BY_ACCESS = new Map<string, ProviderAccountUuid>([
  [MAIN_ACCESS, MAIN_UUID as ProviderAccountUuid],
  [FALLBACK_ACCESS, FALLBACK_UUID as ProviderAccountUuid],
])

async function fixture() {
  const parent = new URL(
    '../../../../node_modules/.cache/native-transient-account/',
    import.meta.url,
  ).pathname
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'fixture-'))
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
    id: MAIN_ID,
    identity: MAIN_UUID,
    credential: {
      type: 'oauth',
      access: MAIN_ACCESS,
      refresh: 'synthetic-main-refresh',
      expires: now + 3_600_000,
    },
  })
  // A fallback whose account UUID is not known yet, as offline migration
  // leaves a legacy fallback that never recorded one.
  await store.add({
    id: FALLBACK_ID,
    credential: {
      type: 'oauth',
      access: FALLBACK_ACCESS,
      refresh: 'synthetic-fallback-refresh',
      expires: now + 3_600_000,
    },
  })
  await store.updateSettings((settings) => {
    settings.mainAccountId = MAIN_ID
  })
  const calls = { exchanges: 0, lookups: 0, poolLockHeldInCallback: 0 }
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'opencode-enrollment.json',
    ),
  }
  // Provider callbacks record whether either pool lock file exists while
  // they run: nothing may hold those locks across an exchange or lookup.
  const poolLockHeld = () =>
    existsSync(`${paths.config}.pool-config.lock`) ||
    existsSync(`${paths.state}.pool-state.lock`)
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env,
      connect: async () => {
        throw new Error('Synthetic vault client unavailable')
      },
    },
    local: {
      now: () => now,
      resolveIdentity: async (access) => {
        calls.lookups++
        if (poolLockHeld()) calls.poolLockHeldInCallback++
        const accountUuid = UUID_BY_ACCESS.get(access)
        return {
          deviceId: 'synthetic-device',
          sessionId: 'synthetic-session',
          ...(accountUuid ? { accountUuid } : {}),
        }
      },
      refreshToken: async (input) => {
        calls.exchanges++
        if (poolLockHeld()) calls.poolLockHeldInCallback++
        throw new Error(`unexpected exchange for ${input.refreshToken}`)
      },
    },
  })
  deferCleanup(() => runtime.close())
  return { root, paths, store, runtime, calls, env, poolLockHeld }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function loadedRow(f: Fixture, id: string): Promise<PoolRow> {
  const read = await f.store.read()
  if (read.status !== 'ready') throw new Error(`pool read ${read.status}`)
  const row = read.rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`row ${id} is missing`)
  return row
}

/**
 * Start a genuine common-auth refresh of the fallback that learns its UUID
 * with unchanged tokens, and hold it after its state-file write, before its
 * config-file write. Returns once the write is held (or has settled without
 * reaching that point, which the caller's assertions then expose).
 */
async function holdFirstIdentityWrite(f: Fixture) {
  const reached = gate()
  const release = gate()
  let held = false
  const producer = createNativePoolStore({
    paths: f.paths,
    quota: nativeQuotaCodec,
    now: () => now,
    onStep: async (step, info) => {
      if (
        held ||
        step !== 'after-state-write' ||
        info.operation !== 'refresh' ||
        info.rowId !== FALLBACK_ID
      )
        return
      held = true
      reached.open()
      await release.wait
    },
  })
  const write = producer.refresh(FALLBACK_ID, learnFallbackIdentity)
  trackDetached(write)
  await Promise.race([reached.wait, write.then(noop, noop)])
  return { write, release: release.open, isHeld: () => held }
}

function noop() {}

/** The refresh result the fixture's token endpoint gives: the same tokens, now naming the account. */
async function learnFallbackIdentity(credential: {
  access?: string
  refresh: string
}) {
  if (credential.access !== FALLBACK_ACCESS)
    throw new Error('the fallback row does not hold the fixture access token')
  return {
    access: credential.access,
    refresh: credential.refresh,
    expires: now + 8 * 3_600_000,
    identity: FALLBACK_UUID,
  }
}

/** Capture native-auth logs and signal when authorization reports that it is waiting on the writer. */
function captureNativeAuthLogs() {
  const records: LogTestRecord[] = []
  const waiting = gate()
  const previousLevel = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record) => {
    if (record.channel !== 'native-auth') return
    records.push(record)
    if (record.payload?.phase === 'waiting') waiting.open()
  })
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
  })
  return {
    records,
    waiting: waiting.wait,
    outcomes: () =>
      records.flatMap((record) =>
        typeof record.payload?.outcome === 'string'
          ? [record.payload.outcome]
          : [],
      ),
  }
}

test('authorizeLocal joins a held first-identity write and serves the intended fallback once it commits', async () => {
  const f = await fixture()
  const logs = captureNativeAuthLogs()
  const held = await holdFirstIdentityWrite(f)
  expect(held.isHeld()).toBe(true)
  const gapRow = await loadedRow(f, FALLBACK_ID)
  expect({
    torn: gapRow.torn,
    candidate: gapRow.candidate,
    identity: gapRow.identity,
  }).toEqual({ torn: true, candidate: false, identity: FALLBACK_UUID })

  const authorization = f.runtime.authorizeLocal(FALLBACK_ID)
  trackDetached(authorization)
  // Release only after the authorization is waiting on the held write. Code
  // without the join settles first instead, and the assertions expose it.
  await Promise.race([logs.waiting, authorization.then(noop, noop)])
  held.release()
  const [written] = await Promise.allSettled([held.write])
  const [authorized] = await Promise.allSettled([authorization])

  expect(written).toMatchObject({
    status: 'fulfilled',
    value: { status: 'rotated', identity: FALLBACK_UUID },
  })
  expect(authorized).toMatchObject({
    status: 'fulfilled',
    value: {
      status: 'usable',
      access: FALLBACK_ACCESS,
      binding: { rowId: FALLBACK_ID, identity: FALLBACK_UUID },
    },
  })
  expect(logs.outcomes()).toEqual(['joined'])
  expect(f.calls.exchanges).toBe(0)
  // The served binding names a UUID it had not been checked against, so the
  // lookup ran after the join; neither pool lock was held while it did.
  expect(f.calls.lookups).toBeGreaterThan(0)
  expect(f.calls.poolLockHeldInCallback).toBe(0)
})

test('a healthy companion authorizes during the held write without waiting on it', async () => {
  const f = await fixture()
  const logs = captureNativeAuthLogs()
  expect((await f.runtime.authorizeLocal('main')).status).toBe('usable')
  const held = await holdFirstIdentityWrite(f)
  expect(held.isHeld()).toBe(true)
  const [main] = await Promise.allSettled([f.runtime.authorizeLocal('main')])
  // Settled while the write is still held: no join on an unrelated route.
  expect(held.isHeld()).toBe(true)
  expect(main).toMatchObject({
    status: 'fulfilled',
    value: { status: 'usable', binding: { identity: MAIN_UUID } },
  })
  expect(logs.records).toEqual([])
  held.release()
  const [written] = await Promise.allSettled([held.write])
  expect(written.status).toBe('fulfilled')
})

test('a healthy authorization takes no pool lock and reads the pool files no more than before', async () => {
  const f = await fixture()
  const logs = captureNativeAuthLogs()
  // Validate once, so the measured call needs no lookup or metadata write.
  expect((await f.runtime.authorizeLocal('main')).status).toBe('usable')
  const lockPaths = [
    `${f.paths.config}.pool-config.lock`,
    `${f.paths.state}.pool-state.lock`,
  ]
  const writes = spyOn(filesystem, 'writeFile')
  const reads = spyOn(filesystem, 'readFile')
  deferCleanup(() => {
    writes.mockRestore()
    reads.mockRestore()
  })
  const [result] = await Promise.allSettled([f.runtime.authorizeLocal('main')])
  const lockWrites = writes.mock.calls.filter((call) =>
    lockPaths.includes(String(call[0])),
  ).length
  const configReads = reads.mock.calls.filter(
    (call) => String(call[0]) === f.paths.config,
  ).length
  const stateReads = reads.mock.calls.filter(
    (call) => String(call[0]) === f.paths.state,
  ).length
  writes.mockRestore()
  reads.mockRestore()
  expect(result).toMatchObject({
    status: 'fulfilled',
    value: { status: 'usable' },
  })
  // The read counts are those measured for the same call before the join
  // existed (base 2637c812), so the join adds no I/O to a healthy route.
  expect({ lockWrites, configReads, stateReads }).toEqual({
    lockWrites: 0,
    configReads: 10,
    stateReads: 5,
  })
  expect(logs.records).toEqual([])
})

/** Authorize the fallback while the first-identity write is paused; return when authorization starts waiting. */
async function waitingAuthorization(
  f: Fixture,
  logs: ReturnType<typeof captureNativeAuthLogs>,
  signal?: AbortSignal,
) {
  const authorization = f.runtime.authorizeLocal(
    FALLBACK_ID,
    signal ? { signal } : {},
  )
  trackDetached(authorization.then(noop, noop))
  const first = await Promise.race([
    logs.waiting.then(() => 'waiting' as const),
    authorization.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
  ])
  expect(first).toBe('waiting')
  // Wrapped, so awaiting this helper does not also await the authorization.
  return { authorization }
}

test('a write held past the wait budget fails retryably with the fixed transient error', async () => {
  const f = await fixture()
  const logs = captureNativeAuthLogs()
  const held = await holdFirstIdentityWrite(f)
  expect(held.isHeld()).toBe(true)
  const started = performance.now()
  const { authorization } = await waitingAuthorization(f, logs)
  const [authorized] = await Promise.allSettled([authorization])
  const elapsed = performance.now() - started
  // The write is still held: the authorization gave up on its own deadline.
  expect(held.isHeld()).toBe(true)
  expect(authorized.status).toBe('rejected')
  const error = authorized.status === 'rejected' ? authorized.reason : null
  expect(isNativeTransientAccountError(error)).toBe(true)
  expect(error).toBeInstanceOf(NativeTransientAccountError)
  expect(error).toMatchObject({
    name: 'NativeTransientAccountError',
    message: 'Anthropic account update in progress; retry the request',
    code: 'ECONNRESET',
    syscall: 'native-account-update',
  })
  expect(String((error as Error).message)).not.toContain(FALLBACK_ID)
  expect(elapsed).toBeGreaterThanOrEqual(1_900)
  expect(logs.outcomes()).toEqual(['deadline'])
  expect(
    logs.records.map((record) => JSON.stringify(record.payload)).join('\n'),
  ).not.toMatch(new RegExp(`${FALLBACK_ID}|${FALLBACK_UUID}`))
  expect(f.calls).toMatchObject({ exchanges: 0, lookups: 0 })
  held.release()
  const [written] = await Promise.allSettled([held.write])
  expect(written.status).toBe('fulfilled')
  // Once the held write commits, the fallback authorizes with its new binding.
  expect(await f.runtime.authorizeLocal(FALLBACK_ID)).toMatchObject({
    status: 'usable',
    binding: { identity: FALLBACK_UUID },
  })
})

test('a row left torn by a writer that stopped between its writes fails retryably after one join', async () => {
  const f = await fixture()
  const logs = captureNativeAuthLogs()
  const crashed = createNativePoolStore({
    paths: f.paths,
    quota: nativeQuotaCodec,
    now: () => now,
    onStep: async (step, info) => {
      if (step === 'after-state-write' && info.operation === 'refresh')
        throw new Error('synthetic writer stop between its two writes')
    },
  })
  const [stopped] = await Promise.allSettled([
    crashed.refresh(FALLBACK_ID, learnFallbackIdentity),
  ])
  expect(stopped.status).toBe('rejected')
  expect((await loadedRow(f, FALLBACK_ID)).torn).toBe(true)
  expect(f.poolLockHeld()).toBe(false)
  const [authorized] = await Promise.allSettled([
    f.runtime.authorizeLocal(FALLBACK_ID),
  ])
  expect(authorized.status).toBe('rejected')
  expect(
    isNativeTransientAccountError(
      authorized.status === 'rejected' ? authorized.reason : null,
    ),
  ).toBe(true)
  expect(logs.outcomes()).toEqual(['still-torn'])
  expect(f.calls).toMatchObject({ exchanges: 0, lookups: 0 })
})

test('aborting the request while it waits ends the wait at once and leaves no pool lock held', async () => {
  const f = await fixture()
  const logs = captureNativeAuthLogs()
  const held = await holdFirstIdentityWrite(f)
  const controller = new AbortController()
  const { authorization } = await waitingAuthorization(
    f,
    logs,
    controller.signal,
  )
  const reason = new Error('synthetic request abort')
  controller.abort(reason)
  const [authorized] = await Promise.allSettled([authorization])
  expect(held.isHeld()).toBe(true)
  expect(authorized).toEqual({ status: 'rejected', reason })
  expect(logs.outcomes()).toEqual([])
  held.release()
  const [written] = await Promise.allSettled([held.write])
  expect(written.status).toBe('fulfilled')
  expect(f.poolLockHeld()).toBe(false)
  expect(f.calls).toMatchObject({ exchanges: 0, lookups: 0 })
})

test('closing the runtime while it waits ends the wait with the closed error', async () => {
  const f = await fixture()
  const logs = captureNativeAuthLogs()
  const held = await holdFirstIdentityWrite(f)
  const { authorization } = await waitingAuthorization(f, logs)
  f.runtime.close()
  const [authorized] = await Promise.allSettled([authorization])
  expect(held.isHeld()).toBe(true)
  expect(authorized).toMatchObject({
    status: 'rejected',
    reason: { code: 'closed' },
  })
  held.release()
  const [written] = await Promise.allSettled([held.write])
  expect(written.status).toBe('fulfilled')
  expect(f.poolLockHeld()).toBe(false)
})

test('vault enrollment landing while it waits refuses the local route after the join', async () => {
  const f = await fixture()
  const logs = captureNativeAuthLogs()
  const held = await holdFirstIdentityWrite(f)
  const { authorization } = await waitingAuthorization(f, logs)
  await writeFile(
    getHostClaustrumEnrollmentPaths('opencode', f.env).tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  held.release()
  const [written] = await Promise.allSettled([held.write])
  const [authorized] = await Promise.allSettled([authorization])
  expect(written.status).toBe('fulfilled')
  expect(authorized).toMatchObject({
    status: 'fulfilled',
    value: { status: 'refused', reason: 'custody-mode' },
  })
  expect(f.calls).toMatchObject({ exchanges: 0, lookups: 0 })
})

test('without AbortSignal.any the wait still ends on abort and still joins', async () => {
  const f = await fixture()
  const logs = captureNativeAuthLogs()
  const any = AbortSignal.any
  Reflect.deleteProperty(AbortSignal, 'any')
  deferCleanup(() => {
    Object.defineProperty(AbortSignal, 'any', {
      value: any,
      writable: true,
      configurable: true,
    })
  })
  expect(typeof AbortSignal.any).toBe('undefined')
  const held = await holdFirstIdentityWrite(f)
  const controller = new AbortController()
  const { authorization: aborted } = await waitingAuthorization(
    f,
    logs,
    controller.signal,
  )
  const reason = new Error('synthetic request abort')
  controller.abort(reason)
  const [abortedResult] = await Promise.allSettled([aborted])
  expect(abortedResult).toEqual({ status: 'rejected', reason })
  // Direct lock joining works with an individual signal even without AbortSignal.any.
  const direct = new AbortController()
  const joining = joinNativePoolWrite(
    f.paths,
    [direct.signal],
    () => direct.signal.throwIfAborted(),
    () => now,
  )
  trackDetached(joining.then(noop, noop))
  held.release()
  const [joined] = await Promise.allSettled([joining])
  const [written] = await Promise.allSettled([held.write])
  expect(joined).toEqual({ status: 'fulfilled', value: 'joined' })
  expect(written.status).toBe('fulfilled')
  expect(f.poolLockHeld()).toBe(false)
})

test('disabled, deleted, invalid and unbound rows keep their refusals and never wait', async () => {
  const cases: Array<{
    name: string
    change: (f: Fixture) => Promise<void>
    expected: Record<string, unknown>
  }> = [
    {
      name: 'disabled',
      change: async (f) => {
        await f.store.disable(FALLBACK_ID, 'synthetic-disable')
      },
      expected: { status: 'refused', reason: 'quota-ineligible' },
    },
    {
      name: 'deleted',
      change: async (f) => {
        await f.store.remove(FALLBACK_ID)
      },
      expected: { status: 'refused', reason: 'row-ineligible' },
    },
    {
      name: 'invalid',
      change: async (f) => {
        const config = JSON.parse(await readFile(f.paths.config, 'utf8'))
        config.commonAuthPool.rows[FALLBACK_ID] = 'not an entry'
        await writeFile(f.paths.config, JSON.stringify(config))
      },
      expected: { status: 'refused', reason: 'row-ineligible' },
    },
    {
      name: 'unbound',
      change: async (f) => {
        const state = JSON.parse(await readFile(f.paths.state, 'utf8'))
        delete state.accounts[FALLBACK_ID].commonAuthPool
        await writeFile(f.paths.state, JSON.stringify(state))
      },
      expected: { status: 'refused', reason: 'row-ineligible' },
    },
  ]
  for (const entry of cases) {
    const f = await fixture()
    const logs = captureNativeAuthLogs()
    await entry.change(f)
    const [result] = await Promise.allSettled([
      f.runtime.authorizeLocal(FALLBACK_ID),
    ])
    expect({ name: entry.name, result }).toMatchObject({
      name: entry.name,
      result: { status: 'fulfilled', value: entry.expected },
    })
    expect({ name: entry.name, records: logs.records }).toEqual({
      name: entry.name,
      records: [],
    })
  }
})

test('the projection offers a row torn by an unfinished write, but never a disabled, quarantined or unusable one', async () => {
  const f = await fixture()
  const held = await holdFirstIdentityWrite(f)
  expect(held.isHeld()).toBe(true)
  const gap = await f.runtime.read()
  const fallback = gap.accounts.find((account) => account.id === FALLBACK_ID)
  expect(fallback).toMatchObject({
    enabled: true,
    accountIdentity: FALLBACK_UUID,
  })
  expect(fallback?.binding).toBeUndefined()
  expect(
    gap.policyStorage.accounts.find((account) => account.id === FALLBACK_ID)
      ?.enabled,
  ).toBe(true)
  const row = await loadedRow(f, FALLBACK_ID)
  expect(nativeLocalRowAwaitsTornWrite(f.paths, row)).toBe(true)
  // A different credential epoch may describe a replacement, not the
  // original credential receiving its first UUID. Do not admit that row
  // based on metadata from another credential generation.
  expect(
    nativeLocalRowAwaitsTornWrite(f.paths, row, {
      binding: {
        kind: 'local',
        storageId: f.paths.storageId,
        rowId: FALLBACK_ID,
        credentialEpoch: (row.credentialEpoch ?? 0) + 1,
      },
    }),
  ).toBe(false)
  const { torn: _torn, ...whole } = row
  const variants: Array<[string, PoolRow]> = [
    ['not torn', { ...whole, candidate: false }],
    ['disabled', { ...row, enabled: false }],
    [
      'quarantined',
      {
        ...row,
        enabled: false,
        disabledReason: 'identity-contradicted: {}',
      },
    ],
    ['disable reason only', { ...row, disabledReason: 'synthetic' }],
    ['invalid', { ...row, invalid: 'entry' }],
    ['unbound', { ...row, unbound: true }],
    ['stamp missing', { ...row, stamp: 'missing' }],
    ['staged', { ...row, staged: { reservation: 'synthetic' } }],
    ['no credential', { ...row, credential: undefined }],
    ['api', { ...row, type: 'api' }],
  ]
  for (const [name, variant] of variants) {
    expect({
      name,
      awaits: nativeLocalRowAwaitsTornWrite(f.paths, variant),
    }).toEqual({ name, awaits: false })
    const projected = projectNativeAccountViews({
      paths: f.paths,
      rows: [variant],
      settings: {},
    }).accounts[0]
    expect({ name, enabled: projected?.enabled }).toEqual({
      name,
      enabled: false,
    })
  }
  held.release()
  const [written] = await Promise.allSettled([held.write])
  expect(written.status).toBe('fulfilled')
})

test('a join that gets the config lock but not the state lock within the budget releases the config lock and reports the deadline', async () => {
  const f = await fixture()
  // Another holder keeps only the state lock, past the whole budget.
  const stateLock = await acquireRefreshFileLock({
    path: f.paths.state,
    name: 'pool-state',
    ttlMs: 10_000,
    renew: false,
    now: () => now,
  })
  if (!stateLock) throw new Error('the state lock was not free')
  deferCleanup(() => stateLock.release())
  const controller = new AbortController()
  const started = performance.now()
  const [joined] = await Promise.allSettled([
    joinNativePoolWrite(
      f.paths,
      [controller.signal],
      () => controller.signal.throwIfAborted(),
      () => now,
    ),
  ])
  expect(joined).toEqual({ status: 'fulfilled', value: 'deadline' })
  expect(performance.now() - started).toBeGreaterThanOrEqual(1_900)
  // The config lock it did take is not left behind.
  expect(existsSync(`${f.paths.config}.pool-config.lock`)).toBe(false)
  await stateLock.release()
  expect(f.poolLockHeld()).toBe(false)
})
