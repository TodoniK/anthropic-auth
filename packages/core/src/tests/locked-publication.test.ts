import { expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeEnrollmentTokenFile } from '@cortexkit/claustrum-client'
import { lockPathFor } from '@cortexkit/common-auth/fs'
import { acquireRefreshFileLock } from '../accounts.ts'
import {
  CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
  ClaustrumEnrollmentManager,
  getClaustrumEnrollmentPaths,
} from '../claustrum-enrollment.ts'
import { updateNativeRuntime } from '../native-runtime.ts'
import { QuotaManager } from '../quota-manager.ts'
import { StickySessionRouter } from '../sticky-routing.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const lifetime = createTestLifetimeSuite()
const { test } = lifetime

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'locked-publication-'))
  lifetime.deferCleanup(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function replaceLease(path: string, name: string) {
  // Replace the lock file to simulate another process taking over the lease,
  // without mocking the original holder's ownership check. Keep the successor's
  // lease held until the original operation has settled.
  await rm(lockPathFor(path, name))
  const successor = await acquireRefreshFileLock({
    path,
    name,
    ttlMs: 30_000,
    renew: true,
  })
  if (!successor)
    throw new Error('Successor did not acquire the replaced lease')
  lifetime.deferCleanup(() => successor.release())
  return successor
}

test('sticky queued touch refuses a replaced lease and preserves successor assignments', async () => {
  const path = join(await fixture(), 'routing.json')
  let now = Date.now()
  const router = new StickySessionRouter({ path, now: () => now })
  const input = {
    sessionId: 'original-session',
    family: 'general' as const,
    candidates: [
      {
        accountId: 'original-account',
        order: 0,
        quota: { kind: 'unknown' as const },
      },
    ],
    retainAccountIds: new Set(['original-account']),
    storage: null,
    inputBytes: 1,
  }
  await router.resolve(input)
  const entered = lifetime.gate()
  const resume = lifetime.gate()
  // Pause the read after it captures routing state while the lock is held.
  const seam = router as unknown as {
    readState(): Promise<unknown>
    touchChain: Promise<void>
  }
  const readState = seam.readState.bind(router)
  seam.readState = async () => {
    const state = await readState()
    entered.open()
    await resume.wait
    return state
  }
  now += 60 * 60_000
  await router.resolve(input)
  lifetime.trackDetached(seam.touchChain)
  await entered.wait
  const successor = await replaceLease(path, 'write')
  const state = JSON.parse(await readFile(path, 'utf8'))
  const originalKey = createHash('sha256').update(input.sessionId).digest('hex')
  const successorKey = createHash('sha256')
    .update('successor-session')
    .digest('hex')
  state.assignments[successorKey] = {
    ...state.assignments[originalKey],
    accountId: 'successor-account',
  }
  const published = `${JSON.stringify(state)}\n`
  await successor.assertOwned()
  await writeFile(path, published, { mode: 0o600 })
  resume.open()
  await seam.touchChain
  expect(await readFile(path, 'utf8')).toBe(published)
  await successor.assertOwned()
})

test('sticky writes publish normally while their lease remains owned', async () => {
  const path = join(await fixture(), 'routing.json')
  const router = new StickySessionRouter({ path })
  expect(
    await router.resolve({
      sessionId: 'session',
      family: 'general',
      candidates: [
        { accountId: 'account', order: 0, quota: { kind: 'unknown' as const } },
      ],
      retainAccountIds: new Set(['account']),
      storage: null,
      inputBytes: 1,
    }),
  ).toMatchObject({ accountId: 'account', created: true })
  await router.clear('session')
  expect(JSON.parse(await readFile(path, 'utf8')).assignments).toEqual({})
})

test('enrollment reconcile refuses a replaced lease and preserves successor state', async () => {
  const paths = getClaustrumEnrollmentPaths(join(await fixture(), 'token.json'))
  const entered = lifetime.gate()
  const resume = lifetime.gate()
  const manager = new ClaustrumEnrollmentManager({
    paths,
    proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
    client: {
      enrollPropose: async () => {
        entered.open()
        await resume.wait
        return { requestId: 'stale-request' }
      },
      enrollPoll: async () => ({ status: 'pending' }),
    },
  })
  const running = manager.reconcile().catch((error: unknown) => error)
  lifetime.trackDetached(running)
  await entered.wait
  const successor = await replaceLease(paths.statePath, 'ceremony')
  const published = `${JSON.stringify({
    version: 1,
    phase: 'blocked',
    proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
    errorCode: 'superseded',
    updatedAt: Date.now(),
  })}\n`
  await successor.assertOwned()
  await writeFile(paths.statePath, published, { mode: 0o600 })
  resume.open()
  const outcome = await running
  // Check file bytes before the error so an overwrite of the successor's
  // state is reported as a byte mismatch, not just a missing refusal.
  expect(await readFile(paths.statePath, 'utf8')).toBe(published)
  expect(outcome).toBeInstanceOf(Error)
  expect((outcome as Error).message).toBe(
    'Account file lock ownership was lost',
  )
  await successor.assertOwned()
})

test('enrollment token publication refuses lease loss during token staging', async () => {
  const directory = await fixture()
  const paths = getClaustrumEnrollmentPaths(join(directory, 'token.json'))
  const entered = lifetime.gate()
  const resume = lifetime.gate()
  const manager = new ClaustrumEnrollmentManager({
    paths,
    proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
    client: {
      enrollPropose: async () => ({ requestId: 'request' }),
      enrollPoll: async () => ({
        status: 'approved',
        name: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        token: '01'.repeat(32),
        tokenGeneration: 1,
      }),
    },
    writeTokenFile: async (path, value) => {
      entered.open()
      await resume.wait
      await writeEnrollmentTokenFile(path, value)
    },
  })
  const running = manager.reconcile().catch((error: unknown) => error)
  lifetime.trackDetached(running)
  await entered.wait
  const successor = await replaceLease(paths.statePath, 'ceremony')
  const token = { token: '02'.repeat(32), token_generation: 2 }
  await writeEnrollmentTokenFile(paths.tokenPath, token)
  const state = await readFile(paths.statePath, 'utf8')
  resume.open()
  const outcome = await running
  expect(JSON.parse(await readFile(paths.tokenPath, 'utf8'))).toEqual(token)
  expect(await readFile(paths.statePath, 'utf8')).toBe(state)
  expect(outcome).toBeInstanceOf(Error)
  expect((outcome as Error).message).toBe(
    'Account file lock ownership was lost',
  )
  expect(
    (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
  ).toEqual([])
  await successor.assertOwned()
})

for (const kind of ['main', 'fallback'] as const) {
  test(`${kind} quota completion refuses a replaced lease before updating cache or callbacks`, async () => {
    const path = join(await fixture(), 'accounts.json')
    const previous = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = path
    lifetime.deferCleanup(() => {
      if (previous === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
      else process.env.OPENCODE_ANTHROPIC_AUTH_FILE = previous
    })
    const entered = lifetime.gate()
    const resume = lifetime.gate()
    let callbacks = 0
    const manager = new QuotaManager({
      storage: null,
      fetchQuotaSnapshot: async () => {
        entered.open()
        await resume.wait
        return { checkedAt: Date.now() }
      },
      onMainQuotaFetched: () => {
        callbacks++
      },
      onFallbackQuotaFetched: () => {
        callbacks++
      },
    })
    lifetime.deferCleanup(() => manager.close())
    const running = (
      kind === 'main'
        ? manager.refreshMainWithMetadata('account', 'synthetic-token')
        : manager.refreshFallbackWithMetadata(
            'account',
            'synthetic-token',
            undefined,
          )
    ).catch((error: unknown) => error)
    lifetime.trackDetached(running)
    await entered.wait
    const successor = await replaceLease(
      path,
      kind === 'main'
        ? 'opencode-main-quota-refresh'
        : 'opencode-fallback-quota-refresh-account',
    )
    resume.open()
    const outcome = await running
    expect(callbacks).toBe(0)
    expect(
      kind === 'main'
        ? manager.getMain('account')
        : manager.getFallback('account'),
    ).toBeNull()
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe(
      'Account file lock ownership was lost',
    )
    await successor.assertOwned()
  })
}

test('runtime publication rechecks its lease after the asynchronous publication hook', async () => {
  const path = join(await fixture(), 'runtime.json')
  const storageId = 'a'.repeat(64)
  const entered = lifetime.gate()
  const resume = lifetime.gate()
  const running = updateNativeRuntime(path, storageId, (state) => state, {
    beforePublish: async () => {
      entered.open()
      await resume.wait
    },
  }).catch((error: unknown) => error)
  lifetime.trackDetached(running)
  await entered.wait
  const successor = await replaceLease(path, 'native-runtime')
  const published = `${JSON.stringify({
    version: 1,
    storageId,
    accounts: {
      successor: {
        binding: {
          kind: 'local',
          storageId,
          rowId: 'successor',
          credentialEpoch: 1,
        },
      },
    },
  })}\n`
  await successor.assertOwned()
  await writeFile(path, published, { mode: 0o600 })
  resume.open()
  const outcome = await running
  expect(await readFile(path, 'utf8')).toBe(published)
  expect(outcome).toMatchObject({ code: 'publication-refused' })
  await successor.assertOwned()
})
