import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  captureNativeLocalPoolBinding,
  createNativeAccountRuntime,
  createNativePoolStore,
  getStickyRoutingStatePath,
  type NativeAccountRuntime,
  type NativeCustodyClient,
  type NativePoolPaths,
  readNativeEnrollmentMode,
  resolveNativePoolPaths,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import { registerOpenCode2AuthMethods } from '@cortexkit/common-auth/opencode2'
import { fingerprintOf } from '@cortexkit/common-auth/store'
import type { IntegrationOAuthMethodRegistration } from '@opencode/plugin/promise/integration'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths'
import { tokenFingerprint } from '../../../core/src/token-fingerprint'
import {
  CLAUDE_POOL_LOGIN_METHOD_ID,
  CLAUDE_VAULT_ACTIVATION_METHOD_ID,
} from '../v2/activation'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAttemptContext,
  NativeAnthropicTransportRefusal,
} from '../v2/adapter'
import {
  claudeLoginMethods,
  LOCAL_LOGIN_REFUSED_IN_VAULT,
  nativeEnrollmentCallbacks,
  VAULT_ACTIVATION_REFUSED_LOCALLY,
} from '../v2/setup'
import {
  createNativeAnthropicSource,
  type NativeSourceProvenance,
} from '../v2/source'

const identity = '11111111-2222-4333-8444-555555555555'
const changedIdentity = '99999999-2222-4333-8444-555555555555'
const fallbackIdentity = '12345678-1234-4234-8234-123456789abc'
const scope = {
  providerID: 'anthropic',
  modelID: 'claude-sonnet-5',
  sessionID: 'ses_native_oc2',
  agent: 'build',
  kind: 'primary' as const,
}
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function storage() {
  const parent = resolve(
    import.meta.dir,
    '../../../../node_modules/.cache/opencode2-native-source',
  )
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'fixture-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(directory, 'anthropic-auth.json'),
    join(directory, 'anthropic-auth-state.json'),
  )
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({ version: 1, accounts: [] }),
    { mode: 0o600 },
  )
  await writeFile(
    paths.legacyState,
    JSON.stringify({ version: 1, accounts: {} }),
    { mode: 0o600 },
  )
  await runNativeMigration({
    paths,
    host: 'opencode',
    hostAuthPath: join(directory, 'auth.json'),
    routingSourcePath: join(directory, 'legacy-routing.json'),
    routingDestinationPath: join(directory, 'native-routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  // The account runtime serves vault accounts only when this OpenCode's vault
  // enrollment file exists, regardless of account settings. Give each fixture
  // its own enrollment file path inside its directory, so the tests never read
  // an enrollment file on the machine running them.
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      directory,
      'opencode-enrollment.json',
    ),
  }
  return { paths, store, env }
}
async function local(
  localOptions?: Parameters<typeof createNativeAccountRuntime>[0]['local'],
) {
  const { paths, store, env } = await storage()
  await store.add({
    id: 'primary-row',
    identity,
    credential: {
      type: 'oauth',
      access: 'sk-ant-oat01-native-only',
      refresh: 'native-only-refresh',
      expires: Date.now() + 3600_000,
    },
  })
  await store.updateSettings(() => ({
    mainAccountId: 'primary-row',
    quota: { enabled: false },
    routing: { mode: 'main-first' },
  }))
  const read = await store.read()
  const row = read.status === 'ready' ? read.rows[0] : undefined
  if (
    row?.credential?.type !== 'oauth' ||
    !row.credential.access ||
    row.credential.expires === undefined
  )
    throw new Error('Missing native seed')
  const binding = captureNativeLocalPoolBinding(paths, row)
  await writeFile(
    paths.runtime,
    JSON.stringify({
      version: 1,
      storageId: paths.storageId,
      accounts: {
        'primary-row': {
          binding,
          credentialValidation: {
            binding,
            credentialFingerprint: fingerprintOf(row.credential),
            version: {
              accessFingerprint: tokenFingerprint(row.credential.access),
              expires: row.credential.expires,
              ...(Object.hasOwn(row.credential, 'lastRefreshedAt')
                ? { lastRefreshedAt: row.credential.lastRefreshedAt }
                : {}),
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  )
  // Invalid legacy JSON cannot supply credentials, so a request must use the
  // validated login in migrated storage.
  await writeFile(paths.legacyConfig, '{invalid-legacy-config')
  await writeFile(paths.legacyState, '{invalid-legacy-credential-state')
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: localOptions,
    vault: { env },
  })
  cleanups.push(() => runtime.close())
  return { paths, runtime, store, env }
}
/**
 * Registers the login methods built by claudeLoginMethods through common-auth,
 * as plugin setup does, and returns the registration OpenCode would hold for
 * one of them: the Claude Pro / Max sign-in unless another method ID is given.
 */
async function registeredLogin(
  input: Parameters<typeof claudeLoginMethods>[0],
  methodID: string = CLAUDE_POOL_LOGIN_METHOD_ID,
) {
  let registration: IntegrationOAuthMethodRegistration | undefined
  await registerOpenCode2AuthMethods(
    {
      integration: {
        transform: async (callback) => {
          callback({
            list: () => [],
            get: () => undefined,
            update: () => {},
            remove: () => {},
            method: {
              list: () => [],
              remove: () => {},
              update: (method) => {
                if ('authorize' in method && method.method.id === methodID)
                  registration = method
              },
            },
          })
          return { dispose: async () => {} }
        },
      },
    },
    claudeLoginMethods(input),
  )
  if (!registration)
    throw new Error(`Login method ${methodID} was not registered`)
  return registration
}
function source(runtime: NativeAccountRuntime, paths: NativePoolPaths) {
  const native = createNativeAnthropicSource({
    runtime,
    paths,
    requestOptions: () => ({}),
  })
  cleanups.push(() => native.close())
  return native
}
function context(
  provenance: NativeSourceProvenance,
  attemptId = 'attempt-one',
): NativeAnthropicAttemptContext<NativeSourceProvenance> {
  return {
    ...scope,
    accountId: 'main',
    attemptId,
    transport: 'http',
    route: 'oauth',
    dispatch: 'direct',
    provenance,
  }
}
async function vault(
  versions: number[] = [7, 8],
  servedIdentity: (get: number) => string = () => identity,
  routing: { mode: string } = { mode: 'main-first' },
) {
  const { paths, env, store: localStore } = await storage()
  await writeFile(
    env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const store = createNativePoolStore({
    paths: nativeVaultPaths(paths),
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  await store.updateSettings(() => ({
    quota: { enabled: false },
    routing,
  }))
  const gets: Parameters<NativeCustodyClient['getScoped']>[0][] = []
  const reports: Parameters<
    NativeCustodyClient['reportAuthFailureScoped']
  >[0][] = []
  const credentialId = 'oauth:anthropic'
  const client: NativeCustodyClient = {
    async listScoped() {
      return {
        view: 'oc2-native-view',
        rows: [
          {
            id: credentialId,
            accountId: identity,
            credentialType: 'oauth',
            categories: ['anthropic-native'],
            refreshAdapter: 'anthropic',
            serves: ['anthropic'],
            providerIds: [],
            operations: ['read'],
            state: 'active',
            recordVersion: 7,
            createdAtMs: null,
          },
        ],
      }
    },
    async getScoped(input) {
      gets.push(input)
      const version =
        versions[Math.min(gets.length - 1, versions.length - 1)] ?? 7
      return {
        credentialId,
        accountId: servedIdentity(gets.length),
        material: `sk-ant-oat01-vault-${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 3600_000,
      }
    },
    async reportAuthFailureScoped(input) {
      reports.push(input)
    },
    close() {},
  }
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env,
      connect: async () => client,
      readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    },
  })
  await runtime.vault.refresh()
  const roster = await runtime.vault.read()
  const primary = roster?.rows.find((row) => row.credentialId === credentialId)
  if (!primary) throw new Error('Native vault seed has no asserted primary')
  await store.updateSettings((settings) => ({
    ...settings,
    mainAccountId: primary.routeId,
    claustrum: {
      primaryAccount: { credentialId, accountId: identity, state: 'active' },
    },
  }))
  cleanups.push(() => runtime.close())
  return { runtime, paths, store, localStore, env, gets, reports }
}

/**
 * A vault that holds the default Claude account (credential oauth:anthropic)
 * and one fallback account, with sticky-balanced routing. `setDefaultIdentity`
 * makes the vault report a different account UUID for the default credential,
 * as when its Claude account is replaced.
 */
async function vaultWithFallback() {
  const { paths, env } = await storage()
  await writeFile(
    env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const store = createNativePoolStore({
    paths: nativeVaultPaths(paths),
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  await store.updateSettings(() => ({
    quota: { enabled: false },
    routing: { mode: 'sticky-balanced' },
  }))
  const identities = new Map([
    ['oauth:anthropic', identity],
    ['oauth:anthropic:work', fallbackIdentity],
  ])
  const row = (credentialId: string) => ({
    id: credentialId,
    accountId: identities.get(credentialId) ?? '',
    credentialType: 'oauth' as const,
    categories: ['anthropic-native'],
    refreshAdapter: 'anthropic',
    serves: ['anthropic'],
    providerIds: [],
    operations: ['read'],
    state: 'active',
    recordVersion: 7,
    createdAtMs: null,
  })
  const client: NativeCustodyClient = {
    async listScoped() {
      return {
        view: `oc2-view-${[...identities.values()].join('-')}`,
        rows: [...identities.keys()].map(row),
      }
    },
    async getScoped(input) {
      return {
        credentialId: input.credentialId,
        accountId: identities.get(input.credentialId),
        material: `sk-ant-oat01-${input.credentialId}`,
        recordVersion: 7,
        expiresAtMs: Date.now() + 3600_000,
      }
    },
    async reportAuthFailureScoped() {},
    close() {},
  }
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env,
      connect: async () => client,
      readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    },
  })
  cleanups.push(() => runtime.close())
  await runtime.vault.refresh()
  const roster = await runtime.vault.read()
  const primary = roster?.rows.find(
    (entry) => entry.credentialId === 'oauth:anthropic',
  )
  if (!primary) throw new Error('Vault seed has no default account')
  await store.updateSettings((settings) => ({
    ...settings,
    mainAccountId: primary.routeId,
    claustrum: {
      primaryAccount: {
        credentialId: 'oauth:anthropic',
        accountId: identity,
        state: 'active',
      },
    },
  }))
  return {
    paths,
    runtime,
    setDefaultIdentity: (next: string) => {
      identities.set('oauth:anthropic', next)
    },
  }
}
/** The exact stored JSON of one session's pin; sessions are stored under SHA-256 keys. */
function rawPin(text: string, sessionID: string) {
  const key = createHash('sha256').update(sessionID).digest('hex')
  // Pins hold only scalar fields and brace-free strings, so the object's
  // bytes end at its first closing brace.
  const match = text.match(new RegExp(`"${key}":\\s*(\\{[^}]*\\})`))
  if (!match?.[1]) throw new Error('Expected pin is missing')
  return match[1]
}

describe('OC2 source over actual native services', () => {
  test('queued newer vault receipts recheck exact-model admission after a relay-config wait', async () => {
    const fixture = await vault([7, 8, 8])
    const native = source(fixture.runtime, fixture.paths)
    const fable = { ...scope, modelID: 'claude-fable-5-1' }
    const first = await native.authorizeAccount(fable, 'main')
    if (!first) throw new Error('Initial native authorization was refused')
    const limit = await native.limitFromResponse?.({
      ...context(first.provenance),
      modelID: fable.modelID,
      status: 401,
      headers: new Headers({ 'request-id': 'req_native_rejected' }),
      body: async () => '{}',
    })
    if (!limit) throw new Error('Newer native receipt was not offered')
    const receipt = await fixture.runtime.authorizeVault('main')
    const quota = (remainingPercent: number) => {
      const checkedAt = Date.now()
      return {
        accountIdentity: identity,
        checkedAt,
        five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
        scoped: [
          {
            id: 'seven_day_fable',
            title: 'Fable weekly',
            modelId: fable.modelID,
            modelName: 'Fable 5.1',
            usedPercent: 100 - remainingPercent,
            remainingPercent,
            checkedAt,
          },
        ],
      }
    }
    await fixture.runtime.vault.publish(receipt, { quota: quota(100) })
    expect(
      await native.chooseAccount({
        ...fable,
        rerouteFrom: { accountId: 'main', limit },
      }),
    ).toBe('main')
    await fixture.runtime.updateRelay({
      enabled: true,
      transport: 'http',
      url: 'https://relay.invalid',
      token: 'synthetic-relay-token',
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = fixture.runtime.getRelayConfig.bind(fixture.runtime)
    const delayed = spyOn(fixture.runtime, 'getRelayConfig').mockImplementation(
      async () => {
        entered.resolve()
        await release.promise
        return original()
      },
    )
    cleanups.push(() => {
      release.resolve()
      delayed.mockRestore()
    })
    const pending = native.authorizeAccount(fable, 'main')
    await entered.promise
    await fixture.runtime.vault.publish(receipt, { quota: quota(0) })
    release.resolve()
    expect(await pending).toBeUndefined()
    delayed.mockRestore()
    expect((await native.authorizeAccount(scope, 'main'))?.route).toBe('oauth')
    expect(fixture.reports.map((report) => report.recordVersion)).toEqual([7])
  })
  test('final dispatch admission closes a paid route whose general exhaustion ended after authorization', async () => {
    const fixture = await local()
    await fixture.runtime.addApi({
      routeId: 'paid',
      apiKey: 'synthetic-api-key',
      baseURL: 'https://api-route.invalid',
      authHeader: 'x-api-key',
    })
    const localCredential = await fixture.runtime.authorizeLocal('main')
    if (localCredential.status !== 'usable')
      throw new Error('Native proof was not admitted')
    const quota = (remainingPercent: number) => {
      const checkedAt = Date.now()
      return {
        accountIdentity: identity,
        checkedAt,
        five_hour: {
          usedPercent: 100 - remainingPercent,
          remainingPercent,
          checkedAt,
        },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
      }
    }
    await fixture.runtime.publishLocal(localCredential.subject, {
      quota: quota(0),
    })
    const native = source(fixture.runtime, fixture.paths)
    const auth = await native.authorizeAccount(scope, 'paid')
    if (auth?.route !== 'api')
      throw new Error('Confirmed general exhaustion did not admit paid route')
    await fixture.runtime.publishLocal(localCredential.subject, {
      quota: quota(100),
    })
    await expect(
      native.admitRequest?.({
        ...context(auth.provenance),
        accountId: 'paid',
        route: 'api',
      }),
    ).rejects.toThrow('policy changed before dispatch')
    expect((await native.authorizeAccount(scope, 'main'))?.route).toBe('oauth')
  })
  test('delayed vault authorization rechecks exact-model policy before releasing a bearer', async () => {
    const fixture = await vault([7, 7, 7])
    const receipt = await fixture.runtime.authorizeVault('main')
    const quota = (remainingPercent: number) => {
      const checkedAt = Date.now()
      return {
        accountIdentity: identity,
        checkedAt,
        five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
        scoped: [
          {
            id: 'seven_day_fable',
            title: 'Fable weekly',
            modelId: 'claude-fable-5-1',
            modelName: 'Fable 5.1',
            usedPercent: 100 - remainingPercent,
            remainingPercent,
            checkedAt,
          },
        ],
      }
    }
    await fixture.runtime.vault.publish(receipt, { quota: quota(100) })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = fixture.runtime.authorizeVault.bind(fixture.runtime)
    const delayed = spyOn(fixture.runtime, 'authorizeVault').mockImplementation(
      async (...args) => {
        entered.resolve()
        await release.promise
        return original(...args)
      },
    )
    cleanups.push(() => {
      release.resolve()
      delayed.mockRestore()
    })
    const native = source(fixture.runtime, fixture.paths)
    const pending = native.authorizeAccount(
      { ...scope, modelID: 'claude-fable-5-1' },
      'main',
    )
    await entered.promise
    await fixture.runtime.vault.publish(receipt, { quota: quota(0) })
    release.resolve()
    expect(await pending).toBeUndefined()
    delayed.mockRestore()
    expect((await native.authorizeAccount(scope, 'main'))?.route).toBe('oauth')
    expect(fixture.reports).toHaveLength(0)
  })
  test('delayed paid API authorization rechecks general exhaustion before releasing a key', async () => {
    const fixture = await local()
    await fixture.runtime.addApi({
      routeId: 'paid',
      apiKey: 'synthetic-api-key',
      baseURL: 'https://api-route.invalid',
      authHeader: 'x-api-key',
    })
    const localCredential = await fixture.runtime.authorizeLocal('main')
    if (localCredential.status !== 'usable')
      throw new Error('Native proof was not admitted')
    const quota = (remainingPercent: number) => {
      const checkedAt = Date.now()
      return {
        accountIdentity: identity,
        checkedAt,
        five_hour: {
          usedPercent: 100 - remainingPercent,
          remainingPercent,
          checkedAt,
        },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
      }
    }
    await fixture.runtime.publishLocal(localCredential.subject, {
      quota: quota(0),
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = fixture.runtime.authorizeApi.bind(fixture.runtime)
    const delayed = spyOn(fixture.runtime, 'authorizeApi').mockImplementation(
      async (...args) => {
        entered.resolve()
        await release.promise
        return original(...args)
      },
    )
    cleanups.push(() => {
      release.resolve()
      delayed.mockRestore()
    })
    const native = source(fixture.runtime, fixture.paths)
    const pending = native.authorizeAccount(scope, 'paid')
    await entered.promise
    await fixture.runtime.publishLocal(localCredential.subject, {
      quota: quota(100),
    })
    release.resolve()
    expect(await pending).toBeUndefined()
  })
  test('model aliases use request-local scoped quota without contaminating other model requests', async () => {
    const fixture = await local()
    const authorized = await fixture.runtime.authorizeLocal('main')
    if (authorized.status !== 'usable')
      throw new Error('Native proof was not admitted')
    const checkedAt = Date.now()
    await fixture.runtime.publishLocal(authorized.subject, {
      quota: {
        accountIdentity: identity,
        checkedAt,
        five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
        scoped: [
          {
            id: 'seven_day_fable',
            title: 'Fable weekly',
            modelId: 'claude-fable-5-1',
            modelName: 'Fable 5.1',
            usedPercent: 100,
            remainingPercent: 0,
            checkedAt,
          },
        ],
      },
    })
    const native = createNativeAnthropicSource({
      runtime: fixture.runtime,
      paths: fixture.paths,
      requestOptions: () => ({}),
      resolveModelId: async (input) =>
        input.modelID === 'custom-fable' ? 'claude-fable-5-1' : input.modelID,
    })
    cleanups.push(() => native.close())
    expect(
      await native.chooseAccount({ ...scope, modelID: 'custom-fable' }),
    ).toBeUndefined()
    expect(await native.chooseAccount(scope)).toBe('main')
    expect(
      await native.authorizeAccount(
        { ...scope, modelID: 'custom-fable' },
        'main',
      ),
    ).toBeUndefined()
  })
  test('paid API credentials require fresh general OAuth exhaustion, not a scoped window alone', async () => {
    const fixture = await local()
    await fixture.runtime.addApi({
      routeId: 'paid',
      apiKey: 'synthetic-api-key',
      baseURL: 'https://api-route.invalid',
      authHeader: 'x-api-key',
    })
    const authorized = await fixture.runtime.authorizeLocal('main')
    if (authorized.status !== 'usable')
      throw new Error('Native proof was not admitted')
    const native = source(fixture.runtime, fixture.paths)
    const checkedAt = Date.now()
    const quota = {
      accountIdentity: identity,
      checkedAt,
      five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt },
      seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
      scoped: [
        {
          id: 'seven_day_fable',
          title: 'Fable weekly',
          modelId: 'claude-fable-5-1',
          modelName: 'Fable 5.1',
          usedPercent: 100,
          remainingPercent: 0,
          checkedAt,
        },
      ],
    }
    await fixture.runtime.publishLocal(authorized.subject, { quota })
    expect(
      await native.authorizeAccount(
        { ...scope, modelID: 'claude-fable-5-1' },
        'paid',
      ),
    ).toBeUndefined()
    await fixture.runtime.publishLocal(authorized.subject, {
      quota: {
        ...quota,
        five_hour: { usedPercent: 100, remainingPercent: 0, checkedAt },
      },
    })
    const api = await native.authorizeAccount(scope, 'paid')
    expect(api?.route).toBe('api')
    if (api?.route !== 'api')
      throw new Error('Confirmed exhaustion did not admit API route')
    expect(api.headers['x-api-key']).toBe('synthetic-api-key')
  })
  test('local serving uses positive native proof and never the poisoned legacy credentials', async () => {
    const fixture = await local()
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const auth = await native.authorizeAccount(scope, 'main')
    expect(auth?.route).toBe('oauth')
    if (auth?.route !== 'oauth')
      throw new Error('Local native authorization refused')
    expect(auth.accessToken).toBe('sk-ant-oat01-native-only')
    expect(auth.provenance.kind).toBe('local')
    expect(JSON.stringify(auth.provenance)).not.toContain(auth.accessToken)
    const snapshot = await fixture.runtime.read()
    expect(JSON.stringify(snapshot)).not.toContain('native-only-refresh')
    expect(JSON.stringify(snapshot)).not.toContain(auth.accessToken)
  })
  test('genuine header quota is account/version bound and persists through native publication', async () => {
    const fixture = await local()
    const native = source(fixture.runtime, fixture.paths)
    const auth = await native.authorizeAccount(scope, 'main')
    if (!auth) throw new Error('Native authorization refused')
    const request = context(auth.provenance)
    const quota = native.quotaFromHeaders?.(
      new Headers({
        'request-id': 'req_native_oc2',
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
      }),
      { ...request, status: 200 },
    )
    expect(quota?.five_hour?.remainingPercent).toBe(58)
    await native.onAttemptEnd?.(request, { status: 200, outputStarted: true })
    const view = await fixture.runtime.read()
    expect(
      view.accounts.find((account) => account.id === 'main')?.quota?.five_hour
        ?.remainingPercent,
    ).toBe(58)
    expect(
      view.accounts.find((account) => account.id === 'main')?.quota
        ?.accountIdentity,
    ).toBe(identity)
  })
  test('selected WebSocket is refused from secret-free policy before any vault get or provider send', async () => {
    const fixture = await vault()
    await fixture.runtime.updateRelay({
      enabled: true,
      transport: 'websocket',
      url: 'https://relay.invalid',
      token: 'synthetic-relay-token',
    })
    const native = source(fixture.runtime, fixture.paths)
    const adapter = createNativeAnthropicAdapter({ source: native })
    await expect(adapter.adapter.chooseAccount(scope)).rejects.toBeInstanceOf(
      NativeAnthropicTransportRefusal,
    )
    expect(fixture.gets).toHaveLength(0)
    expect(fixture.reports).toHaveLength(0)
  })
  test('vault 401 reports each physical version and permits exactly one strict-newer same-account retry', async () => {
    const fixture = await vault()
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const first = await native.authorizeAccount(scope, 'main')
    if (!first) throw new Error('Vault authorization refused')
    const firstAttempt = context(first.provenance)
    const limit = await native.limitFromResponse?.({
      ...firstAttempt,
      status: 401,
      headers: new Headers({ 'request-id': 'req_vault_one' }),
      body: async () => '{}',
    })
    expect(limit?.status).toBe(401)
    if (!limit) throw new Error('Strict-newer retry was not offered')
    expect(
      await native.chooseAccount({
        ...scope,
        rerouteFrom: { accountId: 'main', limit },
      }),
    ).toBe('main')
    const second = await native.authorizeAccount(scope, 'main')
    if (second?.route !== 'oauth')
      throw new Error('Retry authorization refused')
    expect(second.accessToken).toBe('sk-ant-oat01-vault-8')
    expect(JSON.stringify(second.provenance)).not.toContain(second.accessToken)
    await native.onAttemptEnd?.(firstAttempt, {
      status: 401,
      outputStarted: false,
    })
    const secondAttempt = context(second.provenance, 'attempt-two')
    expect(
      await native.limitFromResponse?.({
        ...secondAttempt,
        status: 401,
        headers: new Headers({ 'request-id': 'req_vault_two' }),
        body: async () => '{}',
      }),
    ).toBeUndefined()
    await native.onAttemptEnd?.(secondAttempt, {
      status: 401,
      outputStarted: false,
    })
    expect(fixture.gets).toHaveLength(2)
    expect(fixture.reports.map((report) => report.recordVersion)).toEqual([
      7, 8,
    ])
  })
  test('unchanged vault version cannot authorize a 401 retry', async () => {
    const fixture = await vault([7, 7])
    const native = source(fixture.runtime, fixture.paths)
    await native.chooseAccount(scope)
    const auth = await native.authorizeAccount(scope, 'main')
    if (!auth) throw new Error('Vault authorization refused')
    expect(
      await native.limitFromResponse?.({
        ...context(auth.provenance),
        status: 401,
        headers: new Headers({ 'request-id': 'req_unchanged' }),
        body: async () => '{}',
      }),
    ).toBeUndefined()
    expect(fixture.reports.map((report) => report.recordVersion)).toEqual([7])
  })
  test('relay-to-direct fallback obtains a fresh receipt and does not report the relay-local 401', async () => {
    const fixture = await vault([7, 8])
    await fixture.runtime.updateRelay({
      enabled: true,
      transport: 'http',
      url: 'https://relay.invalid',
      fallbackToDirect: true,
      token: 'synthetic-relay-token',
    })
    const native = source(fixture.runtime, fixture.paths)
    await native.chooseAccount(scope)
    const first = await native.authorizeAccount(scope, 'main')
    if (!first) throw new Error('Vault authorization refused')
    expect(first.dispatch?.kind).toBe('http-relay')
    const limit = await native.limitFromRelayFailure?.({
      ...context(first.provenance),
      dispatch: 'http-relay',
      status: 401,
    })
    if (!limit) throw new Error('Direct fallback was not offered')
    await native.onAttemptEnd?.(
      { ...context(first.provenance), dispatch: 'http-relay' },
      { outputStarted: false },
    )
    await native.chooseAccount({
      ...scope,
      rerouteFrom: { accountId: 'main', limit },
    })
    const direct = await native.authorizeAccount(scope, 'main')
    expect(direct?.dispatch?.kind).toBe('direct')
    if (direct?.route !== 'oauth')
      throw new Error('Direct authorization refused')
    expect(direct.accessToken).toBe('sk-ant-oat01-vault-8')
    expect(fixture.gets).toHaveLength(2)
    expect(fixture.reports).toHaveLength(0)
  })
  test('vault session affinity is kept in the vault routing file and never in the local one', async () => {
    const fixture = await vault([7, 8], () => identity, {
      mode: 'sticky-balanced',
    })
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const snapshot = await fixture.runtime.read()
    if (!snapshot.routingPath)
      throw new Error('Vault mode named no routing file')
    const localRouting = getStickyRoutingStatePath(fixture.paths.legacyConfig)
    expect(snapshot.routingPath).not.toBe(localRouting)
    // Sessions are stored under hashed keys; count the assignments instead.
    const assignments = async (path: string) =>
      Object.values(
        (
          JSON.parse(await readFile(path, 'utf8')) as {
            assignments: Record<string, { accountId: string }>
          }
        ).assignments,
      ).map((assignment) => assignment.accountId)
    expect(await assignments(snapshot.routingPath)).toEqual(['main'])
    expect(await exists(localRouting)).toBe(false)
    await native.resetRouting(scope.sessionID)
    expect(await assignments(snapshot.routingPath)).toEqual([])
    expect(await exists(localRouting)).toBe(false)
  })
  test('replacing the vault default account re-places only its session and an unrelated fallback session pin survives unchanged', async () => {
    const fixture = await vaultWithFallback()
    const native = source(fixture.runtime, fixture.paths)
    const before = await fixture.runtime.read()
    const fallbackRoute = before.accounts.find(
      (account) => account.accountIdentity === fallbackIdentity,
    )?.id
    if (!fallbackRoute) throw new Error('Fallback vault account is missing')
    const mainSession = { ...scope, sessionID: 'ses_vault_main' }
    const fallbackSession = { ...scope, sessionID: 'ses_vault_fallback' }
    expect(await native.chooseAccount(mainSession)).toBe('main')
    // A session refused on main moves to the fallback and is pinned there.
    expect(
      await native.chooseAccount({
        ...fallbackSession,
        rerouteFrom: {
          accountId: 'main',
          limit: { reason: 'provider-overloaded', status: 529 },
        },
      }),
    ).toBe(fallbackRoute)
    const routing = before.routingPath
    if (!routing) throw new Error('Vault mode named no routing file')
    const pinned = await readFile(routing, 'utf8')
    expect(JSON.parse(rawPin(pinned, mainSession.sessionID))).toMatchObject({
      accountId: 'main',
      accountIdentity: identity,
    })
    const fallbackPin = rawPin(pinned, fallbackSession.sessionID)
    expect(JSON.parse(fallbackPin)).toMatchObject({
      accountId: fallbackRoute,
      accountIdentity: fallbackIdentity,
    })

    fixture.setDefaultIdentity(changedIdentity)
    await fixture.runtime.vault.refresh()
    const after = await fixture.runtime.read()
    const replaced = after.accounts.find(
      (account) => account.accountIdentity === changedIdentity,
    )
    if (!replaced) throw new Error('Replaced default account is missing')
    const choice = await native.chooseAccount(mainSession)
    const repinned = JSON.parse(
      rawPin(await readFile(routing, 'utf8'), mainSession.sessionID),
    )
    expect(repinned.accountId).toBe(choice)
    expect(repinned.accountIdentity).toBe(
      after.accounts.find((account) => account.id === choice)?.accountIdentity,
    )
    expect(repinned.accountIdentity).not.toBe(identity)
    expect(
      rawPin(await readFile(routing, 'utf8'), fallbackSession.sessionID),
    ).toBe(fallbackPin)
    expect(await native.chooseAccount(fallbackSession)).toBe(fallbackRoute)
  })
  test('local sticky routing records no account UUID in its session pins', async () => {
    const fixture = await local()
    await fixture.store.updateSettings((settings) => ({
      ...settings,
      routing: { mode: 'sticky-balanced' },
    }))
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const snapshot = await fixture.runtime.read()
    expect(snapshot.routingPath).toBeUndefined()
    const pin = JSON.parse(
      rawPin(
        await readFile(
          getStickyRoutingStatePath(fixture.paths.legacyConfig),
          'utf8',
        ),
        scope.sessionID,
      ),
    )
    expect(pin.accountId).toBe('main')
    expect(pin).not.toHaveProperty('accountIdentity')
  })
  test('a vault credential that now asserts a different account UUID is refused instead of serving under the old identity', async () => {
    const fixture = await vault([7, 8], () => changedIdentity)
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    await expect(native.authorizeAccount(scope, 'main')).rejects.toThrow(
      'identity-changed',
    )
    expect(fixture.gets).toHaveLength(1)
  })
  test('a 401 retry is not offered when the newer vault version belongs to a different account UUID', async () => {
    const fixture = await vault([7, 8], (get) =>
      get <= 1 ? identity : changedIdentity,
    )
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const first = await native.authorizeAccount(scope, 'main')
    if (!first) throw new Error('Vault authorization refused')
    expect(
      await native.limitFromResponse?.({
        ...context(first.provenance),
        status: 401,
        headers: new Headers({ 'request-id': 'req_vault_changed' }),
        body: async () => '{}',
      }),
    ).toBeUndefined()
    expect(fixture.gets).toHaveLength(2)
    expect(fixture.reports.map((report) => report.recordVersion)).toEqual([7])
  })
})

describe('OC2 Claude sign-in over the actual native account runtime', () => {
  test('a completed local sign-in stores an OAuth account holding only the token fields', async () => {
    const fixture = await local({
      resolveIdentity: async () => ({ accountUuid: changedIdentity }) as never,
    })
    const registration = await registeredLogin({
      isActive: () => true,
      readMode: async () => 'local',
      runtime: fixture.runtime,
      authorize: async () => ({
        url: 'https://claude.invalid/authorize',
        redirectUri: 'https://claude.invalid/callback',
        state: 'synthetic-state',
        verifier: 'synthetic-verifier',
      }),
      exchange: async () => ({
        type: 'success',
        access: 'sk-ant-oat01-signed-in',
        refresh: 'signed-in-refresh',
        expires: Date.now() + 3600_000,
      }),
    })
    const pending = await registration.authorize({})
    if (pending.mode !== 'code') throw new Error('A pasted code is required')
    await pending.callback('synthetic-code')
    const read = await fixture.store.read()
    if (read.status !== 'ready') throw new Error('Pool unreadable')
    const credentials = read.rows.map((row) => row.credential)
    const signedIn = credentials.find(
      (credential) =>
        credential?.type === 'oauth' &&
        credential.access === 'sk-ant-oat01-signed-in',
    )
    expect(signedIn).toBeDefined()
    expect(credentials.some((credential) => credential?.type !== 'oauth')).toBe(
      false,
    )
    const view = await fixture.runtime.read()
    const main = view.accounts.find((account) => account.id === 'main')
    expect(main?.type).toBe('oauth')
    expect(main?.accountIdentity).toBe(changedIdentity)
  })
  test('enrollment files make OpenCode refuse local sign-in and accept vault activation without touching local accounts', async () => {
    const fixture = await vault()
    const before = await readFile(fixture.paths.config, 'utf8')
    const input = {
      isActive: () => true,
      readMode: () => readNativeEnrollmentMode('opencode', fixture.env),
      runtime: fixture.runtime,
    }
    const local = await registeredLogin(input)
    await expect(local.authorize({})).rejects.toThrow(
      LOCAL_LOGIN_REFUSED_IN_VAULT,
    )
    const activation = await registeredLogin(
      input,
      CLAUDE_VAULT_ACTIVATION_METHOD_ID,
    )
    const pending = await activation.authorize({})
    if (pending.mode !== 'auto')
      throw new Error('Vault activation must need no user step')
    const marker = await pending.callback
    expect(String(marker.methodID)).toBe(CLAUDE_VAULT_ACTIVATION_METHOD_ID)
    expect(await readFile(fixture.paths.config, 'utf8')).toBe(before)
    const snapshot = await fixture.runtime.read()
    expect(snapshot.mode).toBe('claustrum')
    expect(snapshot.accounts.map((account) => account.source)).toEqual([
      'vault',
    ])
  })
  test('without enrollment files vault activation is refused and the local account stays served', async () => {
    const fixture = await local()
    const activation = await registeredLogin(
      {
        isActive: () => true,
        readMode: () => readNativeEnrollmentMode('opencode', fixture.env),
        runtime: fixture.runtime,
      },
      CLAUDE_VAULT_ACTIVATION_METHOD_ID,
    )
    const pending = await activation.authorize({})
    if (pending.mode !== 'auto')
      throw new Error('Vault activation must need no user step')
    await expect(pending.callback).rejects.toThrow(
      VAULT_ACTIVATION_REFUSED_LOCALLY,
    )
    const snapshot = await fixture.runtime.read()
    expect(snapshot.mode).toBe('local')
    expect(
      snapshot.accounts.find((account) => account.id === 'main')?.source,
    ).toBe('local')
  })
})

describe('OC2 vault enrollment callbacks for the claude menu', () => {
  test('disconnect ends vault enrollment so the runtime serves local accounts, without touching OpenCode sign-ins', async () => {
    const fixture = await vault()
    const dataHome = join(dirname(fixture.paths.config), 'data')
    const hostAuth = join(dataHome, 'opencode', 'auth.json')
    await mkdir(dirname(hostAuth), { recursive: true })
    const stored = JSON.stringify({
      anthropic: { type: 'api', key: 'stock-opencode-key' },
    })
    await writeFile(hostAuth, stored, { mode: 0o600 })
    const callbacks = nativeEnrollmentCallbacks({
      ...fixture.env,
      XDG_DATA_HOME: dataHome,
    })
    expect(await callbacks.readMode()).toBe('claustrum')
    expect((await fixture.runtime.read()).mode).toBe('claustrum')
    expect(await callbacks.disconnectVault()).toBe('disconnected')
    expect(await callbacks.readMode()).toBe('local')
    expect((await fixture.runtime.read()).mode).toBe('local')
    expect(await readFile(hostAuth, 'utf8')).toBe(stored)
  })
  test('disconnect without vault enrollment changes nothing and local accounts stay served', async () => {
    const fixture = await local()
    const callbacks = nativeEnrollmentCallbacks(fixture.env)
    expect(await callbacks.readMode()).toBe('local')
    expect(await callbacks.disconnectVault()).toBe('idle')
    const snapshot = await fixture.runtime.read()
    expect(snapshot.mode).toBe('local')
    expect(
      snapshot.accounts.find((account) => account.id === 'main')?.source,
    ).toBe('local')
  })
})
