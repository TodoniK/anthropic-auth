/// <reference types="bun-types" />
import { describe, expect } from 'bun:test'
import { createNativeAccountRuntime, custodyTombstoneOAuth, type NativePoolPaths, readNativeMigrationJournal, resolveNativePoolPaths } from '@cortexkit/anthropic-auth-core'
import { createTestLifetimeSuite } from '../../core/src/tests/test-lifetime.ts'
import { nativeVaultPaths } from '../../core/src/native-vault-paths.ts'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { E2EHarness } from '../src/harness.ts'
import { startFakeClaustrumDaemon, type FakeClaustrumCredential } from '../src/mock-claustrum.ts'

const { test: it, deferCleanup, trackDetached, gate } = createTestLifetimeSuite()
type Fixture = {
  harness: Pick<E2EHarness, 'dispose'> | null
  roots: string[]
  daemons: Array<{ stop: () => Promise<void> }>
}
function createFixture(): Fixture {
  const fixture: Fixture = { harness: null, roots: [], daemons: [] }
  deferCleanup(() => disposeFixture(fixture))
  return fixture
}
function ownHarness(fixture: Fixture, harness: E2EHarness) {
  fixture.harness = harness
  // A prompt timeout does not cancel the SDK transport. Abort at teardown,
  // then join the real request before disposing the child and its fixtures.
  const prompt = harness.client.session.prompt.bind(harness.client.session)
  harness.client.session.prompt = (options) => {
    let settled = false
    const stop = gate()
    const cancellation = stop.wait.then(async () => {
      if (!settled) await harness.abortSession(options.path.id)
    })
    trackDetached(cancellation)
    const work = prompt(options).finally(() => {
      settled = true
      stop.open()
    })
    trackDetached(work)
    return work
  }
  return harness
}
async function disposeFixture(fixture: Fixture) {
  // Claim this fixture's slots before awaiting teardown; a late cleanup must
  // not erase resources installed while its previous harness is draining.
  const finished = fixture.harness
  fixture.harness = null
  const retiredDaemons = fixture.daemons.splice(0)
  const retiredRoots = fixture.roots.splice(0)
  const stopped = await Promise.allSettled([
    Promise.resolve().then(() => finished?.dispose()),
    ...retiredDaemons.map((daemon) => Promise.resolve().then(() => daemon.stop())),
  ])
  const removed = await Promise.allSettled(
    retiredRoots.map((root) => rm(root, { recursive: true, force: true })),
  )
  const failed = [...stopped, ...removed].find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failed) throw failed.reason
}

const credential = (access: string, accountId: string, recordVersion: number): FakeClaustrumCredential => ({
  payload: access, account_id: accountId, record_version: recordVersion,
  expires_at_ms: Date.now() + 3_600_000,
})
const mainId = 'oauth:anthropic'
const workId = 'oauth:anthropic:work'

// Read vault account settings and cached metadata in the child's enrollment
// namespace. Status reads must not connect to Claustrum or retrieve OAuth tokens.
async function readNativeAccounts(paths: NativePoolPaths, env: NodeJS.ProcessEnv) {
  const runtime = createNativeAccountRuntime({ paths, host: 'opencode', vault: { env } })
  try {
    return await runtime.read()
  } finally {
    runtime.close()
  }
}
async function setNativeRoutingMode(mode: string, paths: NativePoolPaths, env: NodeJS.ProcessEnv) {
  const runtime = createNativeAccountRuntime({ paths, host: 'opencode', vault: { env } })
  try {
    await runtime.updateSettings((settings) => ({
      ...settings,
      routing: { ...(settings.routing as Record<string, unknown> | undefined), mode },
    }))
  } finally {
    runtime.close()
  }
}
const hasVaultAccount = (snapshot: Awaited<ReturnType<typeof readNativeAccounts>>, credentialId: string) =>
  snapshot.accounts.some((a) => a.source === 'vault' && a.credentialId === credentialId)
async function readIfPresent(path: string) {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
}

describe('zero-bind scoped custody', () => {
  it('discovers, authorizes and serves a new account without handles or a restart', async () => {
    const fixture = createFixture()
    const { roots, daemons } = fixture
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-scoped-e2e-'))
    roots.push(root)
    const credentials: Record<string, FakeClaustrumCredential> = {
      [mainId]: credential('scoped-main', 'account-main', 11),
    }
    const daemon = await startFakeClaustrumDaemon({ directory: root, scopedCredentials: credentials })
    daemons.push(daemon)
    const childEnv: NodeJS.ProcessEnv = {
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: daemon.connectionFile,
    }
    const harness = ownHarness(fixture, await E2EHarness.create({
      nativeAccounts: { kind: 'vault' },
      childEnv,
      beforeSpawn: async (env) => {
        childEnv.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(env.configDir, 'claustrum-enrollment.json')
        childEnv.HOME = env.homeDir
        childEnv.XDG_CONFIG_HOME = env.configDir
        await writeFile(childEnv.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE, JSON.stringify({ token: 'aa'.repeat(32), token_generation: 1 }), { mode: 0o600 })
      },
    }))
    harness.script([{ type: 'text', text: 'main served' }, { type: 'text', text: 'new account served' }])
    const first = await harness.createSession()
    await harness.sendPrompt(first, 'serve main')
    await harness.waitForSessionText(first, 'main served')
    expect(harness.anthropic.requests().at(-1)?.headers.authorization).toBe('Bearer scoped-main')
    expect(daemon.credentialGets).toContain(mainId)
    expect(daemon.scopedLists).toBeGreaterThan(0)
    credentials[workId] = credential('scoped-work', 'account-work', 12)
    const pool = harness.opencode.native!.paths
    const hostAuthBefore = await readFile(harness.opencode.native!.hostAuthPath, 'utf8')
    await harness.waitFor(async () => {
      const snapshot = await readNativeAccounts(pool, childEnv)
      return hasVaultAccount(snapshot, workId) ? true : undefined
    }, { timeoutMs: 15_000, label: 'new scoped account persisted' })
    const beforeMode = await readNativeAccounts(pool, childEnv)
    expect(hasVaultAccount(beforeMode, workId),
      JSON.stringify({ rows: beforeMode.accounts.map((a) => [a.id, a.source === 'vault' ? a.credentialId : a.type]),
        roster: await readIfPresent(nativeVaultPaths(pool).roster),
        scopedLists: daemon.scopedLists, vaultIds: Object.keys(credentials) }),
    ).toBe(true)
    expect(beforeMode.mode).toBe('claustrum')
    await setNativeRoutingMode('fallback-first', pool, childEnv)
    const afterMode = await readNativeAccounts(pool, childEnv)
    expect(hasVaultAccount(afterMode, workId)).toBe(true)
    expect(await readFile(harness.opencode.native!.hostAuthPath, 'utf8')).toBe(hostAuthBefore)
    const second = await harness.createSession()
    await harness.sendPrompt(second, 'serve new fallback')
    await harness.waitForSessionText(second, 'new account served')
    expect(harness.anthropic.requests().at(-1)?.headers.authorization).toBe('Bearer scoped-work')
    expect(daemon.credentialGets).toContain(workId)
    expect(harness.anthropic.tokenRequests()).toBe(0)
    // Require the account-observation file so a missing file cannot make the
    // token-exclusion assertion pass vacuously. Inspect configuration,
    // credential and roster files too when present; this vault-only fixture
    // does not require a file containing local OAuth credentials.
    const vaultPaths = nativeVaultPaths(pool)
    const state = [
      await readFile(vaultPaths.runtime, 'utf8'),
      await readFile(vaultPaths.roster, 'utf8'),
      ...(await Promise.all([vaultPaths.config, vaultPaths.state].map(readIfPresent))),
    ].join('\n')
    expect(state).not.toContain('scoped-main')
    expect(state).not.toContain('scoped-work')
    for (const path of [pool.config, pool.state, pool.runtime, pool.journal, pool.roster]) {
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }, 120_000)

  it('refuses a legacy handle-only config with native migration-required authority until explicit setup', async () => {
    const fixture = createFixture()
    const { roots, daemons } = fixture
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-legacy-e2e-'))
    roots.push(root)
    const daemon = await startFakeClaustrumDaemon({ directory: root,
      scopedCredentials: { [mainId]: credential('must-not-send', 'account-main', 1) },
    })
    daemons.push(daemon)
    const harness = ownHarness(fixture, await E2EHarness.create({
      // Deliberately unmigrated: offline setup refuses this handle-only config
      // (custody mode without a primary account). OpenCode's real auth.json
      // holds a non-secret OAuth-shaped marker that activates this plugin, and
      // there is no completed credential-transfer journal. The plugin must end
      // the turn with the exact setup-required error, without a retry, a
      // provider or vault request, or an enrollment attempt.
      nativeAccounts: { kind: 'unmigrated', hostAuth: { anthropic: custodyTombstoneOAuth('anthropic') } },
      childEnv: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: daemon.connectionFile,
      },
      beforeSpawn: async (env) => {
        await writeFile(join(env.configDir, 'anthropic-auth.json'), JSON.stringify({ version: 1, accounts: [], claustrum: { mode: 'claustrum' } }), { mode: 0o600 })
      },
    }))
    const legacyConfigPath = join(harness.opencode.env.configDir, 'anthropic-auth.json')
    const legacyConfigBefore = await readFile(legacyConfigPath, 'utf8')
    const hostAuthPath = join(harness.opencode.env.dataDir, 'opencode', 'auth.json')
    const hostAuthBefore = await readFile(hostAuthPath, 'utf8')
    const session = await harness.createSession()
    await harness.startPrompt(session, 'must fail before transport')
    try {
      type SessionMessage = { info: { role?: string; error?: { name?: string; data?: { message?: unknown } } }; parts?: Array<{ type?: string; text?: string }> }
      const statuses: Array<string | undefined> = []
      const assistants = await harness.waitFor(async () => {
        statuses.push((await harness!.client.session.status()).data?.[session]?.type)
        const messages = ((await harness!.client.session.messages({ path: { id: session } })).data ?? []) as SessionMessage[]
        const replies = messages.filter((message) => message.info.role === 'assistant')
        return replies.length > 0 && replies.every((message) => message.info.error) ? replies : undefined
      }, { timeoutMs: 15_000, label: 'terminal assistant error' })
      const finalStatus = (await harness.client.session.status()).data?.[session]?.type
      expect(
        assistants.map((message) => message.info.error?.data?.message),
        JSON.stringify({ errors: assistants.map((message) => message.info.error), statuses, finalStatus }),
      ).toEqual(
        assistants.map(
          () => 'Anthropic account migration is required. Stop OpenCode, LiteCode and Pi, then run bunx @cortexkit/opencode-anthropic-auth@2.0.0 setup',
        ),
      )
      expect(statuses).not.toContain('retry')
      expect(finalStatus).not.toBe('retry')
      expect(assistants.flatMap((message) => message.parts ?? []).filter((part) => part.type === 'text' && part.text)).toEqual([])
      expect(harness.anthropic.requests()).toHaveLength(0)
      expect(daemon.credentialGets).toHaveLength(0)
      expect(daemon.enrollmentProposals).toHaveLength(0)
      await expect(readFile(
        join(harness.opencode.env.configDir, 'claustrum-enrollment-state.json'),
        'utf8',
      )).rejects.toMatchObject({ code: 'ENOENT' })
      const pool = await resolveNativePoolPaths(
        join(harness.opencode.env.configDir, 'anthropic-auth.json'),
        join(harness.opencode.env.configDir, 'anthropic-auth-state.json'),
      )
      expect(await readNativeMigrationJournal(pool)).toBeUndefined()
      expect(await readFile(legacyConfigPath, 'utf8')).toBe(legacyConfigBefore)
      expect(await readFile(hostAuthPath, 'utf8')).toBe(hostAuthBefore)
      expect(harness.anthropic.tokenRequests()).toBe(0)
      for (const path of [pool.config, pool.state, pool.runtime, pool.roster]) {
        await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      await harness.abortSession(session)
    }
  }, 120_000)
})

describe('scoped credential rotations in the OpenCode process', () => {
  it('replays only the refused turn when the vault rotates before the first 401 arrives', async () => {
    const fixture = createFixture()
    const { roots, daemons } = fixture
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-scoped-rotation-e2e-'))
    roots.push(root)
    const main = credential('scoped-main-v1', 'account-main', 11)
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      scopedCredentials: { [mainId]: main },
    })
    daemons.push(daemon)
    const harness = ownHarness(fixture, await E2EHarness.create({
      nativeAccounts: { kind: 'vault' },
      childEnv: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: daemon.connectionFile,
      },
      beforeSpawn: async (env) => {
        await writeFile(join(env.configDir, 'claustrum-enrollment.json'),
          JSON.stringify({ token: 'aa'.repeat(32), token_generation: 1 }),
          { mode: 0o600 })
      },
    }))
    harness.script([
      {
        type: 'error',
        status: 401,
        errorType: 'authentication_error',
        message: 'old record rejected',
        beforeRespond: () => {
          main.payload = 'scoped-main-v2'
          main.record_version = 12
        },
      },
      { type: 'text', text: 'rotated account served' },
    ])
    const session = await harness.createSession()
    await harness.sendPrompt(session, 'test one in-flight rotation')
    await harness.waitForSessionText(session, 'rotated account served')
    const requests = harness.anthropic.requests()
      .filter((request) => request.body.model === 'claude-sonnet-4-5')
    expect(requests.map((request) => request.headers.authorization)).toEqual([
      'Bearer scoped-main-v1', 'Bearer scoped-main-v2',
    ])
    expect(daemon.reportAuthFailures).toEqual([])
    expect(daemon.credentialGets.filter((id) => id === mainId).length).toBeGreaterThanOrEqual(2)
  }, 120_000)
})


it('late fixture cleanup cannot dispose the next test’s harness, daemon or directory', async () => {
  const fixture = createFixture()
  const { roots, daemons } = fixture
  const previousRoot = await mkdtemp(join(tmpdir(), 'anthropic-auth-retired-'))
  const nextRoot = await mkdtemp(join(tmpdir(), 'anthropic-auth-next-'))
  let entered!: () => void
  const cleanupGate = gate()
  const release = () => cleanupGate.open()
  const started = new Promise<void>((resolve) => { entered = resolve })
  let previousStops = 0
  let nextStops = 0
  fixture.harness = {
    dispose: async () => { entered(); await cleanupGate.wait },
  }
  roots.push(previousRoot)
  daemons.push({ stop: async () => { previousStops++ } })
  const retiring = disposeFixture(fixture)
  trackDetached(retiring)
  try {
    await started
    fixture.harness = {
      dispose: async () => { nextStops++ },
    }
    await writeFile(join(nextRoot, 'marker'), 'new fixture')
    roots.push(nextRoot)
    daemons.push({ stop: async () => { nextStops++ } })
    release()
    await retiring
    expect(previousStops).toBe(1)
    expect(nextStops).toBe(0)
    expect(fixture.harness).not.toBeNull()
    expect(await readFile(join(nextRoot, 'marker'), 'utf8')).toBe('new fixture')
  } finally {
    release()
    await retiring
    await rm(previousRoot, { recursive: true, force: true })
    if (!roots.includes(nextRoot))
      await rm(nextRoot, { recursive: true, force: true })
    // If nextRoot remains registered, the lifetime stops its harness and daemon
    // and removes that directory after the body and detached work settle.
  }
})

it('fixture cleanup drains sibling stops before removing roots when another stop fails', async () => {
  const fixture = createFixture()
  const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-cleanup-failure-'))
  fixture.roots.push(root)
  const marker = join(root, 'marker')
  await writeFile(marker, 'owned fixture')
  const release = gate()
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const sibling = release.wait.then(() => undefined)
  trackDetached(sibling)
  const failure = new Error('synthetic fixture shutdown failure')
  fixture.daemons.push(
    { stop: async () => { throw failure } },
    { stop: async () => { entered(); await sibling } },
  )
  let settled = false
  const retiring = disposeFixture(fixture).then(
    () => ({ status: 'fulfilled' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  ).finally(() => { settled = true })
  trackDetached(retiring)
  try {
    await started
    await Bun.sleep(0)
    expect(settled).toBe(false)
    expect(await readFile(marker, 'utf8')).toBe('owned fixture')
  } finally {
    release.open()
  }
  const outcome = await retiring
  expect(outcome).toEqual({ status: 'rejected', error: failure })
  await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
