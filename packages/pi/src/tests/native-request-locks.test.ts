import { expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getClaudeCodeIdentityForVerifiedAccount,
  type NativeCustodyClient,
} from '@cortexkit/anthropic-auth-core'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { requestLockProbe } from '../../../core/src/tests/native-request-lock-fixture.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import { streamCortexKitAnthropic } from '../stream.ts'
import {
  fixtureAccountIdentity,
  saveNativePiFixture,
} from './native-fixture.ts'
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
const quota = () => ({
  checkedAt: Date.now(),
  five_hour: {
    checkedAt: Date.now(),
    remainingPercent: 100,
    usedPercent: 0,
    resetsAt: new Date(Date.now() + 3600_000).toISOString(),
  },
  seven_day: {
    checkedAt: Date.now(),
    remainingPercent: 100,
    usedPercent: 0,
    resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
  },
})
for (const scenario of ['local-healthy', 'vault-healthy', 'refresh'] as const) {
  lifetimes.test(
    `Pi ${scenario} request observes only required foreground locks`,
    () =>
      trackPiTestBody(
        (async () => {
          const directory = await mkdtemp(join(tmpdir(), 'pi-request-locks-'))
          const storagePath = join(directory, 'anthropic-auth.json')
          const originalFetch = globalThis.fetch
          const keys = [
            'PI_CODING_AGENT_DIR',
            'PI_ANTHROPIC_AUTH_FILE',
            'PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
            'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
          ] as const
          const saved = new Map(keys.map((key) => [key, process.env[key]]))
          lifetimes.deferCleanup(async () => {
            await closePiNativeRuntime(storagePath)
            globalThis.fetch = originalFetch
            for (const [key, value] of saved) {
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
              accounts: [],
              routing: { mode: 'sticky-balanced' },
              quota: { enabled: false, mainQuota: quota() },
            },
            storagePath,
          )
          const probe = requestLockProbe()
          const identity = fixtureAccountIdentity('main')
          const client: NativeCustodyClient = {
            async listScoped() {
              return {
                view: 'ready-lock-proof',
                rows: [
                  {
                    id: 'oauth:anthropic',
                    accountId: identity,
                    credentialType: 'oauth',
                    categories: ['anthropic-native'],
                    serves: ['anthropic'],
                    providerIds: [],
                    refreshAdapter: 'anthropic',
                    operations: ['read'],
                    state: 'active',
                    recordVersion: 1,
                    createdAtMs: 1,
                  },
                ],
                grants: undefined,
                grantTuples: undefined,
              }
            },
            async getScoped() {
              return {
                credentialId: 'oauth:anthropic',
                accountId: identity,
                material: 'sk-ant-oat01-ready-vault',
                recordVersion: 1,
                expiresAtMs: Date.now() + 3600_000,
              }
            },
            async reportAuthFailureScoped() {},
            close() {},
          }
          if (scenario === 'vault-healthy') {
            const enrollment = join(directory, 'enrollment.json')
            process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = enrollment
            await writeFile(
              enrollment,
              JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
              { mode: 0o600 },
            )
          }
          const now = () => Date.now() + 2 * 3600_000
          const native = getPiNativeRuntime(storagePath, {
            vaultPoll: { intervalMs: 0 },
            ...(scenario === 'vault-healthy'
              ? { connect: async () => client }
              : {}),
            local: {
              onLockEvent: probe.onLockEvent,
              ...(scenario === 'refresh'
                ? {
                    now,
                    refreshToken: async () => ({
                      access: 'sk-ant-oat01-refreshed-control',
                      refresh: 'synthetic-control-refresh',
                      expires: now() + 3600_000,
                      expiresIn: 3600,
                    }),
                    resolveIdentity: async () =>
                      getClaudeCodeIdentityForVerifiedAccount('main', identity),
                  }
                : {}),
            },
          })
          const runtime = await native.service()
          if (scenario === 'vault-healthy') {
            await runtime.vault.refresh()
            await runtime.updateSettings((settings) => {
              settings.routing = { mode: 'sticky-balanced' }
              settings.quota = { enabled: false }
            })
            const receipt = await runtime.authorizeVault('main')
            await runtime.vault.publish(receipt, {
              quota: { ...quota(), accountIdentity: identity },
            })
          }
          await runtime.read()
          await runtime.drainRoutingPublications()
          globalThis.fetch = Object.assign(
            async (input: Parameters<typeof fetch>[0]) => {
              const url =
                input instanceof Request ? input.url : input.toString()
              if (!url.includes('/v1/messages')) return Response.json({})
              probe.dispatch()
              return new Response(
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
              )
            },
            { preconnect: originalFetch.preconnect },
          )
          probe.begin()
          const result = await streamCortexKitAnthropic(model, context, {
            sessionId: `lock-proof-${directory}`,
          }).result()
          expect(result.stopReason).toBe('stop')
          if (scenario === 'refresh')
            expect(
              probe.foreground.some((event) =>
                event.name.startsWith('native-account-provider-'),
              ),
            ).toBe(true)
          else expect(probe.foreground).toEqual([])
          await closePiNativeRuntime(storagePath)
          expect(probe.detached.some((event) => event.name === 'write')).toBe(
            true,
          )
          expect(probe.afterDispatch.length).toBeGreaterThan(0)
          expect(
            probe.afterDispatch.some(
              (event) => event.name === 'native-runtime',
            ),
          ).toBe(true)
          if (scenario === 'vault-healthy')
            expect(
              probe.afterDispatch.some(
                (event) => event.name === 'claustrum-roster-write',
              ),
            ).toBe(true)
        })(),
      ),
  )
}
