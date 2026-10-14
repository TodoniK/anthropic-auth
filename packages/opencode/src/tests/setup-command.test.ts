import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import {
  createNativeAccountRuntime,
  NativeMigrationError,
  type ProviderAccountUuid,
  readNativeMigrationJournal,
  resetClaudeCodeIdentityCachesForTest,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import { NativeCustodyError } from '../../../core/src/native-custody.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import {
  CLI_FAILURE_DETAIL_MAX_BYTES,
  CLI_FAILURE_OMITTED,
  cliDiagnosticsDirectory,
} from '../cli-failure.ts'
import { runSetupCommand } from '../setup/command.ts'
import { NativeVaultActivationError } from '../setup/native-activation.ts'
import { resolveNativeSetupPaths } from '../setup/native-paths.ts'
import { ProcessFenceViolationError } from '../setup/process-fence.ts'
import type {
  CommandRunner,
  ProcessFence,
  SetupDetection,
} from '../setup/types.ts'
import { extractUrl } from './test-fetch'

const lifetimes = createTestLifetimeSuite()

const testDirs: string[] = []
afterEach(async () => {
  for (const d of testDirs.splice(0)) {
    await rm(d, { recursive: true, force: true })
  }
})

function createTestFence(
  running: Array<{ pid: number; command: string }> = [],
): ProcessFence {
  return {
    async listRunningHosts() {
      return running
    },
  }
}

function createMockRunner(
  handlers: Record<
    string,
    (args: string[]) => { exitCode: number; stdout: string; stderr: string }
  > = {},
): CommandRunner {
  return {
    async run(command, args) {
      const handler = handlers[command] ?? handlers[basename(command)]
      if (handler) return handler(args)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
}

describe('setup wizard command', () => {
  test('aborts with error when OpenCode or Pi processes are running', async () => {
    const fence = createTestFence([{ pid: 1234, command: 'opencode serve' }])
    const runner = createMockRunner({
      opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
      pi: () => ({ exitCode: 0, stdout: '0.86.1\n', stderr: '' }),
      ck: () => ({ exitCode: 0, stdout: '0.20.8\n', stderr: '' }),
    })

    const code = await runSetupCommand(['--yes'], { fence, runner })
    expect(code).toBe(1)
  })

  test('dry run reports planned actions and does not modify disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-dry-run-'))
    testDirs.push(root)
    const bin = join(root, 'bin')
    await mkdir(bin)
    for (const host of ['opencode', 'pi', 'ck']) {
      await writeFile(join(bin, host), '', { mode: 0o755 })
    }

    const env: NodeJS.ProcessEnv = {
      HOME: root,
      PATH: bin,
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
        root,
        'unavailable-subc-connection.json',
      ),
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'),
      PI_CODING_AGENT_DIR: join(root, '.pi', 'agent'),
    }

    const fence = createTestFence([])
    const runner = createMockRunner({
      opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
      pi: () => ({ exitCode: 0, stdout: '0.86.1\n', stderr: '' }),
      ck: () => ({ exitCode: 0, stdout: '0.20.8\n', stderr: '' }),
    })

    const code = await runSetupCommand(
      ['--yes', '--dry-run', '--no-claustrum'],
      { fence, runner, env },
    )
    expect(code).toBe(0)

    // Verify no files were created
    const fs = await import('node:fs')
    expect(
      fs.existsSync(join(root, '.config', 'opencode', 'opencode.jsonc')),
    ).toBe(false)
    expect(
      fs.existsSync(join(root, '.local', 'share', 'opencode', 'auth.json')),
    ).toBe(false)
  })

  test('aborts when neither OpenCode nor Pi is installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-no-hosts-'))
    testDirs.push(root)

    const env: NodeJS.ProcessEnv = {
      HOME: root,
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
        root,
        'unavailable-subc-connection.json',
      ),
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'),
      PI_CODING_AGENT_DIR: join(root, 'nonexistent-pi'),
    }

    const fence = createTestFence([])
    const runner = createMockRunner({
      opencode: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
      pi: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
      ck: () => ({ exitCode: 0, stdout: '0.20.8\n', stderr: '' }),
    })

    const code = await runSetupCommand(['--yes'], { fence, runner, env })
    expect(code).toBe(1)
  })

  test('configures OpenCode with pinned plugin and TUI entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-opencode-'))
    testDirs.push(root)

    const env: NodeJS.ProcessEnv = {
      HOME: root,
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
        root,
        'unavailable-subc-connection.json',
      ),
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'),
      PI_CODING_AGENT_DIR: join(root, 'nonexistent-pi'),
    }

    const configDir = join(root, '.config', 'opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'opencode.jsonc'),
      '{\n  "plugin": []\n}\n',
      'utf8',
    )

    const fence = createTestFence([])
    const runner = createMockRunner({
      opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
      pi: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
      ck: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
    })

    const code = await runSetupCommand(['--yes', '--no-claustrum'], {
      fence,
      runner,
      env,
    })
    expect(code).toBe(0)

    const updatedConfig = await readFile(
      join(configDir, 'opencode.jsonc'),
      'utf8',
    )
    expect(updatedConfig).toContain('@cortexkit/opencode-anthropic-auth@')

    const tuiConfig = await readFile(join(configDir, 'tui.jsonc'), 'utf8')
    expect(tuiConfig).toContain('@cortexkit/opencode-anthropic-auth@')
    const plan = await resolveNativeSetupPaths('opencode', env)
    const journal = await readNativeMigrationJournal(plan.paths)
    expect(journal?.phase).toBe('retired')
  })
})

lifetimes.test(
  'explicit offline recovery login is performed before setup reports completion',
  async () => {
    const FRESH_ACCESS = 'sk-ant-oat01-fresh-main'
    const FRESH_UUID = 'aabbccdd-1122-3344-5566-778899001122'
    const root = await mkdtemp(join(tmpdir(), 'setup-offline-login-'))
    lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
    // Setup saves the sign-in only after the account's identity is looked up
    // for the exchanged token itself; the UUID the sign-in step reports is not
    // proof. Setup has no identity-lookup override, so answer the real lookup
    // (Claude Code's bootstrap request) for exactly the fresh synthetic token.
    // Any other token is refused, and any other request fails the test.
    const savedFetch = globalThis.fetch
    const identityLookups: string[] = []
    lifetimes.deferCleanup(() => {
      globalThis.fetch = savedFetch
      resetClaudeCodeIdentityCachesForTest()
    })
    resetClaudeCodeIdentityCachesForTest()
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const url = new URL(extractUrl(input))
        if (
          url.origin !== 'https://api.anthropic.com' ||
          url.pathname !== '/api/claude_cli/bootstrap'
        )
          throw new Error(`Unexpected setup fetch: ${url.href}`)
        const authorization =
          new Headers(
            init?.headers ??
              (input instanceof Request ? input.headers : undefined),
          ).get('authorization') ?? ''
        identityLookups.push(authorization.replace(/^Bearer /, ''))
        if (authorization !== `Bearer ${FRESH_ACCESS}`)
          return new Response('unauthorized', { status: 401 })
        return Response.json({ oauth_account: { account_uuid: FRESH_UUID } })
      },
      { preconnect: savedFetch.preconnect },
    )
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'),
      PI_CODING_AGENT_DIR: join(root, 'absent-pi'),
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
        root,
        'absent-connection',
      ),
    }
    const plan = await resolveNativeSetupPaths('opencode', env)
    await mkdir(dirname(plan.hostAuthPath), { recursive: true, mode: 0o700 })
    const oldAuth = JSON.stringify({
      anthropic: {
        type: 'oauth',
        access: 'sk-ant-oat01-old-unidentified',
        refresh: 'old-refresh',
        expires: Date.now() + 24 * 60 * 60_000,
      },
    })
    await writeFile(plan.hostAuthPath, oldAuth, { mode: 0o600 })
    await expect(
      runNativeMigration({
        ...plan,
        env,
        processFence: async () => {},
        requestVaultActivation: true,
        removePiAnthropicAuth: false,
      }),
    ).rejects.toThrow('setup --login --no-claustrum')
    expect(await readFile(plan.hostAuthPath, 'utf8')).toBe(oldAuth)
    expect(await readNativeMigrationJournal(plan.paths)).toBeUndefined()
    let logins = 0
    const options = {
      env,
      fence: createTestFence(),
      runner: createMockRunner({
        opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
        pi: () => ({ exitCode: 1, stdout: '', stderr: '' }),
        ck: () => ({ exitCode: 1, stdout: '', stderr: '' }),
      }),
      localLogin: async () => {
        logins++
        return {
          accountIdentity: FRESH_UUID,
          credential: {
            type: 'oauth' as const,
            access: FRESH_ACCESS,
            refresh: 'fresh-refresh',
            expires: Date.now() + 24 * 60 * 60_000,
          },
        }
      },
    }
    expect(
      await runSetupCommand(['--yes', '--no-claustrum', '--login'], options),
    ).toBe(0)
    expect(logins).toBe(1)
    // The fresh token's identity was looked up while setup ran, before it
    // reported completion. The offline migration itself sent no token anywhere,
    // so the old unidentified login was never presented for lookup.
    expect(identityLookups).toEqual([FRESH_ACCESS])
    const runtime = createNativeAccountRuntime({
      paths: plan.paths,
      host: 'opencode',
      local: {
        refreshToken: async () => {
          throw new Error('Unexpected token refresh after fresh sign-in')
        },
        resolveIdentity: async (access) => {
          expect(access).toBe(FRESH_ACCESS)
          return {
            deviceId: 'synthetic-device',
            sessionId: 'synthetic-session',
            accountUuid: FRESH_UUID as ProviderAccountUuid,
          }
        },
      },
    })
    try {
      const snapshot = await runtime.read()
      expect(
        snapshot.accounts.find((account) => account.id === 'main')
          ?.accountIdentity,
      ).toBe(FRESH_UUID)
      expect((await readNativeMigrationJournal(plan.paths))?.phase).toBe(
        'retired',
      )
      const authorized = await runtime.authorizeLocal('main')
      expect(authorized).toMatchObject({ status: 'usable' })
      if (authorized.status !== 'usable')
        throw new Error('Fresh login did not authorize')
      expect(authorized.access).toBe(FRESH_ACCESS)
      expect(authorized.subject.binding.identity).toBe(FRESH_UUID)
    } finally {
      runtime.close()
    }
  },
)

// Synthetic credential shapes echoed by failing setup steps. The opaque and
// short values match no built-in pattern, so only exact-value redaction can
// remove them. The short value also occurs inside ECHO_JWT, so replacing it
// before the JWT pattern runs would split the token into unredacted pieces.
const ECHO_BEARER = 'Bearer synthBearerValue0123456789abcdefXYZ'
const ECHO_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMtc2V0dXAifQ.c3ludGhldGljLXNldHVwLXNpZ25hdHVyZQ'
const ECHO_SK = 'sk-ant-synthetic0123456789abcdefSETUP'
const ECHO_OPAQUE = 'OPAQUE-synthetic-Zq7Xw2Vt9Lm4Hd8Rc'
const ECHO_SHORT = 'J9'
const ECHO_SECRETS = [
  'synthBearerValue0123456789abcdefXYZ',
  ECHO_JWT,
  ECHO_SK,
  ECHO_OPAQUE,
]

/** A substring of every long echoed secret, long enough to identify it. */
function secretFragments(): string[] {
  const fragments: string[] = []
  for (const secret of ECHO_SECRETS)
    for (let start = 0; start + 8 <= secret.length; start += 4)
      fragments.push(secret.slice(start, start + 8))
  return fragments
}

function expectNoSecretFragments(text: string) {
  for (const fragment of secretFragments())
    expect(text.includes(fragment) ? fragment : '').toBe('')
}

interface SetupFailureFixture {
  env: NodeJS.ProcessEnv
  screen: () => string
  output: Writable
  diagnostics: string
}

/**
 * A temporary home directory and a captured screen. The directory is removed
 * during the current test's lifetime cleanup.
 */
async function setupFailureFixture(): Promise<SetupFailureFixture> {
  const root = await mkdtemp(join(tmpdir(), 'setup-failure-'))
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const chunks: string[] = []
  const output = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk))
      done()
    },
  })
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    XDG_STATE_HOME: join(root, '.local', 'state'),
    PI_CODING_AGENT_DIR: join(root, '.pi', 'agent'),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      root,
      'absent-connection.json',
    ),
    // Child processes inherit this environment, so its secret-named values
    // are known credentials for redaction.
    SYNTHETIC_SERVICE_TOKEN: ECHO_OPAQUE,
    SYNTHETIC_SHORT_API_KEY: ECHO_SHORT,
  }
  const diagnostics = cliDiagnosticsDirectory(env)
  if (diagnostics === undefined) throw new Error('No diagnostics directory')
  return {
    env,
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal control codes
    screen: () => chunks.join('').replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, ''),
    output,
    diagnostics,
  }
}

interface DiagnosticRecord {
  path: string
  text: string
  /** Fixed fields from the Core-formatted header line. */
  payload: Record<string, unknown>
  /** The redacted, bounded detail lines written after the header. */
  detail: string[]
}

/**
 * The diagnostics file the screen points at: it must be the only file in the
 * owner-only directory, and itself owner-only. Its first line is the header;
 * the rest is the detail.
 */
async function screenDiagnostic(
  fixture: SetupFailureFixture,
  screenLine: string,
): Promise<DiagnosticRecord> {
  const prefix = `${screenLine} Details were written to `
  const screen = fixture.screen()
  const start = screen.indexOf(prefix)
  expect(start).toBeGreaterThanOrEqual(0)
  const path = screen.slice(start + prefix.length).split('\n')[0] ?? ''
  expect(dirname(path)).toBe(fixture.diagnostics)
  expect(await readdir(fixture.diagnostics)).toEqual([
    path.slice(fixture.diagnostics.length + 1),
  ])
  expect((await stat(fixture.diagnostics)).mode & 0o777).toBe(0o700)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  const text = await readFile(path, 'utf8')
  expect(text.endsWith('\n')).toBe(true)
  const [header = '', ...detail] = text.slice(0, -1).split('\n')
  return {
    path,
    text,
    payload: JSON.parse(header.slice(header.indexOf(' {') + 1)),
    detail,
  }
}

async function expectNoDiagnostics(fixture: SetupFailureFixture) {
  await expect(stat(fixture.diagnostics)).rejects.toThrow()
}

function detection(hosts: {
  opencode: boolean
  pi: boolean
  claustrum: boolean
}): SetupDetection {
  return {
    opencode: {
      kind: 'opencode',
      installed: hosts.opencode,
      version: hosts.opencode ? '1.18.30' : null,
      configPath: '',
      pluginInstalled: false,
    },
    pi: {
      kind: 'pi',
      installed: hosts.pi,
      version: hosts.pi ? '0.86.1' : null,
      configPath: '',
      pluginInstalled: false,
      hasLocalAuth: false,
    },
    claustrum: {
      ckInstalled: hosts.claustrum,
      ckVersion: hosts.claustrum ? '0.20.8' : null,
      daemonRunning: hosts.claustrum,
      connectionPath: null,
    },
  }
}

/** Run vault setup with an activation step that throws the value returned by `thrown`. */
async function runFailingActivation(
  fixture: SetupFailureFixture,
  thrown: () => unknown,
): Promise<number> {
  return runSetupCommand(['--yes', '--claustrum'], {
    env: fixture.env,
    fence: createTestFence(),
    runner: createMockRunner(),
    output: fixture.output,
    detect: async () =>
      detection({ opencode: true, pi: false, claustrum: true }),
    activate: async () => {
      throw thrown()
    },
  })
}

const ACTIVATION_SCREEN =
  'Vault custody setup failed (setup-activation/unexpected-error).'

/** Run local setup for OpenCode with the given running-process check. */
async function runWithFence(
  fixture: SetupFailureFixture,
  fence: ProcessFence,
): Promise<number> {
  return runSetupCommand(['--yes', '--no-claustrum'], {
    env: fixture.env,
    fence,
    runner: createMockRunner(),
    output: fixture.output,
    detect: async () =>
      detection({ opencode: true, pi: false, claustrum: false }),
  })
}

describe('setup failure diagnostics', () => {
  lifetimes.test(
    'the running-host check prints a genuine host list word for word',
    async () => {
      const fixture = await setupFailureFixture()
      const code = await runWithFence(
        fixture,
        createTestFence([
          { pid: 4242, command: `/usr/local/bin/opencode --token ${ECHO_SK}` },
          { pid: 77, command: `/opt/Pi --key ${ECHO_OPAQUE}` },
        ]),
      )
      expect(code).toBe(1)
      const screen = fixture.screen()
      for (const line of [
        'OpenCode or Pi processes are currently running:',
        '  - PID 4242: opencode',
        '  - PID 77: Pi',
        'Please quit all OpenCode, LiteCode, and Pi processes before running setup.',
        'Setup aborted — quit active hosts and rerun setup.',
      ])
        expect(screen).toContain(line)
      expectNoSecretFragments(screen)
      await expectNoDiagnostics(fixture)
    },
  )

  lifetimes.test(
    'forged, mutated, accessor and proxy running-host errors get the fixed screen',
    async () => {
      const touched: string[] = []
      const forged = Object.create(ProcessFenceViolationError.prototype, {
        message: {
          value: `OpenCode or Pi processes are currently running:\n  - PID 1: ${ECHO_OPAQUE}`,
        },
        activeHosts: { value: [{ pid: 1, command: 'opencode' }] },
      })
      const mutated = new ProcessFenceViolationError([
        { pid: 2, command: 'opencode' },
      ])
      mutated.message = `${mutated.message}\n${ECHO_BEARER}`
      const accessor = new ProcessFenceViolationError([
        { pid: 3, command: 'pi' },
      ])
      Object.defineProperty(accessor, 'message', {
        get() {
          touched.push('message getter')
          return `${ECHO_SK}`
        },
      })
      const proxied = new Proxy(
        new ProcessFenceViolationError([{ pid: 4, command: 'pi' }]),
        {
          get(target, key) {
            touched.push(`get ${String(key)}`)
            return Reflect.get(target, key)
          },
          getOwnPropertyDescriptor(target, key) {
            touched.push(`descriptor ${String(key)}`)
            return Reflect.getOwnPropertyDescriptor(target, key)
          },
          getPrototypeOf(target) {
            touched.push('prototype')
            return Reflect.getPrototypeOf(target)
          },
        },
      )
      for (const thrown of [forged, mutated, accessor, proxied]) {
        const fixture = await setupFailureFixture()
        const code = await runWithFence(fixture, {
          async listRunningHosts() {
            throw thrown
          },
        })
        expect(code).toBe(1)
        const record = await screenDiagnostic(
          fixture,
          'Host process check failed (setup-process-check/unexpected-error).',
        )
        expect(fixture.screen()).toContain(
          'Setup aborted — quit active hosts and rerun setup.',
        )
        expect(fixture.screen()).not.toContain('currently running')
        expectNoSecretFragments(fixture.screen())
        expectNoSecretFragments(record.text)
      }
      expect(touched).toEqual([])
    },
  )
  lifetimes.test(
    'activation failure shows only stage, code and a private file holding the scrubbed detail',
    async () => {
      const fixture = await setupFailureFixture()
      const message = [
        'vault refused enrollment',
        `auth header: ${ECHO_BEARER}`,
        `jwt echo: ${ECHO_JWT}`,
        `key echo: ${ECHO_SK}`,
        `install token rejected: ${ECHO_OPAQUE}`,
        `short key echo: ${ECHO_SHORT}`,
      ].join('\n')
      const code = await runFailingActivation(fixture, () => new Error(message))
      expect(code).toBe(1)

      const screen = fixture.screen()
      expect(screen).toContain('OpenCode vault custody setup failed.')
      expect(screen).not.toContain('vault refused enrollment')
      expect(screen).not.toContain(`: ${ECHO_SHORT}`)
      expectNoSecretFragments(screen)

      const record = await screenDiagnostic(fixture, ACTIVATION_SCREEN)
      expect(record.text).toContain(' ERROR [cli] Vault custody setup failed ')
      expect(record.payload.stage).toBe('setup-activation')
      expect(record.payload.code).toBe('setup-activation/unexpected-error')
      const detail = record.detail
      expect(detail[0]).toBe('Error: vault refused enrollment')
      expect(detail).toContain('auth header: Bearer [REDACTED]')
      expect(detail).toContain('jwt echo: [REDACTED]')
      expect(detail).toContain('key echo: [REDACTED]')
      // ECHO_OPAQUE and ECHO_SHORT match no built-in pattern; they are redacted
      // only because the fixture environment passes them under secret names.
      expect(detail).toContain('install token rejected: [REDACTED]')
      expect(detail).toContain('short key echo: [REDACTED]')
      expect(detail.some((line) => String(line).startsWith('    at '))).toBe(
        true,
      )
      expectNoSecretFragments(record.text)
    },
  )

  lifetimes.test(
    'known remedies, custody codes and the process-fence list stay word for word',
    async () => {
      const remedies: Array<[unknown, string[]]> = [
        [
          new NativeVaultActivationError('primary-conflict'),
          [
            'Pi has a stored Anthropic API key, which would take precedence over the vault account. Remove it in Pi, then rerun setup.',
          ],
        ],
        [
          new NativeMigrationError('primary-unverified'),
          [
            'Stop OpenCode and Pi, then run bunx @cortexkit/opencode-anthropic-auth setup --login --no-claustrum. Existing credentials have not been changed.',
          ],
        ],
        [
          new NativeCustodyError('invalid-token'),
          ['Native custody refused: invalid-token'],
        ],
        [
          new NativeCustodyError('host-slot-placeholder'),
          ['Native custody refused: host-slot-placeholder'],
        ],
        [
          new ProcessFenceViolationError([
            {
              pid: 4242,
              command: `/usr/local/bin/opencode --token ${ECHO_SK}`,
            },
            { pid: 77, command: `/opt/Pi --key ${ECHO_OPAQUE}` },
          ]),
          [
            'OpenCode or Pi processes are currently running:',
            '  - PID 4242: opencode',
            '  - PID 77: Pi',
            'Please quit all OpenCode, LiteCode, and Pi processes before running setup.',
          ],
        ],
      ]
      for (const [thrown, expected] of remedies) {
        const fixture = await setupFailureFixture()
        expect(await runFailingActivation(fixture, () => thrown)).toBe(1)
        for (const line of expected) expect(fixture.screen()).toContain(line)
        expect(fixture.screen()).not.toContain(ACTIVATION_SCREEN)
        expectNoSecretFragments(fixture.screen())
        await expectNoDiagnostics(fixture)
      }
    },
  )

  lifetimes.test(
    'forged and mutated closed errors fall back to the fixed screen',
    async () => {
      const forged = Object.create(NativeMigrationError.prototype, {
        message: { value: `Native migration: ${ECHO_OPAQUE}` },
        code: { value: 'migration-busy' },
      })
      const mutatedMigration = new NativeMigrationError('migration-busy')
      mutatedMigration.message = `Native migration: ${ECHO_SK}`
      const mutatedActivation = new NativeVaultActivationError(
        'consent-required',
      )
      Object.defineProperty(mutatedActivation, 'message', {
        value: `${mutatedActivation.message} ${ECHO_OPAQUE}`,
      })
      const mutatedFence = new ProcessFenceViolationError([
        { pid: 9, command: 'opencode' },
      ])
      mutatedFence.message = `${mutatedFence.message}\n${ECHO_BEARER}`
      // activeHosts is changed after construction, so the message no longer
      // matches what ProcessFenceViolationError builds from the current list.
      const inconsistentFence = new ProcessFenceViolationError([
        { pid: 9, command: 'opencode' },
      ])
      inconsistentFence.activeHosts[0] = { pid: 9, command: ECHO_SK }
      for (const thrown of [
        forged,
        mutatedMigration,
        mutatedActivation,
        mutatedFence,
        inconsistentFence,
      ]) {
        const fixture = await setupFailureFixture()
        expect(await runFailingActivation(fixture, () => thrown)).toBe(1)
        const record = await screenDiagnostic(fixture, ACTIVATION_SCREEN)
        expectNoSecretFragments(fixture.screen())
        expectNoSecretFragments(record.text)
      }
    },
  )

  lifetimes.test(
    'malformed, proxy and getter throws are never inspected through code',
    async () => {
      const touched: string[] = []
      const trapped = new Proxy(new Error(ECHO_SK), {
        get(target, key) {
          touched.push(`get ${String(key)}`)
          return Reflect.get(target, key)
        },
        getOwnPropertyDescriptor(target, key) {
          touched.push(`descriptor ${String(key)}`)
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
        getPrototypeOf(target) {
          touched.push('prototype')
          return Reflect.getPrototypeOf(target)
        },
        has(target, key) {
          touched.push(`has ${String(key)}`)
          return Reflect.has(target, key)
        },
        ownKeys(target) {
          touched.push('keys')
          return Reflect.ownKeys(target)
        },
      })
      const getterError = new Error('placeholder')
      Object.defineProperty(getterError, 'message', {
        get() {
          touched.push('message getter')
          return 'Disconnect from the vault first.'
        },
      })
      Object.defineProperty(getterError, 'stack', {
        get() {
          touched.push('stack getter')
          return ECHO_JWT
        },
      })
      const jsonish = {
        toJSON() {
          touched.push('toJSON')
          return ECHO_OPAQUE
        },
        toString() {
          touched.push('toString')
          return ECHO_OPAQUE
        },
        get name() {
          touched.push('name getter')
          return 'NativeVaultActivationError'
        },
      }
      // Has the name and Error type of ProcessFenceViolationError but was not
      // created by that class, and its message is not a fixed text.
      const impostor = Object.assign(new Error(`${ECHO_BEARER}`), {
        name: 'ProcessFenceViolationError',
      })
      const cases: Array<[string, unknown]> = [
        ['proxy', trapped],
        ['getter', getterError],
        ['toJSON', jsonish],
        ['impostor', impostor],
        ['string', `raw ${ECHO_BEARER} ${ECHO_OPAQUE}`],
        ['null', null],
      ]
      for (const [label, thrown] of cases) {
        const fixture = await setupFailureFixture()
        expect([
          label,
          await runFailingActivation(fixture, () => thrown),
        ]).toEqual([label, 1])
        const record = await screenDiagnostic(fixture, ACTIVATION_SCREEN)
        expectNoSecretFragments(fixture.screen())
        expectNoSecretFragments(record.text)
      }
      expect(touched).toEqual([])
    },
  )

  lifetimes.test(
    'an existing diagnostics directory that is not owner-only is refused, not repaired',
    async () => {
      const fixture = await setupFailureFixture()
      await mkdir(fixture.diagnostics, { recursive: true, mode: 0o755 })
      await writeFile(join(fixture.diagnostics, 'operator.log'), 'kept\n')
      expect(
        await runFailingActivation(fixture, () => new Error(ECHO_OPAQUE)),
      ).toBe(1)
      expect(fixture.screen()).toContain(
        `${ACTIVATION_SCREEN} Details could not be saved to a private diagnostics file.`,
      )
      expectNoSecretFragments(fixture.screen())
      expect((await stat(fixture.diagnostics)).mode & 0o777).toBe(0o755)
      expect(await readdir(fixture.diagnostics)).toEqual(['operator.log'])
      expect(
        await readFile(join(fixture.diagnostics, 'operator.log'), 'utf8'),
      ).toBe('kept\n')
    },
  )

  lifetimes.test(
    'Pi installer failure records only a bounded, scrubbed tail of a long stderr',
    async () => {
      const fixture = await setupFailureFixture()
      const noise = Array.from(
        { length: 4000 },
        (_, index) => `npm notice line ${index} résumé ✓ 漢字`,
      )
      // These lines sit around the point where the kept tail begins, so a tail
      // cut before redaction would keep only part of a credential.
      const straddling = [
        `token echo: ${ECHO_OPAQUE}${ECHO_OPAQUE}`,
        `authorization: ${ECHO_BEARER}`,
        `jwt: ${ECHO_JWT}`,
        `key: ${ECHO_SK}`,
      ]
      const lastLines = Array.from(
        { length: 90 },
        (_, index) =>
          `${straddling[index % straddling.length]} trailing ${index} ✓`,
      )
      const stderr = `${[...noise, ...lastLines, 'npm error final line ✓'].join('\n')}\n`
      expect(new TextEncoder().encode(stderr).length).toBeGreaterThan(64 * 1024)
      const installs: string[][] = []
      const code = await runSetupCommand(['--yes', '--no-claustrum'], {
        env: fixture.env,
        fence: createTestFence(),
        output: fixture.output,
        detect: async () =>
          detection({ opencode: false, pi: true, claustrum: false }),
        runner: createMockRunner({
          pi: (args) => {
            installs.push(args)
            return { exitCode: 7, stdout: '', stderr }
          },
        }),
      })
      expect(code).toBe(1)
      expect(installs).toHaveLength(1)
      expect(installs[0]?.[0]).toBe('install')

      const screen = fixture.screen()
      expect(screen).toContain('Pi extension installation failed.')
      expect(screen).not.toContain('npm')
      expectNoSecretFragments(screen)

      const record = await screenDiagnostic(
        fixture,
        'Pi extension installation failed (setup-pi-install/installer-exit).',
      )
      expectNoSecretFragments(record.text)
      expect(record.payload.code).toBe('setup-pi-install/installer-exit')
      expect(record.payload.exitCode).toBe(7)
      const detail = record.detail
      expect(detail[0]).toBe(CLI_FAILURE_OMITTED)
      expect(detail.at(-1)).toBe('npm error final line ✓')
      const kept = detail.slice(1).map(String)
      const bytes = kept.reduce(
        (total, line) => total + new TextEncoder().encode(line).length + 1,
        0,
      )
      expect(bytes).toBeLessThanOrEqual(CLI_FAILURE_DETAIL_MAX_BYTES)
      // Whole lines are retained, so the unused portion of the byte limit is less than one noise line.
      expect(bytes).toBeGreaterThan(CLI_FAILURE_DETAIL_MAX_BYTES - 100)
      expect(kept.join('\n')).not.toContain('\uFFFD')
      // Every credential shape keeps its placeholder and the text around it.
      expect(kept).toContain('authorization: Bearer [REDACTED] trailing 85 ✓')
      expect(kept).toContain('jwt: [REDACTED] trailing 86 ✓')
      expect(kept).toContain('key: [REDACTED] trailing 87 ✓')
      expect(kept).toContain('token echo: [REDACTED][REDACTED] trailing 84 ✓')
      expect(kept).toContain('authorization: Bearer [REDACTED] trailing 1 ✓')
    },
  )
})
