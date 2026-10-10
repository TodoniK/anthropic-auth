import { expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthQuotaSnapshot } from '../accounts.ts'
import {
  migrateStickyRoutingState,
  type StickyRouteCandidate,
  StickySessionRouter,
} from '../sticky-routing.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const originalUuid = '11111111-2222-4333-8444-555555555555'
const replacedUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const fallbackUuid = '12345678-1234-4234-8234-123456789abc'
const model = 'claude-sonnet-5-5'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-vault-affinity-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'routing.json')
  let now = 2_000_000_000_000
  const router = new StickySessionRouter({ path, now: () => now })
  const quota = (identity: string): OAuthQuotaSnapshot => ({
    accountIdentity: identity,
    checkedAt: now,
    five_hour: {
      usedPercent: 1,
      remainingPercent: 99,
      checkedAt: now,
      resetsAt: new Date(now + 3_600_000).toISOString(),
    },
    seven_day: {
      usedPercent: 1,
      remainingPercent: 99,
      checkedAt: now,
      resetsAt: new Date(now + 86_400_000).toISOString(),
    },
  })
  const candidate = (id: string, identity: string): StickyRouteCandidate => ({
    accountId: id,
    quota: quota(identity),
    order: id === 'main' ? 0 : 1,
  })
  const resolve = (
    sessionId: string,
    candidates: StickyRouteCandidate[],
    identities?: ReadonlyMap<string, string>,
    preferredAccountId?: string,
  ) =>
    router.resolve({
      sessionId,
      family: 'general',
      modelId: model,
      affinityModelId: model,
      candidates,
      retainAccountIds: new Set(['main', 'fallback']),
      accountIdentities: identities,
      storage: null,
      inputBytes: 77,
      preferredAccountId,
    })
  return {
    path,
    router,
    resolve,
    candidate,
    advance: () => {
      now += 1
    },
    now: () => now,
  }
}

function rawPin(text: string, sessionId: string) {
  const key = createHash('sha256').update(sessionId).digest('hex')
  // These fixture pins contain only scalar fields and brace-free strings, so
  // preserve the exact JSON object bytes without depending on indentation.
  const match = text.match(new RegExp(`"${key}":\\s*(\\{[^}]*\\})`))
  if (!match?.[1]) throw new Error('Expected pin is missing')
  return match[1]
}

test('replacing the vault default UUID re-places only its session while an unrelated fallback pin survives byte-identical', async () => {
  const f = await fixture()
  const old = new Map([
    ['main', originalUuid],
    ['fallback', fallbackUuid],
  ])
  expect(
    (await f.resolve('main-session', [f.candidate('main', originalUuid)], old))
      ?.accountId,
  ).toBe('main')
  expect(
    (
      await f.resolve(
        'fallback-session',
        [f.candidate('fallback', fallbackUuid)],
        old,
      )
    )?.accountId,
  ).toBe('fallback')
  const fallbackPin = rawPin(await readFile(f.path, 'utf8'), 'fallback-session')
  f.advance()
  const next = new Map([
    ['main', replacedUuid],
    ['fallback', fallbackUuid],
  ])
  const result = await f.resolve(
    'main-session',
    [
      { accountId: 'main', quota: { kind: 'unknown' }, order: 0 },
      f.candidate('fallback', fallbackUuid),
    ],
    next,
    'main',
  )
  expect(result?.accountId).toBe('fallback')
  expect(result?.assignment.accountIdentity).toBe(fallbackUuid)
  expect(result?.migrated).toBe(true)
  expect(rawPin(await readFile(f.path, 'utf8'), 'fallback-session')).toBe(
    fallbackPin,
  )
})

test('a replaced vault default using the same logical main id gets a new UUID-bound pin and no old preference or timestamps', async () => {
  const f = await fixture()
  const first = await f.resolve(
    'session',
    [f.candidate('main', originalUuid)],
    new Map([['main', originalUuid]]),
  )
  expect(first?.assignment.accountIdentity).toBe(originalUuid)
  f.advance()
  const next = await f.resolve(
    'session',
    [f.candidate('main', replacedUuid)],
    new Map([['main', replacedUuid]]),
  )
  expect(next?.assignment.accountIdentity).toBe(replacedUuid)
  expect(next?.assignment.assignedAt).toBe(f.now())
  expect(next?.migrated).toBe(true)
})

test('a vault route without a verified UUID is never pinned, including retained logical main and warm-cache preference', async () => {
  const f = await fixture()
  const candidates = [f.candidate('main', originalUuid)]
  expect(
    (await f.resolve('session', candidates, new Map([['main', originalUuid]])))
      ?.accountId,
  ).toBe('main')
  for (const identities of [
    new Map<string, string>(),
    new Map([['main', '']]),
    new Map([['main', ' ']]),
  ]) {
    expect(
      await f.resolve('session', candidates, identities, 'main'),
    ).toBeNull()
  }
})

test('vault UUID changes refuse old retention even while the quota candidate list is empty', async () => {
  const f = await fixture()
  expect(
    (
      await f.resolve(
        'session',
        [f.candidate('main', originalUuid)],
        new Map([['main', originalUuid]]),
      )
    )?.accountId,
  ).toBe('main')
  expect(
    await f.resolve('session', [], new Map([['main', replacedUuid]])),
  ).toBeNull()
})

test('local retention ignores account UUID changes and leaves existing routing bytes untouched', async () => {
  const f = await fixture()
  expect(
    (await f.resolve('session', [f.candidate('main', originalUuid)]))
      ?.accountId,
  ).toBe('main')
  const before = await readFile(f.path)
  const result = await f.resolve('session', [f.candidate('main', replacedUuid)])
  expect(result?.accountId).toBe('main')
  expect(result?.assignment).not.toHaveProperty('accountIdentity')
  expect(await readFile(f.path)).toEqual(before)
})

test('migration preserves optional vault UUID metadata without adding any identity to legacy local assignments', async () => {
  const f = await fixture()
  await f.resolve('local', [f.candidate('main', originalUuid)])
  const localSource = JSON.parse(await readFile(f.path, 'utf8'))
  const local = migrateStickyRoutingState(
    localSource,
    new Map([['main', 'imported-main']]),
  )
  expect(local).not.toContain('accountIdentity')
  await f.resolve(
    'vault',
    [f.candidate('fallback', fallbackUuid)],
    new Map([['fallback', fallbackUuid]]),
  )
  const source = JSON.parse(await readFile(f.path, 'utf8'))
  const migrated = migrateStickyRoutingState(
    source,
    new Map([
      ['main', 'imported-main'],
      ['fallback', 'imported-fallback'],
    ]),
  )
  expect(migrated).toContain(`"accountIdentity": "${fallbackUuid}"`)
  expect(migrated).toContain('"accountId": "imported-main"')
})

test('a legacy vault pin without UUID is re-placed instead of inheriting its logical main id', async () => {
  const f = await fixture()
  await f.resolve('session', [f.candidate('main', originalUuid)])
  const next = await f.resolve(
    'session',
    [
      { accountId: 'main', quota: { kind: 'unknown' }, order: 0 },
      f.candidate('fallback', fallbackUuid),
    ],
    new Map([
      ['main', originalUuid],
      ['fallback', fallbackUuid],
    ]),
  )
  expect(next?.accountId).toBe('fallback')
  expect(next?.assignment.accountIdentity).toBe(fallbackUuid)
  expect(next?.migrated).toBe(true)
})

test('a replaced vault UUID cannot inherit a warm-cache preference for logical main', async () => {
  const f = await fixture()
  await f.resolve(
    'session',
    [f.candidate('main', originalUuid)],
    new Map([['main', originalUuid]]),
  )
  const main = f.candidate('main', replacedUuid)
  if (!('five_hour' in main.quota)) throw new Error('Expected a known quota')
  main.quota.five_hour = {
    checkedAt: f.now(),
    usedPercent: 99,
    remainingPercent: 1,
    resetsAt: new Date(f.now() + 3_600_000).toISOString(),
  }
  main.quota.seven_day = {
    checkedAt: f.now(),
    usedPercent: 99,
    remainingPercent: 1,
    resetsAt: new Date(f.now() + 86_400_000).toISOString(),
  }
  const next = await f.resolve(
    'session',
    [main, f.candidate('fallback', fallbackUuid)],
    new Map([
      ['main', replacedUuid],
      ['fallback', fallbackUuid],
    ]),
    'main',
  )
  expect(next?.accountId).toBe('fallback')
})
