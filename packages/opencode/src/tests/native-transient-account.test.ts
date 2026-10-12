import { expect } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  __setLogTestSink,
  createNativeAccountRuntime,
  createNativePoolStore,
  getLogLevel,
  isNativeTransientAccountError,
  type ProviderAccountUuid,
  resolveNativePoolPaths,
  runNativeMigration,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { createNativeAnthropicSource } from '../v2/source'

/*
 * OpenCode 2 account selection while another writer is between the two file
 * writes that record a fallback's first account UUID. The fallback is the
 * account fallback-first routing chooses, so selection must wait for that
 * write and choose it, or fail retryably; it must never choose main instead.
 */

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()

const MAIN_UUID = '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid
const FALLBACK_UUID =
  '22222222-3333-4444-8555-666666666666' as ProviderAccountUuid
const MAIN_ACCESS = 'sk-ant-oat01-oc2-main-access'
const FALLBACK_ACCESS = 'sk-ant-oat01-oc2-fallback-access'
const scope = {
  providerID: 'anthropic',
  modelID: 'claude-sonnet-5',
  sessionID: 'ses_native_oc2_transient',
  agent: 'build',
  kind: 'primary' as const,
}

function noop() {}

async function fixture() {
  const parent = resolve(
    import.meta.dir,
    '../../../../node_modules/.cache/opencode2-native-transient',
  )
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'fixture-'))
  deferCleanup(() => rm(directory, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(directory, 'anthropic-auth.json'),
    join(directory, 'anthropic-auth-state.json'),
  )
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({ version: 1, accounts: [] }),
    { mode: 0o600 },
  )
  await writeFile(
    paths.legacyState,
    JSON.stringify({ version: 1, accounts: {} }),
    { mode: 0o600 },
  )
  await runNativeMigration({
    paths,
    host: 'opencode',
    hostAuthPath: join(directory, 'auth.json'),
    routingSourcePath: join(directory, 'legacy-routing.json'),
    routingDestinationPath: join(directory, 'native-routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  const expires = Date.now() + 3_600_000
  await store.add({
    id: 'primary-row',
    identity: MAIN_UUID,
    credential: {
      type: 'oauth',
      access: MAIN_ACCESS,
      refresh: 'oc2-main-refresh',
      expires,
    },
  })
  // A fallback without an account UUID, as offline migration leaves one.
  await store.add({
    id: 'unknown-fallback',
    credential: {
      type: 'oauth',
      access: FALLBACK_ACCESS,
      refresh: 'oc2-fallback-refresh',
      expires,
    },
  })
  await store.updateSettings(() => ({
    mainAccountId: 'primary-row',
    quota: { enabled: false },
    routing: { mode: 'fallback-first' },
  }))
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          directory,
          'opencode-enrollment.json',
        ),
      },
    },
    local: {
      resolveIdentity: async (access) => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: access === MAIN_ACCESS ? MAIN_UUID : FALLBACK_UUID,
      }),
      refreshToken: async () => {
        throw new Error('unexpected token exchange')
      },
    },
  })
  deferCleanup(() => runtime.close())
  // Validate main once, so selecting it later needs no metadata write (which
  // would wait on the pool locks the held write keeps).
  const main = await runtime.authorizeLocal('main')
  if (main.status !== 'usable') throw new Error('main was not admitted')
  const source = createNativeAnthropicSource({
    runtime,
    paths,
    requestOptions: () => ({}),
    resolveModelId: async (input) => input.modelID,
  })
  deferCleanup(() => source.close())
  return { paths, runtime, source }
}

/** Pause a real refresh that records the fallback's first UUID, after its state write and before its config write. */
async function holdFirstIdentityWrite(paths: {
  config: string
  state: string
}) {
  const reached = gate()
  const release = gate()
  let held = false
  const producer = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    onStep: async (step, info) => {
      if (
        held ||
        step !== 'after-state-write' ||
        info.operation !== 'refresh' ||
        info.rowId !== 'unknown-fallback'
      )
        return
      held = true
      reached.open()
      await release.wait
    },
  })
  const write = producer.refresh('unknown-fallback', async (credential) => {
    if (credential.access !== FALLBACK_ACCESS)
      throw new Error('the fallback row does not hold the fixture token')
    return {
      access: credential.access,
      refresh: credential.refresh,
      expires: Date.now() + 8 * 3_600_000,
      identity: FALLBACK_UUID,
    }
  })
  trackDetached(write)
  await Promise.race([reached.wait, write.then(noop, noop)])
  expect(held).toBe(true)
  return { write, release: release.open }
}

function watchJoin() {
  const waiting = gate()
  const previousLevel = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record) => {
    if (record.channel === 'native-auth' && record.payload?.phase === 'waiting')
      waiting.open()
  })
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
  })
  return waiting.wait
}

test('OpenCode 2 fallback-first selection waits for the held write and chooses the fallback', async () => {
  const f = await fixture()
  const waiting = watchJoin()
  const held = await holdFirstIdentityWrite(f.paths)
  const choosing = Promise.resolve(f.source.chooseAccount(scope))
  trackDetached(choosing.then(noop, noop))
  const first = await Promise.race([
    waiting.then(() => 'waiting' as const),
    choosing.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
  ])
  expect(first).toBe('waiting')
  held.release()
  const [written] = await Promise.allSettled([held.write])
  const [chosen] = await Promise.allSettled([choosing])
  expect(written.status).toBe('fulfilled')
  expect(chosen).toEqual({ status: 'fulfilled', value: 'unknown-fallback' })
  const [material] = await Promise.allSettled([
    f.source.authorizeAccount(scope, 'unknown-fallback'),
  ])
  expect(material).toMatchObject({
    status: 'fulfilled',
    value: { route: 'oauth', accessToken: FALLBACK_ACCESS },
  })
})

test('OpenCode 2 selection fails retryably, choosing no other account, while the write stays unfinished', async () => {
  const f = await fixture()
  const held = await holdFirstIdentityWrite(f.paths)
  const [chosen] = await Promise.allSettled([f.source.chooseAccount(scope)])
  expect(chosen.status).toBe('rejected')
  const error = chosen.status === 'rejected' ? chosen.reason : null
  expect(isNativeTransientAccountError(error)).toBe(true)
  expect(error).toMatchObject({ code: 'ECONNRESET' })
  held.release()
  const [written] = await Promise.allSettled([held.write])
  expect(written.status).toBe('fulfilled')
})
