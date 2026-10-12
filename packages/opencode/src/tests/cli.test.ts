import { describe, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeAccountRuntime,
  createNativePoolStore,
  getAccountStatePath,
  getHostClaustrumEnrollmentPaths,
  readNativeEnrollmentMode,
  resetClaudeCodeIdentityCachesForTest,
} from '@cortexkit/anthropic-auth-core'

import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime'
import { addApiRoute, login, relaySetup } from '../cli'
import { migrateNativeOpencodeFixture } from './native-fixture'

const lifetime = createTestLifetimeSuite()
const test = lifetime.test

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-cli-test-'))
  lifetime.deferCleanup(() => rm(root, { recursive: true, force: true }))
  return root
}

async function readStoredBytes(path: string) {
  try {
    return await readFile(path)
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined
    throw error
  }
}

async function readNativeRows(
  fixture: Awaited<ReturnType<typeof nativeFixture>>,
) {
  const view = await createNativePoolStore({
    paths: fixture.paths,
    quota: nativeQuotaCodec,
  }).read()
  expect(view.status).toBe('ready')
  if (view.status !== 'ready') throw new Error('Native API pool did not load')
  return view.rows
}

const cliAccountUuid = '00000000-0000-4000-8000-000000000111'

function interceptBootstrap() {
  const original = globalThis.fetch
  const tokens: string[] = []
  resetClaudeCodeIdentityCachesForTest()
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      )
      if (
        url.origin !== 'https://api.anthropic.com' ||
        url.pathname !== '/api/claude_cli/bootstrap'
      )
        throw new Error(`Unexpected CLI test request: ${url.pathname}`)
      const authorization = new Headers(init?.headers).get('authorization')
      if (!authorization?.startsWith('Bearer sk-ant-oat01-'))
        throw new Error('CLI bootstrap did not use OAuth credentials')
      tokens.push(authorization)
      return Response.json({ oauth_account: { account_uuid: cliAccountUuid } })
    },
    { preconnect: original.preconnect },
  )
  lifetime.deferCleanup(() => {
    globalThis.fetch = original
    resetClaudeCodeIdentityCachesForTest()
  })
  return tokens
}

async function nativeFixture(
  root: string,
  legacyConfig: Parameters<
    typeof migrateNativeOpencodeFixture
  >[0]['legacyConfig'] = { version: 1, accounts: [] },
  legacyState?: Parameters<
    typeof migrateNativeOpencodeFixture
  >[0]['legacyState'],
) {
  return migrateNativeOpencodeFixture({
    root,
    lifetime,
    legacyConfig,
    legacyState,
  })
}

/**
 * Put this host's Claustrum enrollment files in a state setup leaves after
 * enrollment: an owner-only token file, or an approved enrollment record whose
 * token file is missing. Core's readNativeEnrollmentMode reports vault
 * ('claustrum') mode for both, and the CLI must then use the vault for
 * credentials; the local account pool holds no mode flag.
 */
async function enrollVault(
  env: Record<string, string>,
  kind: 'token' | 'approved-without-token' = 'token',
) {
  const paths = getHostClaustrumEnrollmentPaths('opencode', env)
  if (kind === 'token')
    await writeFile(
      paths.tokenPath,
      JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
      { mode: 0o600, flag: 'wx' },
    )
  else
    await writeFile(
      paths.statePath,
      JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: 'anthropic-auth-opencode',
        tokenGeneration: 1,
        updatedAt: 1,
      }),
      { mode: 0o600, flag: 'wx' },
    )
  const written = kind === 'token' ? paths.tokenPath : paths.statePath
  expect((await stat(written)).mode & 0o777).toBe(0o600)
  expect(await readNativeEnrollmentMode('opencode', env)).toBe('claustrum')
}

const enrollmentKinds = ['token', 'approved-without-token'] as const
/**
 * Every file under the fixture root with its bytes and permission bits, so a
 * refused command can be shown to have created, changed or removed nothing.
 */
async function rootFiles(root: string) {
  const files: Record<string, { mode: number; bytes: string }> = {}
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = join(entry.parentPath, entry.name)
    const info = await stat(path)
    files[path] = {
      mode: info.mode & 0o777,
      bytes: entry.isFile() ? (await readFile(path)).toString('base64') : '',
    }
  }
  return files
}

// Inject prompts and OAuth responses so command tests never open a browser
// or use interactive stdin. Storage assertions still read the actual files.

// Run a command body against a temp account file, restoring any env we touch.
async function withAccountEnv<T>(
  accountPath: string,
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const keys = ['OPENCODE_ANTHROPIC_AUTH_FILE', ...Object.keys(env)]
  const prev = new Map(keys.map((k) => [k, process.env[k]]))
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('CLI api add', () => {
  test('saves API route config and stores API key only in private pool state', async () => {
    const tempDir = await createRoot()
    const fixture = await nativeFixture(tempDir)
    const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE

    await withAccountEnv(
      accountPath,
      {
        ...fixture.env,
        OPENCODE_ANTHROPIC_AUTH_API_BASE_URL: 'https://api.kie.ai/claude',
        OPENCODE_ANTHROPIC_AUTH_API_KEY: 'kie-key',
        OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER: 'authorization-bearer',
      },
      () =>
        addApiRoute('kie-opus', {
          prompt: async () => {
            throw new Error('prompt should not be called: all inputs from env')
          },
        }),
    )

    const rows = await readNativeRows(fixture)
    const account = rows.find((row) => row.id === 'kie-opus')
    expect(account).toMatchObject({
      id: 'kie-opus',
      label: 'kie-opus',
      type: 'api',
      enabled: true,
      stamp: 'bound',
      credential: {
        type: 'api',
        apiKey: 'kie-key',
        baseURL: 'https://api.kie.ai/claude',
        authHeader: 'authorization-bearer',
      },
    })
    expect(await readFile(fixture.paths.config, 'utf8')).not.toContain(
      'kie-key',
    )
    expect(await readFile(fixture.paths.state, 'utf8')).toContain('kie-key')
    await expect(readFile(accountPath, 'utf8')).rejects.toThrow()
  })

  test('rejects invalid API base URL before saving route state', async () => {
    const tempDir = await createRoot()
    const fixture = await nativeFixture(tempDir)
    const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE
    const before = await Promise.all([
      readStoredBytes(fixture.paths.config),
      readStoredBytes(fixture.paths.state),
    ])

    const promise = withAccountEnv(
      accountPath,
      {
        ...fixture.env,
        OPENCODE_ANTHROPIC_AUTH_API_BASE_URL: 'https://secret@example.com/v1',
        OPENCODE_ANTHROPIC_AUTH_API_KEY: 'kie-key',
        OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER: 'authorization-bearer',
      },
      () =>
        addApiRoute('bad-api', {
          prompt: async () => '',
        }),
    )

    await expect(promise).rejects.toThrow(
      'API fallback base URL must be an http(s) URL',
    )

    expect(
      await Promise.all([
        readStoredBytes(fixture.paths.config),
        readStoredBytes(fixture.paths.state),
      ]),
    ).toEqual(before)
    expect(await readNativeRows(fixture)).toEqual([])
    await expect(readFile(accountPath, 'utf8')).rejects.toThrow()
  })

  for (const kind of enrollmentKinds) {
    test(`refuses with a vault enrollment (${kind}) before asking for a key and writes nothing`, async () => {
      const tempDir = await createRoot()
      const fixture = await nativeFixture(tempDir)
      const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE
      await enrollVault(fixture.env, kind)
      const before = await rootFiles(fixture.root)
      const asked: string[] = []

      await expect(
        withAccountEnv(
          accountPath,
          {
            ...fixture.env,
            OPENCODE_ANTHROPIC_AUTH_API_BASE_URL: undefined,
            OPENCODE_ANTHROPIC_AUTH_API_KEY: undefined,
            OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER: undefined,
          },
          () =>
            addApiRoute(undefined, {
              prompt: async (message) => {
                asked.push(message)
                return 'vault-mode-key'
              },
            }),
        ),
      ).rejects.toThrow('Disconnect from the vault first.')
      expect(asked).toEqual([])
      expect(await rootFiles(fixture.root)).toEqual(before)
    })
  }

  test('writes nothing when setup enrolls the host while the key is entered', async () => {
    const tempDir = await createRoot()
    const fixture = await nativeFixture(tempDir)
    const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE
    let enrolled: Awaited<ReturnType<typeof rootFiles>> | undefined

    await expect(
      withAccountEnv(
        accountPath,
        {
          ...fixture.env,
          OPENCODE_ANTHROPIC_AUTH_API_BASE_URL: 'https://api.kie.ai/claude',
          OPENCODE_ANTHROPIC_AUTH_API_KEY: undefined,
          OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER: 'x-api-key',
        },
        () =>
          addApiRoute('late-api', {
            // Offline setup enrolls this host with the Claustrum vault while
            // the user is still typing the key.
            prompt: async (message) => {
              expect(message).toBe('API key: ')
              await enrollVault(fixture.env)
              enrolled = await rootFiles(fixture.root)
              return 'late-api-key'
            },
          }),
      ),
    ).rejects.toThrow('Disconnect from the vault first.')
    expect(enrolled).toBeDefined()
    expect(await rootFiles(fixture.root)).toEqual(enrolled!)
    expect(await readNativeRows(fixture)).toEqual([])
    for (const file of Object.values(await rootFiles(fixture.root)))
      expect(Buffer.from(file.bytes, 'base64').toString()).not.toContain(
        'late-api-key',
      )
  })
})

describe('CLI vault refusal', () => {
  test('refuses from enrollment alone, before the local account pool is read', async () => {
    const tempDir = await createRoot()
    // Setup never migrated a local account pool into this directory, so a
    // command that reads the pool fails with "Anthropic account migration is
    // required". A vault refusal here shows the command refused before it
    // read the pool.
    const env = {
      OPENCODE_ANTHROPIC_AUTH_FILE: join(tempDir, 'anthropic-auth.json'),
      OPENCODE_ANTHROPIC_AUTH_STATE_FILE: join(
        tempDir,
        'anthropic-auth-state.json',
      ),
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
        tempDir,
        'opencode-enrollment.json',
      ),
      OPENCODE_ANTHROPIC_AUTH_API_KEY: 'unused-api-key',
    }
    const commands = {
      login: () =>
        login('blocked', {
          authorize: async () => {
            throw new Error('authorization should not start')
          },
          prompt: async () => {
            throw new Error('prompt should not run')
          },
        }),
      api: () =>
        addApiRoute('blocked', {
          prompt: async () => {
            throw new Error('prompt should not run')
          },
        }),
    }

    for (const run of Object.values(commands))
      await expect(
        withAccountEnv(env.OPENCODE_ANTHROPIC_AUTH_FILE, env, run),
      ).rejects.toThrow(
        'Anthropic account migration is required. Stop OpenCode, LiteCode and Pi, then run bunx @cortexkit/opencode-anthropic-auth@2.0.0 setup',
      )

    await enrollVault(env)
    const before = await rootFiles(tempDir)
    await expect(
      withAccountEnv(env.OPENCODE_ANTHROPIC_AUTH_FILE, env, commands.login),
    ).rejects.toThrow('Disconnect from the vault first.')
    await expect(
      withAccountEnv(env.OPENCODE_ANTHROPIC_AUTH_FILE, env, commands.api),
    ).rejects.toThrow('Disconnect from the vault first.')
    expect(await rootFiles(tempDir)).toEqual(before)
  })

  test('treats unreadable enrollment as a refusal, never as local mode', async () => {
    const tempDir = await createRoot()
    const fixture = await nativeFixture(tempDir)
    const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE
    await writeFile(fixture.enrollmentPath, 'not-an-enrollment-token', {
      mode: 0o600,
      flag: 'wx',
    })
    const before = await rootFiles(fixture.root)
    let authorizeCalls = 0

    await expect(
      withAccountEnv(accountPath, fixture.env, () =>
        login('blocked', {
          authorize: async () => {
            authorizeCalls += 1
            throw new Error('authorization should not start')
          },
          prompt: async () => {
            throw new Error('prompt should not run')
          },
        }),
      ),
    ).rejects.toThrow('Native custody refused: invalid-token')
    expect(authorizeCalls).toBe(0)
    expect(await rootFiles(fixture.root)).toEqual(before)
  })
})

describe('CLI login', () => {
  for (const kind of enrollmentKinds) {
    test(`refuses before authorization with a vault enrollment (${kind})`, async () => {
      const tempDir = await createRoot()
      const fixture = await nativeFixture(tempDir)
      const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE
      const bootstraps = interceptBootstrap()
      await enrollVault(fixture.env, kind)
      const before = await rootFiles(fixture.root)
      let authorizeCalls = 0
      let exchangeCalls = 0

      await expect(
        withAccountEnv(accountPath, fixture.env, () =>
          login('blocked', {
            authorize: async () => {
              authorizeCalls += 1
              throw new Error('authorization should not start')
            },
            exchange: async () => {
              exchangeCalls += 1
              throw new Error('exchange should not run')
            },
            prompt: async () => {
              throw new Error('prompt should not run')
            },
          }),
        ),
      ).rejects.toThrow('Disconnect from the vault first.')
      expect(authorizeCalls).toBe(0)
      expect(exchangeCalls).toBe(0)
      expect(bootstraps).toEqual([])
      expect(await rootFiles(fixture.root)).toEqual(before)
    })
  }

  test('writes nothing when setup enrolls the host during sign-in', async () => {
    const tempDir = await createRoot()
    const fixture = await nativeFixture(tempDir)
    const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE
    const bootstraps = interceptBootstrap()
    let enrolled: Awaited<ReturnType<typeof rootFiles>> | undefined

    await expect(
      withAccountEnv(accountPath, fixture.env, () =>
        login('late', {
          prompt: async () => 'cli-code',
          // The browser sign-in is open while offline setup enrolls this host
          // in vault custody; the exchanged tokens then arrive late.
          exchange: async () => {
            await enrollVault(fixture.env)
            enrolled = await rootFiles(fixture.root)
            return {
              type: 'success' as const,
              access: 'sk-ant-oat01-late-access',
              refresh: 'late-refresh',
              expires: Date.now() + 3_600_000,
            }
          },
        }),
      ),
    ).rejects.toThrow('Disconnect from the vault first.')
    expect(enrolled).toBeDefined()
    expect(await rootFiles(fixture.root)).toEqual(enrolled!)
    expect(bootstraps).toEqual([])
    expect(await readNativeRows(fixture)).toEqual([])
  })

  test('continues from label prompt to OAuth callback prompt and saves account', async () => {
    const tempDir = await createRoot()
    const fixture = await nativeFixture(tempDir)
    const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE
    const bootstraps = interceptBootstrap()

    // Real authorize() (exercises PKCE + state + the printed URL); exchange()
    // is the network boundary, stubbed to return canned tokens. The prompt
    // returns the label first, then the pasted callback code.
    const asked: string[] = []
    const promptAnswers = [
      'cli-label',
      'https://platform.claude.com/oauth/code/callback?code=cli-code&state=stub',
    ]
    let askIndex = 0
    const prompt = async (message: string) => {
      asked.push(message)
      return promptAnswers[askIndex++] ?? ''
    }

    let exchangeArgs: { input: string; verifier: string } | undefined
    const exchange = async (
      input: string,
      verifier: string,
    ): Promise<{
      type: 'success'
      access: string
      refresh: string
      expires: number
    }> => {
      exchangeArgs = { input, verifier }
      return {
        type: 'success',
        access: 'sk-ant-oat01-cli-access',
        refresh: 'cli-refresh',
        expires: Date.now() + 3600 * 1000,
      }
    }

    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    try {
      await withAccountEnv(accountPath, fixture.env, () =>
        login(undefined, { prompt, exchange }),
      )
    } finally {
      console.log = origLog
    }

    const stdout = logs.join('\n')
    // The real authorize() URL was printed and carries a generated state.
    expect(stdout).toMatch(/[?&]state=[a-f0-9]+/)
    // The callback-code prompt and label prompt both fired, in order.
    expect(asked).toEqual([
      'Fallback account label (optional): ',
      'Paste the full callback URL or authorization code here: ',
    ])
    // exchange received the real authorize() verifier and the pasted code.
    expect(exchangeArgs?.input).toBe(
      'https://platform.claude.com/oauth/code/callback?code=cli-code&state=stub',
    )
    expect(exchangeArgs?.verifier).toBeString()
    expect(stdout).toContain('Saved native fallback account "cli-label"')

    const rows = await readNativeRows(fixture)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'cli-label',
      label: 'cli-label',
      enabled: true,
      stamp: 'bound',
      identity: cliAccountUuid,
      credential: {
        type: 'oauth',
        access: 'sk-ant-oat01-cli-access',
        refresh: 'cli-refresh',
      },
    })
    const config = await readFile(fixture.paths.config, 'utf8')
    expect(config).not.toContain('sk-ant-oat01-cli-access')
    expect(config).not.toContain('cli-refresh')
    const state = JSON.parse(await readFile(fixture.paths.runtime, 'utf8'))
    expect(state.accounts['cli-label'].authLineageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(bootstraps).toEqual(['Bearer sk-ant-oat01-cli-access'])
    await expect(readFile(accountPath, 'utf8')).rejects.toThrow()
  })

  test('allows human-readable local OAuth labels without the obsolete manifest label restriction', async () => {
    const tempDir = await createRoot()
    const fixture = await nativeFixture(tempDir)
    const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE
    const bootstraps = interceptBootstrap()

    await withAccountEnv(accountPath, fixture.env, () =>
      login('invalid label', {
        prompt: async () => 'cli-code',
        exchange: async () => ({
          type: 'success' as const,
          access: 'sk-ant-oat01-cli-access',
          refresh: 'cli-refresh',
          expires: Date.now() + 3600 * 1000,
        }),
      }),
    )
    expect((await readNativeRows(fixture))[0]).toMatchObject({
      id: 'invalid label',
      label: 'invalid label',
      stamp: 'bound',
      credential: { type: 'oauth', access: 'sk-ant-oat01-cli-access' },
    })
    expect(bootstraps).toEqual(['Bearer sk-ant-oat01-cli-access'])
  })

  test('preserves an account committed while the interactive OAuth flow is open', async () => {
    const tempDir = await createRoot()
    const fixture = await nativeFixture(tempDir)
    const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE
    const bootstraps = interceptBootstrap()
    const now = Date.now()
    const exchange = async () => {
      const concurrent = createNativeAccountRuntime({
        paths: fixture.paths,
        host: 'opencode',
      })
      try {
        await concurrent.putAccount({
          routeId: 'umut',
          label: 'umut',
          accountIdentity: '00000000-0000-4000-8000-000000000112',
          credential: {
            type: 'oauth',
            access: 'sk-ant-oat01-umut-access',
            refresh: 'umut-refresh',
            expires: now + 3_600_000,
          },
        })
      } finally {
        concurrent.close()
      }
      return {
        type: 'success' as const,
        access: 'sk-ant-oat01-yiyi-access',
        refresh: 'yiyi-refresh',
        expires: now + 3_600_000,
      }
    }
    await withAccountEnv(accountPath, fixture.env, () =>
      login('yiyi', { prompt: async () => 'cli-code', exchange }),
    )
    const rows = await readNativeRows(fixture)
    expect(rows.map((row) => row.id)).toEqual(['umut', 'yiyi'])
    expect(rows[0]?.credential).toMatchObject({
      type: 'oauth',
      refresh: 'umut-refresh',
    })
    expect(rows[1]?.credential).toMatchObject({
      type: 'oauth',
      refresh: 'yiyi-refresh',
    })
    const metadata = JSON.parse(await readFile(fixture.paths.runtime, 'utf8'))
    expect(Object.keys(metadata.accounts)).toEqual(['umut', 'yiyi'])
    expect(bootstraps).toEqual(['Bearer sk-ant-oat01-yiyi-access'])
    await expect(readFile(accountPath, 'utf8')).rejects.toThrow()
  })

  for (const splitState of [false, true]) {
    test(
      splitState
        ? 're-login with same label replaces split runtime state and clears stale reauth'
        : 're-login with same label clears stale errors and quota',
      async () => {
        const tempDir = await createRoot()
        const oldRefreshedAt = Date.now() - 60_000
        const oldIdentity = '00000000-0000-4000-8000-000000000110'
        const stale = {
          access: 'sk-ant-oat01-old-access',
          refresh: 'old-refresh',
          expires: 1,
          lastRefreshedAt: oldRefreshedAt,
          quota: {
            accountIdentity: oldIdentity,
            checkedAt: oldRefreshedAt,
            five_hour: {
              usedPercent: 99,
              remainingPercent: 1,
              checkedAt: oldRefreshedAt,
            },
          },
          lastRefreshError: {
            message: 'old invalid_grant',
            checkedAt: oldRefreshedAt,
            nextRetryAt: Date.now() + 3_600_000,
            permanent: true,
            tokenHash: createHash('sha256').update('old-refresh').digest('hex'),
          },
          lastQuotaRefreshError: {
            message: 'old quota error',
            accountIdentity: oldIdentity,
            checkedAt: oldRefreshedAt,
          },
        }
        const fixture = await nativeFixture(
          tempDir,
          {
            version: 1,
            accounts: [
              {
                id: 'cli-label',
                label: 'cli-label',
                type: 'oauth',
                anthropicAccountUuid: oldIdentity,
                enabled: true,
                addedAt: 123,
                ...(splitState ? {} : stale),
              },
            ],
          },
          splitState
            ? { version: 1, accounts: { 'cli-label': stale } }
            : undefined,
        )
        const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE
        const before = (await readNativeRows(fixture))[0]
        expect(before?.identity).toBe(oldIdentity)
        const reader = createNativeAccountRuntime({
          paths: fixture.paths,
          host: 'opencode',
        })
        try {
          const prior = (await reader.read()).accounts.find(
            (row) => row.id === 'cli-label',
          )
          expect(prior?.quota?.five_hour?.usedPercent).toBe(99)
        } finally {
          reader.close()
        }
        const oldMetadata = JSON.parse(
          await readFile(fixture.paths.runtime, 'utf8'),
        ).accounts['cli-label']
        expect(oldMetadata.lastRefreshError?.permanent).toBe(true)
        expect(oldMetadata.lastQuotaRefreshError?.message).toBe(
          'Imported quota failure',
        )
        const bootstraps = interceptBootstrap()
        const asked: string[] = []
        await withAccountEnv(accountPath, fixture.env, () =>
          login('cli-label', {
            prompt: async (message) => {
              asked.push(message)
              return 'cli-code'
            },
            exchange: async () => ({
              type: 'success' as const,
              access: 'sk-ant-oat01-new-access',
              refresh: 'new-refresh',
              expires: Date.now() + 3_600_000,
            }),
          }),
        )
        expect(asked).toEqual([
          'Paste the full callback URL or authorization code here: ',
        ])
        const rows = await readNativeRows(fixture)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          id: 'cli-label',
          label: 'cli-label',
          enabled: true,
          addedAt: before?.addedAt,
          identity: cliAccountUuid,
          credential: {
            type: 'oauth',
            access: 'sk-ant-oat01-new-access',
            refresh: 'new-refresh',
          },
        })
        expect(rows[0]?.credentialEpoch).toBeGreaterThan(
          before?.credentialEpoch ?? 0,
        )
        expect(rows[0]?.quota).toBeUndefined()
        if (rows[0]?.credential?.type !== 'oauth')
          throw new Error('OAuth replacement is missing')
        expect(rows[0].credential.lastRefreshedAt).toBeGreaterThan(
          oldRefreshedAt,
        )
        const config = await readFile(fixture.paths.config, 'utf8')
        expect(config).not.toContain('sk-ant-oat01-new-access')
        expect(config).not.toContain('new-refresh')
        const metadata = JSON.parse(
          await readFile(fixture.paths.runtime, 'utf8'),
        ).accounts['cli-label']
        expect(metadata.lastRefreshError).toBeUndefined()
        expect(metadata.lastQuotaRefreshError).toBeUndefined()
        expect(metadata.quota).toBeUndefined()
        expect(metadata.authLineageId).toMatch(/^[0-9a-f-]{36}$/)
        expect(bootstraps).toEqual(['Bearer sk-ant-oat01-new-access'])
        await expect(readFile(accountPath, 'utf8')).rejects.toThrow()
        if (splitState)
          await expect(
            readFile(getAccountStatePath(accountPath), 'utf8'),
          ).rejects.toThrow()
      },
    )
  }
})

describe('CLI relay setup', () => {
  // Cloudflare requests use a synthetic transport. The command still executes
  // provisioning in order and saves its private relay token in native storage.
  test('deploys worker resources and saves relay config', async () => {
    const tempDir = await createRoot()
    const fixture = await nativeFixture(tempDir)
    const accountPath = fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE
    const calls: Array<{ url: string; method?: string }> = []
    let accountAddedDuringProvisioning = false

    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input.toString()
      calls.push({ url, method: init?.method })
      if (!accountAddedDuringProvisioning) {
        accountAddedDuringProvisioning = true
        const concurrent = createNativeAccountRuntime({
          paths: fixture.paths,
          host: 'opencode',
        })
        try {
          await concurrent.putAccount({
            routeId: 'added-during-relay',
            label: 'added-during-relay',
            credential: {
              type: 'oauth',
              access: 'sk-ant-oat01-relay-race-access',
              refresh: 'relay-race-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
            },
          })
        } finally {
          concurrent.close()
        }
      }
      if (url.includes('/storage/kv/namespaces'))
        return Response.json({ success: true, result: { id: 'kv-id' } })
      if (url.includes('/workers/scripts/opencode-anthropic-relay/subdomain'))
        return Response.json({ success: true, result: { enabled: true } })
      if (url.includes('/workers/subdomain'))
        return Response.json({
          success: true,
          result: { subdomain: 'user-subdomain' },
        })
      if (url.includes('/workers/scripts/opencode-anthropic-relay'))
        return Response.json({ success: true, result: {} })
      return Response.json(
        { success: false, errors: [{ message: `unexpected ${url}` }] },
        { status: 500 },
      )
    }

    // The worker-name prompt returns '' (→ default name); no other prompt fires
    // because the injected fetch returns a workers.dev subdomain.
    const promptAnswers: Record<string, string> = {
      'Worker name [opencode-anthropic-relay]: ': '',
    }
    const askedPrompts: string[] = []
    const prompt = async (message: string) => {
      askedPrompts.push(message)
      return promptAnswers[message] ?? ''
    }

    await withAccountEnv(
      accountPath,
      {
        ...fixture.env,
        CLOUDFLARE_API_TOKEN: 'cf-token',
        CLOUDFLARE_ACCOUNT_ID: 'account-id',
      },
      () => relaySetup({ fetchImpl, prompt }),
    )

    // Token + account come from env, so the only prompt is the worker name.
    expect(askedPrompts).toEqual(['Worker name [opencode-anthropic-relay]: '])

    const reader = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
    })
    try {
      const relay = await reader.getRelayConfig()
      expect(relay).toMatchObject({
        enabled: true,
        url: 'https://opencode-anthropic-relay.user-subdomain.workers.dev',
        fallbackToDirect: true,
        transport: 'http',
      })
      expect(relay?.token).toBeString()
      if (!relay?.token) throw new Error('Relay setup did not save a token')
      const snapshot = await reader.read()
      expect(snapshot.accounts.map((account) => account.id)).toEqual([
        'added-during-relay',
      ])
      expect(snapshot.policyStorage.relay?.token).toBeUndefined()
      expect(await readFile(fixture.paths.config, 'utf8')).not.toContain(
        relay.token,
      )
      expect((await readNativeRows(fixture))[0]?.credential).toMatchObject({
        type: 'oauth',
        access: 'sk-ant-oat01-relay-race-access',
        refresh: 'relay-race-refresh',
      })
      await expect(readFile(accountPath, 'utf8')).rejects.toThrow()
    } finally {
      reader.close()
    }

    expect(calls).toHaveLength(4)
    expect(calls.map((c) => `${c.method ?? 'GET'} ${c.url}`)).toEqual([
      'POST https://api.cloudflare.com/client/v4/accounts/account-id/storage/kv/namespaces',
      'PUT https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/opencode-anthropic-relay',
      'POST https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/opencode-anthropic-relay/subdomain',
      'GET https://api.cloudflare.com/client/v4/accounts/account-id/workers/subdomain',
    ])
  })
})
