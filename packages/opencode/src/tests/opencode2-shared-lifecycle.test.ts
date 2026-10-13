import { expect, spyOn } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireNativeAccountRuntime,
  type NativeCustodyClient,
  resolveNativePoolPaths,
} from '@cortexkit/anthropic-auth-core'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { startNativeAnthropicLifecycle } from '../v2/lifecycle.ts'

const { test, deferCleanup, gate } = createTestLifetimeSuite()

test('OpenCode 2 lifecycles share discovery and retain the surviving account lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc2-shared-lifecycle-'))
  const paths = await resolveNativePoolPaths(join(root, 'anthropic-auth.json'))
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'enrollment.json',
    ),
  }
  await writeFile(
    env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const counts = { lists: 0, connects: 0, gets: 0, closes: 0 }
  const nextPoll = gate()
  const client: NativeCustodyClient = {
    async listScoped() {
      if (++counts.lists > 1) nextPoll.open()
      return {
        view: 'shared',
        rows: [
          {
            id: 'oauth:anthropic',
            accountId: '11111111-2222-4333-8444-555555555555',
            credentialType: 'oauth',
            categories: ['anthropic-native'],
            serves: ['anthropic'],
            providerIds: [],
            refreshAdapter: 'anthropic',
            operations: ['read'],
            state: 'active',
            recordVersion: 1,
            createdAtMs: null,
          },
        ],
      }
    },
    async getScoped(input) {
      return {
        credentialId: input.credentialId,
        accountId: '11111111-2222-4333-8444-555555555555',
        material: `fresh-${++counts.gets}`,
        recordVersion: 1,
        expiresAtMs: Date.now() + 3_600_000,
      }
    },
    async reportAuthFailureScoped() {},
    close() {
      counts.closes++
    },
  }
  const options = {
    paths,
    host: 'opencode' as const,
    vault: {
      env,
      connect: async () => {
        counts.connects++
        return client
      },
    },
  }
  const a = acquireNativeAccountRuntime(options)
  const b = acquireNativeAccountRuntime(options)
  const timers = new Set<ReturnType<typeof setInterval>>()
  const ready: Promise<void>[] = []
  const watches = [a, b].map((runtime) => {
    const watch = runtime.vault.watch.bind(runtime.vault)
    return spyOn(runtime.vault, 'watch').mockImplementation((options) => {
      const subscription = watch({
        ...options,
        intervalMs: 1000,
        setInterval: ((fn: () => void, ms: number) => {
          const timer = setInterval(fn, ms)
          timers.add(timer)
          return timer
        }) as typeof setInterval,
        clearInterval: ((timer: ReturnType<typeof setInterval>) => {
          timers.delete(timer)
          clearInterval(timer)
        }) as typeof clearInterval,
      })
      ready.push(subscription.ready)
      return subscription
    })
  })
  const transport = Object.assign(async () => Response.json({}), {
    preconnect: fetch.preconnect,
  }) as typeof fetch
  const first = startNativeAnthropicLifecycle(a, transport)
  const second = startNativeAnthropicLifecycle(b, transport)
  deferCleanup(async () => {
    await Promise.all([first.dispose(), second.dispose()])
    a.close()
    b.close()
    for (const watch of watches) watch.mockRestore()
    for (const timer of timers) clearInterval(timer)
    await rm(root, { recursive: true, force: true })
  })
  await Promise.all(ready)
  expect(counts.connects).toBe(1)
  expect(counts.lists).toBe(1)
  expect(timers.size).toBe(1)
  await first.dispose()
  a.close()
  a.close()
  expect(counts.closes).toBe(0)
  await nextPoll.wait
  expect(counts.lists).toBe(2)
  const one = await b.authorizeVault('main')
  const two = await b.authorizeVault('main')
  expect(two).not.toBe(one)
  expect(two.accessToken).not.toBe(one.accessToken)
  await second.dispose()
  b.close()
  expect(counts.closes).toBe(1)
  expect(timers.size).toBe(0)
}, 10_000)
