import { expect, test as registerTest } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  createNativePoolStore,
  getLogLevel,
  resolveNativePoolPaths,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { closePiNativeRuntime } from '../native.ts'
import { streamCortexKitAnthropic } from '../stream.ts'
import { saveNativePiFixture } from './native-fixture.ts'
import { trackPiTestBody } from './setup.ts'

/*
 * Pi fallback-first serving while another writer is between the two file
 * writes that record a fallback's first account UUID. The request must wait
 * for that write and use the fallback, or fail retryably; it must never be
 * sent through main instead.
 */

const model: Model<Api> = {
  id: 'claude-sonnet-4-6',
  name: 'Sonnet',
  provider: 'anthropic',
  api: 'cortexkit-anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 200_000,
  maxTokens: 8_000,
}
const context: Context = {
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  tools: [],
}
const MAIN_ACCESS = 'sk-ant-oat01-pi-transient-main-access'
const FALLBACK_ACCESS = 'sk-ant-oat01-pi-transient-fallback-access'
const FALLBACK_UUID = '22222222-3333-4444-8555-666666666666'
const success = () =>
  new Response(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  )
const lifetimes = createTestLifetimeSuite()
const { deferCleanup, gate, trackDetached } = lifetimes
const test = (name: string, body: () => unknown) =>
  registerTest(
    name,
    lifetimes.wrapBody(() =>
      trackPiTestBody(Promise.resolve().then(() => body())),
    ),
  )

const originalFetch = globalThis.fetch

/**
 * A Pi installation owned by the current test body: a migrated pool with a
 * validated main, a fallback without an account UUID, fallback-first
 * routing, and a synthetic provider. Everything it changes is restored by
 * the body's lifetime.
 */
async function piFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pi-native-transient-'))
  const storagePath = join(directory, 'anthropic-auth.json')
  const savedEnv = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_ANTHROPIC_AUTH_FILE: process.env.PI_ANTHROPIC_AUTH_FILE,
  }
  deferCleanup(async () => {
    globalThis.fetch = originalFetch
    closePiNativeRuntime(storagePath)
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  })
  process.env.PI_CODING_AGENT_DIR = directory
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  await saveNativePiFixture(
    {
      version: 1,
      routing: { mode: 'fallback-first' },
      quota: { enabled: false },
      accounts: [],
    },
    storagePath,
    { mainAccess: MAIN_ACCESS },
  )
  // A fallback without an account UUID, as offline migration leaves one.
  const store = createNativePoolStore({
    paths: await resolveNativePoolPaths(storagePath),
    quota: nativeQuotaCodec,
  })
  await store.add({
    id: 'unknown-fallback',
    credential: {
      type: 'oauth',
      access: FALLBACK_ACCESS,
      refresh: 'pi-transient-fallback-refresh',
      expires: Date.now() + 3_600_000,
    },
  })
  const sent: string[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = input instanceof Request ? input.url : input.toString()
      const authorization = new Headers(init?.headers).get('authorization')
      if (url.includes('/api/claude_cli/bootstrap'))
        return Response.json({
          oauth_account: {
            account_uuid: authorization?.includes(FALLBACK_ACCESS)
              ? FALLBACK_UUID
              : undefined,
          },
        })
      if (url.includes('/v1/messages')) {
        sent.push(authorization ?? '')
        return success()
      }
      throw new Error(`Unexpected synthetic provider path: ${url}`)
    },
    { preconnect: originalFetch.preconnect },
  )
  return { storagePath, sent }
}

/**
 * Hold a real pool-store refresh of the fallback that records its first
 * account UUID, after its state-file write and before its config-file write.
 * Both gates belong to the test lifetime, so teardown releases the held
 * write even if the body times out.
 */
async function holdFirstIdentityWrite(storagePath: string) {
  const reached = gate()
  const release = gate()
  let held = false
  const producer = createNativePoolStore({
    paths: await resolveNativePoolPaths(storagePath),
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

function noop() {}

/** Collect native-auth outcomes and signal when the request reports that it is waiting for the writer. */
function watchJoin() {
  const waiting = gate()
  const outcomes: unknown[] = []
  const previousLevel = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record) => {
    if (record.channel !== 'native-auth') return
    if (record.payload?.phase === 'waiting') waiting.open()
    if (record.payload?.outcome !== undefined)
      outcomes.push(record.payload.outcome)
  })
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
  })
  return { waiting: waiting.wait, outcomes }
}

test('Pi fallback-first waits for the held write and sends through the fallback it chose', async () => {
  const f = await piFixture()
  const join = watchJoin()
  const held = await holdFirstIdentityWrite(f.storagePath)
  const result = streamCortexKitAnthropic(model, context, {
    apiKey: 'synthetic-host-access',
  }).result()
  trackDetached(result)
  const first = await Promise.race([
    join.waiting.then(() => 'waiting' as const),
    result.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
  ])
  expect(first).toBe('waiting')
  held.release()
  const [written] = await Promise.allSettled([held.write])
  const [message] = await Promise.allSettled([result])
  expect(written.status).toBe('fulfilled')
  expect(message).toMatchObject({
    status: 'fulfilled',
    value: { stopReason: 'stop' },
  })
  expect(f.sent).toEqual([`Bearer ${FALLBACK_ACCESS}`])
  expect(join.outcomes).toEqual(['joined'])
})

test('Pi fails the request retryably and sends nothing while the write stays unfinished', async () => {
  const f = await piFixture()
  const join = watchJoin()
  const held = await holdFirstIdentityWrite(f.storagePath)
  const result = streamCortexKitAnthropic(model, context, {
    apiKey: 'synthetic-host-access',
  }).result()
  trackDetached(result)
  const [message] = await Promise.allSettled([result])
  held.release()
  const [written] = await Promise.allSettled([held.write])
  expect(message).toMatchObject({
    status: 'fulfilled',
    value: {
      stopReason: 'error',
      errorMessage: 'Anthropic account update in progress; retry the request',
    },
  })
  expect(f.sent).toEqual([])
  // One wait, at the fallback quota probe: the probe surfaces the error
  // instead of dropping the fallback and trying again later.
  expect(join.outcomes).toEqual(['deadline'])
  expect(written.status).toBe('fulfilled')
})
