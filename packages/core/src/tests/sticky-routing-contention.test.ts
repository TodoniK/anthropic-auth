import { expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import { StickySessionRouter } from '../sticky-routing.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const lifetimes = createTestLifetimeSuite()
for (const operation of ['assign', 'clear', 'seed'] as const) {
  lifetimes.test(
    `sticky routing ${operation} does not wait on a held bookkeeping lock`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'sticky-held-lock-'))
      const path = join(directory, 'routing.json')
      let lease: Awaited<ReturnType<typeof acquireRefreshFileLock>>
      lifetimes.deferCleanup(async () => {
        await lease?.release()
        await rm(directory, { recursive: true, force: true })
      })
      const assignment = {
        accountId: 'main',
        family: 'general',
        affinityModelId: 'claude-sonnet-5',
        assignedAt: Date.now(),
        lastSeenAt: Date.now(),
        initialInputBytes: 1,
        quotaCheckedAt: 0,
      }
      const key = createHash('sha256').update('session-held-lock').digest('hex')
      const state = {
        version: 1,
        updatedAt: Date.now(),
        assignments: operation === 'clear' ? { [key]: assignment } : {},
        ...(operation === 'seed' ? { vaultLegacySeed: 'pending' } : {}),
      }
      const bytes = JSON.stringify(state)
      await writeFile(path, bytes, { mode: 0o600 })
      const roster = join(directory, 'roster.json')
      const router = new StickySessionRouter({ path })
      lease = await acquireRefreshFileLock({
        path,
        name: 'write',
        ttlMs: 60_000,
        renew: true,
      })
      if (!lease) throw new Error('Fixture lock not acquired')
      if (operation === 'assign') {
        const route = await router.resolve({
          sessionId: 'session-held-lock',
          family: 'general',
          modelId: 'claude-sonnet-5',
          candidates: [
            {
              accountId: 'main',
              order: 0,
              quota: {
                checkedAt: Date.now(),
                five_hour: {
                  remainingPercent: 100,
                  usedPercent: 0,
                  checkedAt: Date.now(),
                  resetsAt: new Date(Date.now() + 3600_000).toISOString(),
                },
                seven_day: {
                  remainingPercent: 100,
                  usedPercent: 0,
                  checkedAt: Date.now(),
                  resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
                },
              },
            },
          ],
          retainAccountIds: new Set(['main']),
          storage: null,
          inputBytes: 1,
        })
        expect(route?.accountId).toBe('main')
      } else if (operation === 'clear') {
        await router.clear('session-held-lock')
      } else {
        router.setVaultSeed({
          legacyConfig: join(directory, 'legacy.json'),
          roster,
        })
        await router.prepareLegacySeed({
          version: 1,
          complete: true,
          rows: [],
          declined: [],
        })
      }
      await lease.assertOwned()
      expect(await readFile(path, 'utf8')).toBe(bytes)
    },
    10_000,
  )
}
