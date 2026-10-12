import { afterEach, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeAccountRuntime,
  getStickyRoutingStatePath,
  type NativeCustodyClient,
  resolveNativePoolPaths,
} from '@cortexkit/anthropic-auth-core'
import {
  mutateVaultRoster,
  projectVaultRoster,
} from '@cortexkit/common-auth/claustrum'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { createNativeAnthropicSource } from '../v2/source.ts'

const owners = new Set<{ close(): void }>()
afterEach(() => {
  for (const owner of owners) owner.close()
  owners.clear()
})
const { test, deferCleanup } = createTestLifetimeSuite()
const mainUuid = '11111111-2222-4333-8444-555555555555'
const workUuid = '22222222-2222-4333-8444-555555555555'
const hash = (session: string) =>
  createHash('sha256').update(session).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oc2-vault-legacy-seed-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  const vault = nativeVaultPaths(paths)
  const now = Date.now()
  const legacyConfig = JSON.stringify({
    version: 1,
    mainAccountId: mainUuid,
    claustrum: {
      mode: 'claustrum',
      primaryAccount: {
        credentialId: 'oauth:anthropic',
        accountId: mainUuid,
        state: 'active',
      },
    },
    routing: { mode: 'sticky-balanced' },
    quota: { enabled: false },
    accounts: [
      {
        id: 'old-work',
        label: 'Work',
        type: 'oauth',
        enabled: true,
        addedAt: now,
        anthropicAccountUuid: workUuid,
      },
    ],
  })
  await writeFile(paths.legacyConfig, legacyConfig, { mode: 0o600 })
  const pin = {
    accountId: 'old-work',
    family: 'general',
    affinityModelId: 'claude-sonnet-5-5',
    assignedAt: now,
    lastSeenAt: now,
    initialInputBytes: 22,
    quotaCheckedAt: 0,
  }
  const routingPath = getStickyRoutingStatePath(paths.legacyConfig)
  const legacyRouting = JSON.stringify({
    version: 1,
    updatedAt: now,
    assignments: {
      [hash('live-session')]: pin,
      [hash('legacy-only-session')]: pin,
    },
  })
  await writeFile(routingPath, legacyRouting, { mode: 0o600 })
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
  const roster = projectVaultRoster(
    undefined,
    {
      view: 'verified-accounts',
      credentials: [
        {
          credentialId: 'oauth:anthropic',
          credentialType: 'oauth',
          accountIdentity: mainUuid,
          state: 'active',
        },
        {
          credentialId: 'oauth:work',
          credentialType: 'oauth',
          accountIdentity: workUuid,
          state: 'active',
        },
      ],
      skipped: [],
    },
    { now },
  )
  await mutateVaultRoster(vault.roster, () => ({
    next: { ...roster, complete: false },
    result: undefined,
  }))
  const workRoute = roster.rows.find(
    (row) => row.accountIdentity === workUuid,
  )?.routeId
  if (!workRoute) throw new Error('Fixture has no work route')
  const client: NativeCustodyClient = {
    listScoped: async () => {
      throw new Error('Discovery is not ready')
    },
    getScoped: async ({ credentialId }) => ({
      credentialId,
      accountId: credentialId === 'oauth:anthropic' ? mainUuid : workUuid,
      material: 'sk-ant-oat01-synthetic-oc2',
      recordVersion: 1,
      expiresAtMs: Date.now() + 3600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close() {},
  }
  const options = {
    paths,
    host: 'opencode' as const,
    vault: { env, connect: async () => client },
  }
  const runtime = createNativeAccountRuntime(options)
  owners.add(runtime)
  deferCleanup(() => runtime.close())
  const native = createNativeAnthropicSource({
    runtime,
    paths,
    requestOptions: () => ({}),
  })
  owners.add(native)
  deferCleanup(() => native.close())
  const scope = {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-5-5',
    sessionID: 'live-session',
    agent: 'build',
    kind: 'primary' as const,
  }
  return {
    paths,
    vault,
    runtime,
    native,
    scope,
    roster,
    workRoute,
    options,
    legacyConfig,
    legacyRouting,
    routingPath,
  }
}

test('OpenCode 2 live pin during roster deferral carries pending provenance and survives the one-time legacy merge', async () => {
  const f = await fixture()
  expect(await f.native.chooseAccount(f.scope)).toBe('main')
  expect((await f.native.authorizeAccount(f.scope, 'main'))?.route).toBe(
    'oauth',
  )
  const pending = JSON.parse(await readFile(f.vault.routing, 'utf8'))
  expect(pending.vaultLegacySeed).toBe('pending')
  expect(Object.keys(pending.assignments)).toEqual([hash('live-session')])
  const live = pending.assignments[hash('live-session')]
  expect(live).toMatchObject({ accountId: 'main', accountIdentity: mainUuid })
  await mutateVaultRoster(f.vault.roster, () => ({
    next: f.roster,
    result: undefined,
  }))
  expect(
    await f.native.chooseAccount({
      ...f.scope,
      sessionID: 'legacy-only-session',
    }),
  ).toBe(f.workRoute)
  const complete = JSON.parse(await readFile(f.vault.routing, 'utf8'))
  expect(complete.vaultLegacySeed).toBe('complete')
  expect(complete.assignments[hash('live-session')]).toEqual(live)
  expect(complete.assignments[hash('legacy-only-session')]).toMatchObject({
    accountId: f.workRoute,
    accountIdentity: workUuid,
    initialInputBytes: 22,
  })
  await f.native.resetRouting('legacy-only-session')
  const before = await readFile(f.vault.routing)
  const restarted = createNativeAccountRuntime(f.options)
  owners.add(restarted)
  deferCleanup(() => restarted.close())
  await restarted.read()
  expect(await readFile(f.vault.routing)).toEqual(before)
  expect(await readFile(f.paths.legacyConfig, 'utf8')).toBe(f.legacyConfig)
  expect(await readFile(f.routingPath, 'utf8')).toBe(f.legacyRouting)
})
