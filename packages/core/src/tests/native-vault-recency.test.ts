import { expect, spyOn } from 'bun:test'
import * as filesystem from 'node:fs/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { lockPathFor } from '@cortexkit/common-auth/fs'
import type {
  NativeCustodyClient,
  NativeCustodyReceipt,
} from '../native-custody.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import {
  isNativeRuntimeStagingName,
  NativeRuntimeError,
  type NativeRuntimeState,
  readNativeRuntime,
  updateNativeRuntime,
  updateNativeRuntimeOptional,
} from '../native-runtime.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import {
  createNativeVaultRuntime,
  type NativeVaultRuntime,
} from '../native-vault-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555'
const uuid2 = '22222222-2222-4333-8444-555555555555'
const id = 'oauth:anthropic'
const now = 1_000_000
// The lock name common-auth's mutateVaultRoster holds while a vault runtime
// write is staged. The lease-refusal case asserts this lock file exists before
// replacing its owner, so a renamed lock fails that assertion instead of
// silently testing nothing.
const rosterWriteLock = 'claustrum-roster-write'
type Row = Awaited<
  ReturnType<NativeCustodyClient['listScoped']>
>['rows'][number]

function listing(recordVersion: number): Row {
  return {
    id,
    accountId: uuid,
    credentialType: 'oauth',
    categories: ['anthropic-native'],
    refreshAdapter: 'anthropic',
    serves: ['anthropic'],
    providerIds: [],
    state: 'active',
    operations: ['read'],
    recordVersion,
    createdAtMs: null,
  }
}

async function readBytes(path: string): Promise<Buffer | undefined> {
  return readFile(path).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined
    throw error
  })
}

/**
 * A vault enrollment whose synthetic Claustrum client serves one credential.
 * `advance` moves both the scoped listing and the served credential to a new
 * record version and runs discovery, as a vault rotation would.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-vault-recency-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(join(root, 'anthropic-auth.json'))
  await initializeNativeTestAuthority(paths)
  const vaultPaths = nativeVaultPaths(paths)
  const enrollmentFile = join(root, 'opencode-enrollment.json')
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: enrollmentFile,
  }
  await writeFile(
    enrollmentFile,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const store = createNativePoolStore({
    paths: vaultPaths,
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  let version = 1
  let rows: readonly Row[] = [listing(version)]
  const client: NativeCustodyClient = {
    listScoped: async () => ({ view: `view-${rows[0]?.recordVersion}`, rows }),
    getScoped: async (input) => ({
      credentialId: input.credentialId,
      accountId: rows.find((row) => row.id === input.credentialId)?.accountId,
      material: `synthetic-bearer-${version}`,
      recordVersion: version,
      expiresAtMs: now + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
  const options = {
    paths,
    host: 'opencode' as const,
    env,
    now: () => now,
    connect: async () => client,
    readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
  }
  const runtime = createNativeVaultRuntime(options)
  deferCleanup(() => runtime.close())
  return {
    vaultPaths,
    enrollmentFile,
    options,
    runtime,
    store,
    async advance(next: number, target: NativeVaultRuntime = runtime) {
      version = next
      rows = [listing(next)]
      const roster = await target.refresh()
      expect(roster?.rows.map((row) => row.credentialId)).toEqual([id])
    },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/**
 * Pause the next vault runtime write after it opens its staging file, which is
 * after the writer's in-lock change and before its final checks and rename.
 * Other files, including lock owner files, open normally.
 */
function holdNextRuntimeStage(runtimePath: string) {
  const staged = gate()
  const release = gate()
  let holds = 0
  const original = filesystem.open
  const spy = spyOn(filesystem, 'open').mockImplementation(
    async (path, flags, mode) => {
      if (
        holds === 0 &&
        typeof path === 'string' &&
        dirname(path) === dirname(runtimePath) &&
        isNativeRuntimeStagingName(runtimePath, basename(path))
      ) {
        holds++
        staged.open()
        await release.wait
      }
      return original(path, flags, mode)
    },
  )
  deferCleanup(() => spy.mockRestore())
  return {
    staged: staged.wait,
    holds: () => holds,
    release() {
      spy.mockRestore()
      release.open()
    },
  }
}

/**
 * Model a host that has already received an authorized 200 response and
 * records when the account was last used before returning it. The recency
 * write for receipt version 1 is held at its staged file while the same
 * runtime discovers and authorizes version 2; `interfere` then changes
 * something else before the write resumes.
 */
async function recencyOvertakenBeforeRename(
  f: Fixture,
  patch: Parameters<NativeVaultRuntime['publish']>[1],
  interfere: () => Promise<void> = async () => {},
) {
  const first = await f.runtime.authorize('main')
  expect(first.recordVersion).toBe(1)
  expect(first.accessToken).toBe('synthetic-bearer-1')
  expect(await f.runtime.publish(first, { lastUsed: now })).toBe(true)
  await f.advance(2)
  const runtimeBefore = await readBytes(f.vaultPaths.runtime)
  const rosterBefore = await readBytes(f.vaultPaths.roster)
  expect(runtimeBefore).toBeDefined()
  expect(rosterBefore).toBeDefined()
  const hold = holdNextRuntimeStage(f.vaultPaths.runtime)
  const response = (async () => {
    const response = new Response('authorized body', { status: 200 })
    const recorded = await f.runtime.publish(first, patch)
    return { response, recorded }
  })()
  const settled = Promise.allSettled([response])
  // Register the write with the test lifetime before anything below can
  // throw, so a body that fails or times out still waits for it before the
  // fixture's files are removed.
  trackDetached(settled)
  let successor: NativeCustodyReceipt
  try {
    // Wait for the hold or for the write to finish without reaching it; the
    // hold count below turns the second case into an assertion failure.
    await Promise.race([hold.staged, settled])
    expect(hold.holds()).toBe(1)
    successor = await f.runtime.authorize('main')
    await interfere()
  } finally {
    // Resume the held write and wait for it on every path, so a failed
    // assertion or interference never leaves it running past this helper.
    hold.release()
    await settled
  }
  const [outcome] = await settled
  expect(successor.recordVersion).toBe(2)
  expect(successor.accessToken).toBe('synthetic-bearer-2')
  expect(successor.credentialId).toBe(first.credentialId)
  expect(successor.assertedAccountIdentity).toBe(uuid)
  return { first, successor, outcome, runtimeBefore, rosterBefore }
}

async function runtimeEntry(f: Fixture) {
  const read = await readNativeRuntime(
    f.vaultPaths.runtime,
    f.vaultPaths.storageId,
  )
  if (read.status !== 'ready') throw new Error('Missing fixture runtime')
  const entries = Object.values(read.state.accounts)
  expect(entries).toHaveLength(1)
  return entries[0]
}

function expectRefused(outcome: PromiseSettledResult<unknown>) {
  expect(outcome.status).toBe('rejected')
  const reason = outcome.status === 'rejected' ? outcome.reason : undefined
  expect(reason).toBeInstanceOf(NativeRuntimeError)
  expect(reason).toMatchObject({ code: 'publication-refused' })
}

async function stagingLeftovers(runtimePath: string) {
  return (await filesystem.readdir(dirname(runtimePath))).filter((name) =>
    isNativeRuntimeStagingName(runtimePath, name),
  )
}

test('a lastUsed write overtaken by a newer vault receipt before its final rename resolves false and keeps the response', async () => {
  const f = await fixture()
  const held = await recencyOvertakenBeforeRename(f, { lastUsed: now + 5 })
  expect(held.outcome.status).toBe('fulfilled')
  const delivered =
    held.outcome.status === 'fulfilled' ? held.outcome.value : undefined
  expect(delivered?.recorded).toBe(false)
  expect(delivered?.response.status).toBe(200)
  expect(await delivered?.response.text()).toBe('authorized body')
  expect(await readBytes(f.vaultPaths.runtime)).toEqual(held.runtimeBefore)
  expect(await readBytes(f.vaultPaths.roster)).toEqual(held.rosterBefore)
  expect(await stagingLeftovers(f.vaultPaths.runtime)).toEqual([])
  expect(await runtimeEntry(f)).toMatchObject({
    binding: { recordVersion: 1 },
    lastUsed: now,
  })
  // The successor records its own use. A later version 1 write is then
  // dropped by the early version check and leaves the successor untouched.
  expect(await f.runtime.publish(held.successor, { lastUsed: now + 6 })).toBe(
    true,
  )
  const successorBytes = await readBytes(f.vaultPaths.runtime)
  expect(await runtimeEntry(f)).toMatchObject({
    binding: { recordVersion: 2 },
    lastUsed: now + 6,
  })
  expect(await f.runtime.publish(held.first, { lastUsed: now + 7 })).toBe(false)
  expect(await readBytes(f.vaultPaths.runtime)).toEqual(successorBytes)
})

test('a lastUsed write behind a newer persisted vault entry resolves false without changing it', async () => {
  const f = await fixture()
  const first = await f.runtime.authorize('main')
  expect(first.recordVersion).toBe(1)
  // Another process discovers and records version 2. This runtime has issued
  // only version 1, so its write passes the early check and meets the newer
  // entry inside the runtime lock instead.
  const peer = createNativeVaultRuntime(f.options)
  deferCleanup(() => peer.close())
  await f.advance(2, peer)
  const successor = await peer.authorize('main')
  expect(successor.recordVersion).toBe(2)
  expect(successor.accessToken).toBe('synthetic-bearer-2')
  expect(await peer.publish(successor, { lastUsed: now + 6 })).toBe(true)
  const before = await readBytes(f.vaultPaths.runtime)
  const [outcome] = await Promise.allSettled([
    f.runtime.publish(first, { lastUsed: now + 7 }),
  ])
  expect(outcome).toEqual({ status: 'fulfilled', value: false })
  expect(await readBytes(f.vaultPaths.runtime)).toEqual(before)
  expect(await runtimeEntry(f)).toMatchObject({
    binding: { recordVersion: 2 },
    lastUsed: now + 6,
  })
})

test('mixed metadata overtaken before its final rename still refuses publication', async () => {
  const f = await fixture()
  const held = await recencyOvertakenBeforeRename(f, {
    lastUsed: now + 5,
    quotaErrorClearedAt: now,
  })
  expectRefused(held.outcome)
  expect(await readBytes(f.vaultPaths.runtime)).toEqual(held.runtimeBefore)
  expect(await stagingLeftovers(f.vaultPaths.runtime)).toEqual([])
})

const fatalDuringHold: ReadonlyArray<
  readonly [string, (f: Fixture) => Promise<void>]
> = [
  [
    'account replacement',
    async (f) => {
      const replaced = await f.store.updateSettings((settings) => {
        settings.claustrum = {
          primaryAccount: { credentialId: id, accountId: uuid2 },
        }
      })
      expect(replaced.outcome).toBe('updated')
    },
  ],
  ['custody loss', (f) => rm(f.enrollmentFile)],
  [
    'roster lease refusal',
    async (f) => {
      const lock = lockPathFor(f.vaultPaths.roster, rosterWriteLock)
      const owner: unknown = JSON.parse(await readFile(lock, 'utf8'))
      expect(owner).toMatchObject({ ownerId: expect.any(String) })
      await writeFile(
        lock,
        `${JSON.stringify({ ownerId: 'synthetic-other-owner', expiresAt: 0 })}\n`,
      )
    },
  ],
]

for (const [name, interfere] of fatalDuringHold)
  test(`${name} while an overtaken lastUsed write is staged still refuses publication`, async () => {
    const f = await fixture()
    const held = await recencyOvertakenBeforeRename(
      f,
      { lastUsed: now + 5 },
      () => interfere(f),
    )
    expectRefused(held.outcome)
    expect(await readBytes(f.vaultPaths.runtime)).toEqual(held.runtimeBefore)
    expect(await stagingLeftovers(f.vaultPaths.runtime)).toEqual([])
  })

test('an optional runtime write publishes, withdraws without writing, or refuses by its final check', async () => {
  const f = await fixture()
  const { runtime: path, storageId } = f.vaultPaths
  const used = (lastUsed: number) => (current: NativeRuntimeState) => {
    current.accounts.route = {
      binding: {
        kind: 'custody',
        storageId,
        routeId: 'route',
        credentialId: id,
        accountIdentity: uuid,
        recordVersion: 1,
      },
      lastUsed,
    }
    return current
  }
  await updateNativeRuntime(path, storageId, used(now))
  const before = await readBytes(path)
  expect(
    await updateNativeRuntimeOptional(path, storageId, used(now + 1), {
      beforeRename: async () => 'skip',
    }),
  ).toEqual({ status: 'skipped' })
  expect(await readBytes(path)).toEqual(before)
  expect(await stagingLeftovers(path)).toEqual([])
  const [refused] = await Promise.allSettled([
    updateNativeRuntimeOptional(path, storageId, used(now + 2), {
      beforeRename: async () => {
        throw new Error('synthetic final check failure')
      },
    }),
  ])
  expectRefused(refused)
  expect(await readBytes(path)).toEqual(before)
  expect(await stagingLeftovers(path)).toEqual([])
  const published = await updateNativeRuntimeOptional(
    path,
    storageId,
    used(now + 3),
    { beforeRename: async () => 'publish' },
  )
  expect(published.status).toBe('published')
  expect(await runtimeEntry(f)).toMatchObject({ lastUsed: now + 3 })
})

test('a failure while a lastUsed write is held still waits for that write before the helper returns', async () => {
  const f = await fixture()
  const failure = new Error('synthetic interference failure')
  const [helper] = await Promise.allSettled([
    recencyOvertakenBeforeRename(f, { lastUsed: now + 5 }, async () => {
      // While the write is held it owns both locks; the checks after the
      // helper returns would otherwise pass for a lock that was never taken.
      expect(
        await readBytes(lockPathFor(f.vaultPaths.roster, rosterWriteLock)),
      ).toBeDefined()
      expect(
        await readBytes(lockPathFor(f.vaultPaths.runtime, 'native-runtime')),
      ).toBeDefined()
      throw failure
    }),
  ])
  expect(helper).toEqual({ status: 'rejected', reason: failure })
  // The held write owns the vault roster write lock and the runtime lock until
  // it finishes. Both lock files are gone only if the helper waited for it.
  expect(
    await readBytes(lockPathFor(f.vaultPaths.roster, rosterWriteLock)),
  ).toBeUndefined()
  expect(
    await readBytes(lockPathFor(f.vaultPaths.runtime, 'native-runtime')),
  ).toBeUndefined()
  expect(await stagingLeftovers(f.vaultPaths.runtime)).toEqual([])
  // The write resumed after version 2 was issued, so it was skipped.
  expect(await runtimeEntry(f)).toMatchObject({
    binding: { recordVersion: 1 },
    lastUsed: now,
  })
})
