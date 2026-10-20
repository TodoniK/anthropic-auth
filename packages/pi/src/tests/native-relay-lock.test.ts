import { expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeAccountRuntime,
  createNativePoolStore,
  resolveNativePoolPaths,
} from '@cortexkit/anthropic-auth-core'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { holdNativeRelayLock } from '../../../core/src/tests/native-relay-lock-fixture.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { MockRelayServer } from '../../../e2e-tests/src/mock-relay.ts'
import { closePiNativeRuntime } from '../native.ts'
import { streamCortexKitAnthropic } from '../stream.ts'
import { saveNativePiFixture } from './native-fixture.ts'
import { trackPiTestBody } from './setup.ts'

const lifetimes = createTestLifetimeSuite()
const model: Model<Api> = {
  id: 'claude-fable-5-1',
  name: 'Fable',
  provider: 'anthropic',
  api: 'cortexkit-anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
}
const context: Context = {
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  tools: [],
}
for (const scenario of ['direct', 'relay', 'inconsistent'] as const) {
  const configured = scenario !== 'direct'
  lifetimes.test(
    scenario === 'inconsistent'
      ? 'Pi inconsistent relay pair refuses locally without any dispatch'
      : `Pi request ignores held native-relay lock (${scenario})`,
    () =>
      trackPiTestBody(
        (async () => {
          const directory = await mkdtemp(join(tmpdir(), 'pi-held-relay-'))
          const storagePath = join(directory, 'anthropic-auth.json')
          const originalFetch = globalThis.fetch
          const saved = {
            PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
            PI_ANTHROPIC_AUTH_FILE: process.env.PI_ANTHROPIC_AUTH_FILE,
            OPENCODE_ANTHROPIC_AUTH_STATE_FILE:
              process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE,
          }
          const relay = new MockRelayServer()
          lifetimes.deferCleanup(async () => {
            await closePiNativeRuntime(storagePath)
            relay.stop()
            globalThis.fetch = originalFetch
            for (const [key, value] of Object.entries(saved)) {
              if (value === undefined) delete process.env[key]
              else process.env[key] = value
            }
            await rm(directory, { recursive: true, force: true })
          })
          process.env.PI_CODING_AGENT_DIR = directory
          process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
          await saveNativePiFixture(
            { version: 1, accounts: [], quota: { enabled: false } },
            storagePath,
            {
              mainAccess: 'sk-ant-oat01-synthetic-held-access',
            },
          )
          const paths = await resolveNativePoolPaths(storagePath)
          const runtime = createNativeAccountRuntime({ paths, host: 'pi' })
          lifetimes.deferCleanup(() => runtime.close())
          const address = await relay.start({
            token: 'synthetic-held-relay-token',
          })
          if (configured)
            await runtime.updateRelay({
              enabled: true,
              url: address.url,
              token: 'synthetic-held-relay-token',
              transport: 'http',
              fallbackToDirect: false,
            })
          let upstream = 0
          globalThis.fetch = Object.assign(
            async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const url =
                input instanceof Request ? input.url : input.toString()
              if (url.startsWith(address.url)) return originalFetch(input, init)
              if (!url.includes('/v1/messages')) return Response.json({})
              upstream++
              return new Response(
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
              )
            },
            { preconnect: originalFetch.preconnect },
          )
          if (scenario === 'inconsistent')
            await createNativePoolStore({
              paths,
              quota: nativeQuotaCodec,
            }).updateSettings((settings) => {
              ;(settings.relay as Record<string, unknown>).generation =
                'mismatched'
            })
          const held = await holdNativeRelayLock(paths.config, lifetimes)
          try {
            const result = await streamCortexKitAnthropic(model, context, {
              sessionId: `held-relay-${scenario}-${directory}`,
            }).result()
            if (scenario === 'inconsistent') {
              expect(result.stopReason).toBe('error')
              expect(result.errorMessage).toBe(
                'request refused: relay configuration is inconsistent; no request was sent',
              )
              expect(relay.acceptedRequests()).toBe(0)
              expect(upstream).toBe(0)
              return
            }
            expect(result.stopReason).toBe('stop')
            expect(relay.acceptedRequests()).toBe(configured ? 1 : 0)
            // The loopback relay forwards through the same mocked fetch.
            expect(upstream).toBe(1)
            expect(await runtime.getRelayConfig()).toEqual(
              configured
                ? {
                    enabled: true,
                    url: address.url,
                    token: 'synthetic-held-relay-token',
                    transport: 'http',
                    fallbackToDirect: false,
                  }
                : null,
            )
            await held.assertOwned()
          } finally {
            await held.pastTimeout
            await held.release()
          }
        })(),
      ),
    25_000,
  )
}
