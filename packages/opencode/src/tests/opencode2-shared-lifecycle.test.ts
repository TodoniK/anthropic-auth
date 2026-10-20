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
import {
  recordedTimers,
  watchableVaultClient,
} from '../../../core/src/tests/vault-watch-fixture.ts'
import { startNativeAnthropicLifecycle } from '../v2/lifecycle.ts'

const { test, deferCleanup, gate } = createTestLifetimeSuite()

/**
 * Pool paths kept entirely under `root`. Without an explicit state path,
 * resolveNativePoolPaths takes the state file (and the runtime file beside it)
 * from OPENCODE_ANTHROPIC_AUTH_STATE_FILE when that is set. An earlier file in
 * the same `bun test` process can leave it set, and every test here would then
 * share one runtime file: the second test reads the first test's runtime state,
 * rejects it as invalid, and its lifecycle never lists the vault.
 */
const ownPoolPaths = (root: string) =>
  resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )

test('OpenCode 2 lifecycles share discovery and retain the surviving account lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc2-shared-lifecycle-'))
  const paths = await ownPoolPaths(root)
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
        grants: undefined,
        grantTuples: undefined,
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

for (const outcome of ['watching', 'fallback'] as const)
  test(`OpenCode 2 lists the vault every five minutes only while a vault watch is open (${outcome})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc2-vault-watch-'))
    deferCleanup(() => rm(root, { recursive: true, force: true }))
    const paths = await ownPoolPaths(root)
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
    const client: NativeCustodyClient = {
      async listScoped() {
        return {
          view: 'oc2-watch',
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
          grants: undefined,
          grantTuples: undefined,
        }
      },
      async getScoped(input) {
        return {
          credentialId: input.credentialId,
          accountId: '11111111-2222-4333-8444-555555555555',
          material: 'fresh-watch',
          recordVersion: 1,
          expiresAtMs: Date.now() + 3_600_000,
        }
      },
      async reportAuthFailureScoped() {},
      close() {},
    }
    const vault = watchableVaultClient(client, gate)
    const timers = recordedTimers(deferCleanup)
    const runtime = acquireNativeAccountRuntime({
      paths,
      host: 'opencode',
      vault: { env, connect: async () => client },
    })
    // Keep the lifecycle's own 60 s pace; only the timer functions are ours.
    const watch = runtime.vault.watch.bind(runtime.vault)
    const spy = spyOn(runtime.vault, 'watch').mockImplementation((options) =>
      watch({
        ...options,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
      }),
    )
    const transport = Object.assign(async () => Response.json({}), {
      preconnect: fetch.preconnect,
    }) as typeof fetch
    const lifecycle = startNativeAnthropicLifecycle(runtime, transport)
    deferCleanup(async () => {
      await lifecycle.dispose()
      runtime.close()
      spy.mockRestore()
    })
    const opened = await vault.nth(0)
    const poll = timers.created.find((timer) => timer.ms === 60_000)
    expect(poll && timers.live(poll.handle)).toBe(true)
    const before = timers.created.length
    if (outcome === 'watching') opened.notify('oc2-watch')
    else opened.finish({ kind: 'unsupported' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const added = timers.created.slice(before).map((timer) => timer.ms)
    if (outcome === 'watching') {
      expect(added).toEqual([5 * 60_000])
      expect(poll && timers.live(poll.handle)).toBe(false)
    } else {
      expect(added).toEqual([])
      expect(poll && timers.live(poll.handle)).toBe(true)
    }
  })
