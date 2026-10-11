import { afterEach, describe, expect, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertNotCustodyTombstone,
  buildRefreshOperationError,
  CustodyTombstoneRefreshError,
  createNativeAccountRuntime,
  custodyTombstoneKey,
  custodyTombstoneOAuth,
  FallbackAccountManager,
  fetchOAuthAccountProfile,
  fetchOAuthQuotaSnapshot,
  getFallbackReauthLabels,
  isCustodyTombstoneOAuth,
  isPermanentRefreshError,
  loadAccounts,
  type NativeCustodyClient,
  refreshClaudeOAuthToken,
  resetClaudeCodeIdentityCachesForTest,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'
import {
  type Auth,
  createOpencodeClient,
  type Provider,
} from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index'
import { drainSidebarWrites } from '../sidebar-state'
import { setOAuthHeaders } from '../transform'
import { migrateNativeOpencodeFixture } from './native-fixture'
import { extractUrl, TOKEN_URL } from './test-fetch'

const fixtureDir = join(import.meta.dir, 'fixtures', 'claustrum-golden')
const tombstoneFixture = JSON.parse(
  readFileSync(join(fixtureDir, 'tombstone.json'), 'utf8'),
) as {
  fixtures: {
    api: { provider: string; entry: Record<string, unknown> }
    oauth: { provider: string; entry: Record<string, unknown> }
  }
}

const oauthFixture = tombstoneFixture.fixtures.oauth
const apiFixture = tombstoneFixture.fixtures.api
const originalFetch = globalThis.fetch

type PluginHooks = Awaited<ReturnType<typeof AnthropicAuthPlugin>>
type PluginOptions = Parameters<typeof AnthropicAuthPlugin>[1]
type NativeFixture = Awaited<ReturnType<typeof migrateNativeOpencodeFixture>>
type OutboundRecord = { url: string; authorization: string }

const HOUR_MS = 60 * 60_000
const MAIN_IDENTITY = '11111111-1111-4111-8111-111111111111'
const REPLACEMENT_IDENTITY = '33333333-3333-4333-8333-333333333333'
const VAULT_MAIN_CREDENTIAL = 'oauth:anthropic'
const anthropicProvider: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'custom',
  env: [],
  options: {},
  models: {},
}

// Every environment variable a native test body or the migration fixture may
// set. Each body saves and restores all of them, so no path leaks into the
// next test.
const nativeEnvKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
  'CLAUDE_CONFIG_DIR',
  'XDG_DATA_HOME',
] as const

async function disposeAll(plugins: PluginHooks[], message: string) {
  const results = await Promise.allSettled(
    plugins.map((plugin) => Promise.resolve().then(() => plugin.dispose?.())),
  )
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      message,
    )
}

/**
 * Claim a fresh owner-only directory for this body. Teardown first disposes
 * the body's plugins and waits for sidebar writes, then restores fetch, the
 * clock, the environment and identity caches, and only then removes the
 * directory.
 */
async function startNativeBody() {
  const savedFetch = globalThis.fetch
  const savedNow = Date.now
  const savedEnv = new Map(nativeEnvKeys.map((key) => [key, process.env[key]]))
  const plugins = new Set<PluginHooks>()
  livePlugins.add(plugins)
  lifetimes.deferCleanup(async () => {
    const remaining = [...plugins]
    plugins.clear()
    livePlugins.delete(plugins)
    try {
      await disposeAll(remaining, 'Custody tombstone plugin cleanup failed')
    } finally {
      await drainSidebarWrites()
      globalThis.fetch = savedFetch
      Date.now = savedNow
      for (const key of nativeEnvKeys) {
        const value = savedEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetClaudeCodeIdentityCachesForTest()
    }
  })
  delete process.env.OPENCODE_AUTH_CONTENT
  resetClaudeCodeIdentityCachesForTest()
  const root = await mkdtemp(join(tmpdir(), 'anthropic-custody-native-'))
  // migrateNativeOpencodeFixture also removes the root once it accepts it;
  // this covers a body that fails before handing the root to it.
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  return { root, plugins }
}

/**
 * Replace fetch with a synthetic provider that records every outbound request.
 * The token endpoint answers with the caller's rotation, bootstrap names the
 * main account, and any other unexpected path fails the request.
 */
function recordNetwork(
  options: { token?: () => Record<string, unknown> } = {},
): OutboundRecord[] {
  const records: OutboundRecord[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = extractUrl(input)
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      records.push({ url, authorization: headers.get('authorization') ?? '' })
      if (url === TOKEN_URL && options.token)
        return Response.json(options.token())
      if (url.includes('/api/claude_cli/bootstrap'))
        return Response.json({ oauth_account: { account_uuid: MAIN_IDENTITY } })
      if (url.includes('/v1/messages'))
        return Response.json({
          id: 'synthetic-message',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      throw new Error(`Unexpected synthetic provider path: ${url}`)
    },
    { preconnect: originalFetch.preconnect },
  )
  return records
}

function applyFixtureEnv(fixture: NativeFixture) {
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  // OpenCode's own login store for this body, never the user's.
  process.env.XDG_DATA_HOME = join(fixture.root, 'opencode-data')
}

/** Commit a local native pool through the real offline migration. */
async function migrateLocalPool(
  root: string,
  hostAuth: Record<string, unknown>,
): Promise<NativeFixture> {
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: {
      version: 1,
      refresh: { enabled: false },
      quota: { enabled: false },
      routing: { mode: 'main-first' },
      accounts: [],
    },
    hostAuth,
  })
  applyFixtureEnv(fixture)
  expect((await readNativeAccounts(fixture)).mode).toBe('local')
  return fixture
}

function vaultMainRow(accountId: string) {
  return {
    id: VAULT_MAIN_CREDENTIAL,
    accountId,
    credentialType: 'oauth',
    state: 'active' as const,
    categories: ['anthropic-native'],
    serves: ['anthropic'],
    providerIds: [],
    refreshAdapter: 'anthropic',
    recordVersion: 1,
    operations: ['read'],
    createdAtMs: null,
  }
}

/**
 * Write this host's enrollment token and discover its vault accounts without
 * migrating local credentials. Preparation refuses credential reads, so every
 * credential read observed by a test comes from the plugin's serving path.
 */
async function prepareVaultPool(
  root: string,
  rows: ReturnType<typeof vaultMainRow>[],
): Promise<NativeFixture> {
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: {
      version: 1,
      refresh: { enabled: false },
      quota: { enabled: false },
      accounts: [],
      claustrum: {
        mode: 'claustrum',
        scopedRoster: true,
        primaryAccount: {
          credentialId: VAULT_MAIN_CREDENTIAL,
          accountId: MAIN_IDENTITY,
          state: 'active',
        },
      },
    },
    hostAuth: { anthropic: custodyTombstoneOAuth(oauthFixture.provider) },
    custody: {
      connect: async () => ({
        async listScoped() {
          return { view: 'custody-tombstone-migration', rows }
        },
        async getScoped() {
          throw new Error('Migration discovery must not read credentials')
        },
        async reportAuthFailureScoped() {
          throw new Error('Migration discovery must not report credentials')
        },
        close() {},
      }),
      enrollment: { token: 'ab'.repeat(32), token_generation: 1 },
    },
  })
  applyFixtureEnv(fixture)
  expect((await readNativeAccounts(fixture)).mode).toBe('claustrum')
  return fixture
}

async function readNativeAccounts(fixture: NativeFixture) {
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    return await runtime.read()
  } finally {
    runtime.close()
  }
}

async function createNativePlugin(
  plugins: Set<PluginHooks>,
  root: string,
  options: PluginOptions = {},
) {
  const creation = AnthropicAuthPlugin(
    {
      client: createOpencodeClient({
        baseUrl: 'http://127.0.0.1:9',
        fetch: globalThis.fetch,
      }),
      project: {
        id: 'custody-tombstone-fixture',
        worktree: root,
        time: { created: Date.now() },
      },
      directory: root,
      worktree: root,
      serverUrl: new URL('http://127.0.0.1:9'),
      experimental_workspace: { register() {} },
      $,
    },
    {
      scopedRosterPollIntervalMs: 0,
      cacheKeepAggregateRefreshIntervalMs: 0,
      ...options,
    },
  )
  lifetimes.trackDetached(creation)
  const plugin = await creation
  plugins.add(plugin)
  return plugin
}

async function disposePlugin(plugins: Set<PluginHooks>, plugin: PluginHooks) {
  plugins.delete(plugin)
  await plugin.dispose?.()
}

/** Load the plugin with OpenCode's current Anthropic slot and send one model request. */
async function sendMessage(
  plugin: PluginHooks,
  activation: Auth = custodyTombstoneOAuth(oauthFixture.provider),
): Promise<Response> {
  const loader = plugin.auth?.loader
  if (!loader) throw new Error('Plugin did not install its auth loader')
  const options: Record<string, unknown> = await loader(
    async () => structuredClone(activation),
    anthropicProvider,
  )
  const handler = options.fetch
  if (typeof handler !== 'function')
    throw new Error('Plugin did not install its request handler')
  const response: unknown = await handler(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    },
  )
  if (!(response instanceof Response))
    throw new Error('Plugin request handler did not return a Response')
  return response
}

function proMaxMethod(plugin: PluginHooks) {
  const method = plugin.auth?.methods.find(
    (candidate) => candidate.label === 'Claude Pro/Max',
  )
  if (method?.type !== 'oauth')
    throw new Error('Plugin offers no Claude Pro/Max sign-in')
  return method
}

async function createTempStorage<T>(
  storage: Record<string, unknown>,
  callback: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'anthropic-custody-test-'))
  const path = join(directory, 'anthropic-auth.json')
  const previous = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = path
  try {
    await saveAccounts(storage as never, path)
    return await callback(path)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    else process.env.OPENCODE_ANTHROPIC_AUTH_FILE = previous
    await rm(directory, { recursive: true, force: true })
  }
}

const livePlugins = new Set<Set<PluginHooks>>()
// Registered before the lifetime suite's own afterEach: dispose every native
// plugin (its timers and vault client) before that hook waits for a possibly
// still-running body and removes the body's files.
afterEach(async () => {
  const plugins = [...livePlugins].flatMap((owned) => {
    const current = [...owned]
    owned.clear()
    return current
  })
  await disposeAll(plugins, 'Custody tombstone plugin cancellation failed')
})
const lifetimes = createTestLifetimeSuite()
// Registered after the lifetime suite's afterEach, so it runs only once a
// timed-out native body has settled and its own cleanup has restored fetch.
// Restoring earlier would let that body resume against the original fetch
// instead of the synthetic provider it installed.
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Claustrum custody tombstones', () => {
  lifetimes.test('recognizes only provider-bound OAuth tombstones', () => {
    const provider = oauthFixture.provider
    const key = custodyTombstoneKey(provider)
    const productionTombstone = custodyTombstoneOAuth(provider)
    expect(oauthFixture.entry).toEqual(productionTombstone)
    const cases: Array<{ name: string; auth: unknown; recognized: boolean }> = [
      {
        name: 'production empty-access tombstone',
        auth: productionTombstone,
        recognized: true,
      },
      {
        name: 'vendored canonical empty-access tombstone',
        auth: oauthFixture.entry,
        recognized: true,
      },
      {
        name: 'noncanonical sentinel-access value is still refused at bearer boundaries',
        auth: { ...productionTombstone, access: key },
        recognized: true,
      },
      { name: 'API entry', auth: apiFixture.entry, recognized: false },
      {
        name: 'wrong-provider sentinel',
        auth: {
          ...productionTombstone,
          refresh: custodyTombstoneKey('openai'),
        },
        recognized: false,
      },
      {
        name: 'sentinel with prefix added',
        auth: { ...productionTombstone, refresh: `x${key}` },
        recognized: false,
      },
      {
        name: 'sentinel with suffix added',
        auth: { ...productionTombstone, refresh: `${key}x` },
        recognized: false,
      },
      {
        name: 'ordinary refresh token',
        auth: { ...productionTombstone, refresh: 'ordinary-refresh-token' },
        recognized: false,
      },
      {
        name: 'missing OAuth type',
        auth: { access: '', refresh: key, expires: 0 },
        recognized: false,
      },
    ]

    for (const entry of cases) {
      expect(isCustodyTombstoneOAuth(entry.auth, provider), entry.name).toBe(
        entry.recognized,
      )
    }
  })

  lifetimes.test(
    'throws a non-provider-refresh error before the token endpoint',
    () => {
      let thrown: unknown
      try {
        assertNotCustodyTombstone(
          oauthFixture.entry.refresh,
          oauthFixture.provider,
        )
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
      expect(thrown).toMatchObject({
        code: 'custody_tombstone_refresh',
        provider: oauthFixture.provider,
      })
      expect(thrown).not.toHaveProperty('isRefreshError')
      expect(thrown).not.toHaveProperty('permanent')
      expect(thrown).not.toHaveProperty('status')
      expect(String(thrown)).toContain('local token refresh is forbidden')
    },
  )

  lifetimes.test(
    'keeps loader recognition contained by both irreversible boundaries',
    async () => {
      const provider = oauthFixture.provider
      const recognized = [custodyTombstoneOAuth(provider), oauthFixture.entry]
      const foreign = custodyTombstoneKey('openai')
      const values = [
        ...recognized.map((auth) => ({
          auth,
          value: String((auth as Record<string, unknown>).refresh),
          recognized: true,
        })),
        {
          auth: { type: 'oauth', access: '', refresh: foreign, expires: 0 },
          value: foreign,
          recognized: false,
        },
      ]
      const tokenEndpointCalls: string[] = []
      const fetchImpl = mock((input: unknown) => {
        tokenEndpointCalls.push(extractUrl(input as string | URL | Request))
        return Promise.resolve(new Response('{}', { status: 200 }))
      }) as unknown as typeof fetch

      // Keep shallow and nested invalid-input cases together so their assertions stay consistent.
      await expect(
        Promise.all(
          values.map(
            async ({ auth, value, recognized: expectedRecognition }) => {
              expect(isCustodyTombstoneOAuth(auth, provider)).toBe(
                expectedRecognition,
              )
              expect(() => assertNotCustodyTombstone(value, provider)).toThrow(
                CustodyTombstoneRefreshError,
              )
              await expect(
                refreshClaudeOAuthToken({ refreshToken: value, fetchImpl }),
              ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
              expect(() => setOAuthHeaders(new Headers(), value)).toThrow(
                CustodyTombstoneRefreshError,
              )
            },
          ),
        ),
      ).resolves.toBeArray()
      expect(tokenEndpointCalls).toEqual([])
    },
  )

  lifetimes.test('refuses sentinel access during direct requests', async () => {
    const { root, plugins } = await startNativeBody()
    const outbound = recordNetwork()
    const fixture = await prepareVaultPool(root, [vaultMainRow(MAIN_IDENTITY)])
    expect(
      (await readNativeAccounts(fixture)).accounts.find(
        (account) => account.id === 'main',
      )?.credentialId,
    ).toBe(VAULT_MAIN_CREDENTIAL)
    // Each direct request reads its credential from the vault, and this read
    // answers with a tombstone instead of an access token.
    const vaultReads: string[] = []
    const sentinelVault: NativeCustodyClient = {
      async listScoped() {
        return {
          view: 'custody-tombstone',
          rows: [vaultMainRow(MAIN_IDENTITY)],
        }
      },
      async getScoped({ credentialId }) {
        vaultReads.push(credentialId)
        return {
          credentialId,
          material: custodyTombstoneKey(oauthFixture.provider),
          accountId: MAIN_IDENTITY,
          recordVersion: 1,
          expiresAtMs: Date.now() + 8 * HOUR_MS,
        }
      },
      async reportAuthFailureScoped() {},
      close() {},
    }
    const plugin = await createNativePlugin(plugins, root, {
      claustrumScopedConnect: async () => sentinelVault,
    })

    await expect(sendMessage(plugin)).rejects.toMatchObject({
      code: 'invalid-material',
    })
    expect(vaultReads).toContain(VAULT_MAIN_CREDENTIAL)
    expect(outbound).toEqual([])
  })

  lifetimes.test(
    'refuses a tombstone before the quota poll fetch',
    async () => {
      const fetchImpl = mock(() =>
        Promise.resolve(new Response('{}', { status: 200 })),
      ) as unknown as typeof fetch

      await expect(
        fetchOAuthQuotaSnapshot({
          accessToken: custodyTombstoneKey('openai'),
          fetchImpl,
        }),
      ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  lifetimes.test('refuses a tombstone before the profile fetch', async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch

    await expect(
      fetchOAuthAccountProfile({
        accessToken: custodyTombstoneKey('openai'),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  lifetimes.test('refuses a tombstone before CacheKeep prewarm headers', () => {
    expect(() =>
      setOAuthHeaders(new Headers(), custodyTombstoneKey('openai'), {
        body: { model: 'claude-sonnet-4-5' },
      }),
    ).toThrow(CustodyTombstoneRefreshError)
  })

  lifetimes.test('refuses a tombstone before Prime fire headers', () => {
    expect(() =>
      setOAuthHeaders(new Headers(), custodyTombstoneKey('openai'), {
        body: { model: 'claude-haiku-4-5' },
      }),
    ).toThrow(CustodyTombstoneRefreshError)
  })

  lifetimes.test(
    'holds a local main tombstone dark without network or refresh state',
    async () => {
      const { root, plugins } = await startNativeBody()
      const outbound = recordNetwork()
      // Host auth.json contains only the inert Anthropic activation marker.
      // Migration must leave the local pool empty instead of importing it.
      const fixture = await migrateLocalPool(root, {
        anthropic: custodyTombstoneOAuth(oauthFixture.provider),
      })
      const plugin = await createNativePlugin(plugins, root)

      // The marker enables plugin request handling, not bearer authorization.
      // With no local account, the request must fail without network traffic.
      await expect(sendMessage(plugin)).rejects.toThrow(
        'Native OAuth account is unavailable',
      )
      expect(outbound).toEqual([])

      const snapshot = await readNativeAccounts(fixture)
      expect(snapshot.mode).toBe('local')
      expect(snapshot.accounts).toEqual([])
      expect(
        JSON.parse(await readFile(fixture.hostAuthPath, 'utf8')).anthropic,
      ).toEqual(custodyTombstoneOAuth(oauthFixture.provider))
    },
  )

  lifetimes.test(
    'never sends a foreign-provider main tombstone to the token endpoint after expiry',
    async () => {
      const { root, plugins } = await startNativeBody()
      const outbound = recordNetwork({
        // The rotation hands back another provider's tombstone as the refresh
        // token successor, so the pool now stores it for the main account.
        token: () => ({
          access_token: 'sk-ant-oat01-live-main-rotated',
          refresh_token: custodyTombstoneKey('openai'),
          expires_in: 8 * 60 * 60,
        }),
      })
      const fixture = await migrateLocalPool(root, {
        anthropic: {
          type: 'oauth',
          access: 'sk-ant-oat01-live-main',
          refresh: 'live-main-refresh',
          expires: Date.now() + 8 * HOUR_MS,
        },
      })
      const plugin = await createNativePlugin(plugins, root)

      // The first send validates the migrated credential through one real
      // rotation and serves with its successor.
      expect((await sendMessage(plugin)).status).toBe(200)
      expect(outbound.map((record) => record.url)).toEqual([
        TOKEN_URL,
        expect.stringContaining('/api/claude_cli/bootstrap'),
        expect.stringContaining('/v1/messages'),
      ])
      expect(outbound[2]?.authorization).toBe(
        'Bearer sk-ant-oat01-live-main-rotated',
      )
      outbound.length = 0

      // Expire the credential returned by the first token exchange. The next
      // request would need to refresh with its stored foreign-provider marker.
      const realNow = Date.now
      Date.now = () => realNow() + 9 * HOUR_MS
      const refused = await sendMessage(plugin).catch((error: unknown) => error)
      // The stored tombstone is refused locally as the refresh begins: the
      // request fails as a local authorization refusal, not as a failed
      // token refresh, and nothing reaches the token endpoint.
      expect(refused).toBeInstanceOf(Error)
      expect(String(refused)).toContain(
        'Native OAuth authorization refused: refused',
      )
      expect(refused).toMatchObject({
        tokenRefreshFailed: false,
        failure: undefined,
      })
      expect(outbound).toEqual([])

      // Refusing a tombstone locally is not a provider refresh failure, so it
      // must leave no refresh error or backoff on the main account.
      const main = (await readNativeAccounts(fixture)).accounts.find(
        (account) => account.id === 'main',
      )
      expect(main?.accountIdentity).toBe(MAIN_IDENTITY)
      expect(main?.lastRefreshError).toBeUndefined()
    },
  )

  lifetimes.test(
    'reconciles a real main without a resolved binding before serving OAuth',
    async () => {
      const { root, plugins } = await startNativeBody()
      const outbound = recordNetwork()
      let vaultIdentity = MAIN_IDENTITY
      const vaultReads: string[] = []
      const listingGate = lifetimes.gate()
      const vaultClient = (
        listing: 'answers' | 'waits',
      ): NativeCustodyClient => ({
        async listScoped() {
          if (listing === 'waits') await listingGate.wait
          return {
            view: 'custody-tombstone',
            rows: [vaultMainRow(vaultIdentity)],
          }
        },
        async getScoped({ credentialId }) {
          vaultReads.push(credentialId)
          return {
            credentialId,
            material: `sk-ant-oat01-vault-${vaultIdentity}`,
            accountId: vaultIdentity,
            recordVersion: 1,
            expiresAtMs: Date.now() + 8 * HOUR_MS,
          }
        },
        async reportAuthFailureScoped() {},
        close() {},
      })
      const fixture = await prepareVaultPool(root, [
        vaultMainRow(MAIN_IDENTITY),
      ])
      expect(
        (await readNativeAccounts(fixture)).accounts.find(
          (account) => account.id === 'main',
        )?.accountIdentity,
      ).toBe(MAIN_IDENTITY)

      // The vault now holds a different account behind the default credential,
      // so the migrated main binding no longer resolves to the account served.
      vaultIdentity = REPLACEMENT_IDENTITY
      // Startup discovery would replace the saved account UUID. Hold it so the
      // request compares the old UUID against the vault's replacement account.
      const stale = await createNativePlugin(plugins, root, {
        claustrumScopedConnect: async () => vaultClient('waits'),
      })
      await expect(sendMessage(stale)).rejects.toMatchObject({
        code: 'identity-changed',
      })
      expect(vaultReads).toContain(VAULT_MAIN_CREDENTIAL)
      expect(outbound).toEqual([])
      listingGate.open()
      await disposePlugin(plugins, stale)

      // The vault inventory refresh rebinds main to the account the vault serves.
      const discovery = createNativeAccountRuntime({
        paths: fixture.paths,
        host: 'opencode',
        vault: { connect: async () => vaultClient('answers') },
      })
      try {
        await discovery.vault.refresh()
        expect(
          (await discovery.read()).accounts.find(
            (account) => account.id === 'main',
          )?.accountIdentity,
        ).toBe(REPLACEMENT_IDENTITY)
      } finally {
        discovery.close()
      }

      const reconciled = await createNativePlugin(plugins, root, {
        claustrumScopedConnect: async () => vaultClient('answers'),
      })
      expect((await sendMessage(reconciled)).status).toBe(200)
      expect(outbound).toEqual([
        {
          url: expect.stringContaining('/v1/messages'),
          authorization: `Bearer sk-ant-oat01-vault-${REPLACEMENT_IDENTITY}`,
        },
      ])
    },
  )

  lifetimes.test(
    'refuses Claude Pro/Max login before authorization while claustrum is committed',
    async () => {
      const { root, plugins } = await startNativeBody()
      const outbound = recordNetwork()
      const authorizeImpl = mock(async () => ({
        url: 'https://example.test/authorize',
        redirectUri: 'http://localhost/callback',
        state: 'state',
        verifier: 'verifier',
      }))
      const fixture = await migrateLocalPool(root, {
        anthropic: custodyTombstoneOAuth(oauthFixture.provider),
      })

      // Without vault enrollment, Claude Pro/Max starts the local OAuth flow.
      const local = await createNativePlugin(plugins, root, {
        authorize: authorizeImpl,
      })
      await expect(proMaxMethod(local).authorize()).resolves.toMatchObject({
        url: 'https://example.test/authorize',
      })
      expect(authorizeImpl).toHaveBeenCalledTimes(1)
      await disposePlugin(plugins, local)

      // Adding this host's enrollment token must block local OAuth sign-in.
      // The local pool and its settings remain unchanged.
      await writeFile(
        fixture.enrollmentPath,
        JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
        { mode: 0o600, flag: 'wx' },
      )
      const enrolled = await createNativePlugin(plugins, root, {
        authorize: authorizeImpl,
      })
      await expect(proMaxMethod(enrolled).authorize()).rejects.toThrow(
        'Disconnect from the vault first.',
      )
      expect(authorizeImpl).toHaveBeenCalledTimes(1)
      expect(outbound).toEqual([])
    },
  )

  lifetimes.test(
    'fallback refresh rejects the tombstone without network or refresh classification',
    async () => {
      const fetchCalls: string[] = []
      const fetchImpl = mock((input: unknown) => {
        fetchCalls.push(extractUrl(input as string | URL | Request))
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
          }),
        )
      }) as unknown as typeof fetch
      const account = {
        id: 'fallback-tombstone',
        type: 'oauth' as const,
        access: 'expired-access',
        refresh: oauthFixture.entry.refresh as string,
        expires: 0,
      }
      const storage = {
        version: 1,
        main: { type: 'opencode', provider: oauthFixture.provider },
        refresh: {
          enabled: true,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 30,
        },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 0, seven_day: 0 },
          failClosedOnUnknownQuota: false,
        },
        accounts: [account],
      }

      await createTempStorage(storage, async (path) => {
        const manager = new FallbackAccountManager({
          configPath: path,
          fetchImpl,
        })
        const refreshError = await manager
          .refreshAccount(account, storage as never)
          .catch((error: unknown) => error)
        expect(fetchCalls.filter((url) => url === TOKEN_URL)).toHaveLength(0)
        expect(refreshError).toBeInstanceOf(CustodyTombstoneRefreshError)
        await manager.refreshDueAccounts()
        await manager.refreshQuotaForDueAccounts()
        const loaded = await loadAccounts(path)
        expect(loaded?.accounts[0]?.type).toBe('oauth')
        if (loaded?.accounts[0]?.type === 'oauth') {
          expect(loaded.accounts[0].lastRefreshError).toBeUndefined()
          expect(loaded.accounts[0].lastQuotaRefreshError).toBeUndefined()
        }
        expect(getFallbackReauthLabels(loaded)).toEqual([])
        const classification = buildRefreshOperationError({
          error: new CustodyTombstoneRefreshError(oauthFixture.provider),
          now: 1,
          accountIdentity: account.id,
        })
        expect(isPermanentRefreshError(classification)).toBe(false)
        expect(classification.permanent).toBe(false)
      })
    },
  )
})
