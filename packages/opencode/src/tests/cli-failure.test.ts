import { expect } from 'bun:test'
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
import { dirname, join } from 'node:path'
import {
  createProviderErrorRedactor,
  NativeMigrationError,
  NativePiAuthSlotError,
} from '@cortexkit/anthropic-auth-core'
import { NativeAccountReadError } from '../../../core/src/native-account-view.ts'
import { NativeCustodyError } from '../../../core/src/native-custody.ts'
import { NativeRuntimeError } from '../../../core/src/native-runtime.ts'
import { NativeAuthorityError } from '../../../core/src/pool-authority.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { relaySetup } from '../cli.ts'
import {
  boundRedactedDetail,
  CLI_FAILURE_DETAIL_MAX_BYTES,
  CLI_FAILURE_OMITTED,
  CLI_FAILURE_SECRETS_UNREADABLE,
  CLI_FAILURE_WITHHELD,
  cliDiagnosticsDirectory,
  collectKnownSecrets,
  knownFailureMessage,
  reportThrownFailure,
} from '../cli-failure.ts'
import { NativeVaultActivationError } from '../setup/native-activation.ts'
import { NativeVaultEnrollmentError } from '../setup/native-enrollment.ts'
import {
  ProcessFenceViolationError,
  ProcessInspectionError,
} from '../setup/process-fence.ts'
import { migrateNativeOpencodeFixture } from './native-fixture.ts'

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()

const CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts')
const OPAQUE = 'OPAQUE-cli-synthetic-Kp3Nw8Ty5Qa2Lz'
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMtY2xpIn0.c3ludGhldGljLWNsaS1zaWduYXR1cmU'
const SK = 'sk-ant-synthetic9876543210fedcbaCLI'

/**
 * Seeded pseudo-random text. The checks below look for any 16-character piece
 * of it, which ordinary output is vanishingly unlikely to contain by chance.
 */
function syntheticSecret(length: number, seed: number): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let state = seed
  let text = ''
  while (text.length < length) {
    state = (state * 1103515245 + 12345) % 2 ** 31
    text += alphabet[state % alphabet.length]
  }
  return text
}

function expectNoPieceOf(secret: string, text: string) {
  for (let start = 0; start + 16 <= secret.length; start += 8) {
    const piece = secret.slice(start, start + 16)
    expect(text.includes(piece) ? piece : '').toBe('')
  }
}

/** A temporary state directory owned by the current test body. */
async function stateRoot() {
  const root = await mkdtemp(join(tmpdir(), 'cli-failure-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  return root
}

/** The single owner-only diagnostics file a fixed screen line points at. */
async function diagnosticFile(screen: string, directory: string) {
  const marker = ' Details were written to '
  const at = screen.indexOf(marker)
  expect(at).toBeGreaterThan(0)
  const path = screen.slice(at + marker.length).trim()
  expect(dirname(path)).toBe(directory)
  expect((await readdir(directory)).length).toBe(1)
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  const text = await readFile(path, 'utf8')
  // First line: Core-formatted header with the fixed fields; then the
  // redacted, bounded detail lines.
  const [header = '', ...detail] = text.slice(0, -1).split('\n')
  return {
    path,
    text,
    payload: JSON.parse(header.slice(header.indexOf(' {') + 1)),
    detail,
  }
}

test('fixed remedies and validated closed codes are admitted word for word', () => {
  const closed: Error[] = [
    new ProcessFenceViolationError([
      { pid: 77, command: '/bin/pi --x' },
      { pid: 78, command: '/usr/bin/LiteCode' },
    ]),
    new ProcessInspectionError(),
    new NativeVaultActivationError('auth-content-refused'),
    new NativeVaultEnrollmentError('approval-refused'),
    new NativeMigrationError('primary-unverified'),
    new NativeMigrationError('migration-busy'),
    new NativePiAuthSlotError('missing-stash'),
    new NativeCustodyError('invalid-token'),
    new NativeCustodyError('not-enrolled'),
    new NativeCustodyError('placeholder-refresh'),
    // These constructors are not public, so instantiate them here to check
    // that the mapper's literal message list still matches their actual text.
    new NativeAuthorityError('migration-required'),
    new NativeAuthorityError('migration-incomplete'),
    new NativeRuntimeError('unsafe-runtime'),
    new NativeAccountReadError(),
    new NativeAccountReadError(503),
    new Error('Disconnect from the vault first.'),
    new Error(
      'Anthropic account storage paths overlap; migration requires separate files',
    ),
  ]
  for (const error of closed)
    expect(knownFailureMessage(error)).toBe(error.message)
})

test('forged, mutated, look-alike, proxy and accessor errors are not admitted', () => {
  const touched: string[] = []
  const closed = new NativeVaultActivationError('primary-conflict')
  const proxy = new Proxy(closed, {
    getPrototypeOf(target) {
      touched.push('prototype')
      return Reflect.getPrototypeOf(target)
    },
    getOwnPropertyDescriptor(target, key) {
      touched.push(`descriptor ${String(key)}`)
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  const accessor = new ProcessInspectionError()
  Object.defineProperty(accessor, 'message', {
    get() {
      touched.push('message getter')
      return 'Disconnect from the vault first.'
    },
  })
  const forged = Object.create(NativeMigrationError.prototype, {
    message: { value: `Native migration: ${OPAQUE}` },
  })
  const mutated = new NativeMigrationError('migration-busy')
  mutated.message = OPAQUE
  const fence = new ProcessFenceViolationError([{ pid: 5, command: 'pi' }])
  fence.activeHosts[0] = { pid: 5, command: SK }
  const fenceHostsProxy = new ProcessFenceViolationError([
    { pid: 5, command: 'pi' },
  ])
  Object.defineProperty(fenceHostsProxy, 'activeHosts', {
    value: new Proxy([{ pid: 5, command: 'pi' }], {
      get(target, key) {
        touched.push(`hosts ${String(key)}`)
        return Reflect.get(target, key)
      },
    }),
  })
  const forgedStatus = Object.assign(
    new Error('OAuth metadata read failed: x'),
    {
      status: 'x',
    },
  )
  const prefixed = new Error('Disconnect from the vault first. Bearer abc')
  const named = Object.assign(new Error(`Native vault setup: ${SK}`), {
    name: 'NativeVaultEnrollmentError',
  })
  for (const value of [
    proxy,
    accessor,
    forged,
    mutated,
    fence,
    fenceHostsProxy,
    forgedStatus,
    prefixed,
    named,
    'Disconnect from the vault first.',
    null,
    undefined,
    42,
  ])
    expect(knownFailureMessage(value)).toBeUndefined()
  expect(touched).toEqual([])
})

test('known secrets include short submitted and secret-named environment values', () => {
  expect(
    collectKnownSecrets(
      {
        SYNTHETIC_API_TOKEN: OPAQUE,
        ANTHROPIC_API_KEY: 'k9',
        HOME: '/home/synthetic-user-dir',
        EMPTY_TOKEN: '',
        UNSET_TOKEN: undefined,
      },
      ['synthetic-submitted-key', 'q', ''],
    )?.sort(),
  ).toEqual([OPAQUE, 'k9', 'q', 'synthetic-submitted-key'].sort())
})

test('credential collection fails closed on proxies, accessors and malformed input without running them', () => {
  const touched: string[] = []
  const accessorArray = ['ok-secret']
  Object.defineProperty(accessorArray, '1', {
    get() {
      touched.push('array getter')
      return OPAQUE
    },
    enumerable: true,
  })
  const proxyArray = new Proxy([OPAQUE], {
    get(target, key) {
      touched.push(`array ${String(key)}`)
      return Reflect.get(target, key)
    },
    ownKeys(target) {
      touched.push('array keys')
      return Reflect.ownKeys(target)
    },
  })
  const accessorEnv: Record<string, unknown> = { HOME: '/tmp/x' }
  Object.defineProperty(accessorEnv, 'SYNTHETIC_TOKEN', {
    get() {
      touched.push('env getter')
      return OPAQUE
    },
    enumerable: true,
  })
  const proxyEnv = new Proxy(
    { SYNTHETIC_TOKEN: OPAQUE },
    {
      ownKeys(target) {
        touched.push('env keys')
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, key) {
        touched.push(`env ${String(key)}`)
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    },
  )
  const iterated = [OPAQUE]
  Object.defineProperty(iterated, Symbol.iterator, {
    value: () => {
      touched.push('iterator')
      return [][Symbol.iterator]()
    },
  })
  const hole: string[] = []
  hole[1] = OPAQUE
  const cases: Array<[unknown, unknown]> = [
    [{}, accessorArray],
    [{}, proxyArray],
    [accessorEnv, []],
    [proxyEnv, []],
    [{}, hole],
    [{}, [OPAQUE, 7]],
    [{}, Array.from({ length: 300 }, () => OPAQUE)],
    [{ SYNTHETIC_TOKEN: 7 }, []],
    [null, []],
    [{}, 'not-a-list'],
  ]
  for (const [env, submitted] of cases)
    expect(collectKnownSecrets(env, submitted)).toBeUndefined()
  expect(collectKnownSecrets({}, iterated)).toEqual([OPAQUE])
  expect(touched).toEqual([])
})

test('a failed credential collection keeps the fixed screen and withholds the detail', async () => {
  const root = await stateRoot()
  const env = { XDG_STATE_HOME: root }
  const directory = cliDiagnosticsDirectory(env)
  if (directory === undefined) throw new Error('No diagnostics directory')
  let getterRuns = 0
  const submitted = [SK]
  Object.defineProperty(submitted, '1', {
    get() {
      getterRuns += 1
      return OPAQUE
    },
    enumerable: true,
  })
  const screen = await reportThrownFailure(
    'cli-login',
    new Error(`exchange echoed ${OPAQUE} and ${SK}`),
    env,
    submitted,
  )
  expect(screen.startsWith('Login failed (cli-login/unexpected-error).')).toBe(
    true,
  )
  const record = await diagnosticFile(screen, directory)
  expect(record.detail).toEqual([CLI_FAILURE_SECRETS_UNREADABLE])
  expectNoPieceOf(OPAQUE, record.text + screen)
  expectNoPieceOf(SK, record.text + screen)
  expect(getterRuns).toBe(0)
})

test('an environment that cannot be read safely gets no diagnostics file', async () => {
  let traps = 0
  const env = new Proxy(
    {},
    {
      get() {
        traps += 1
        return undefined
      },
    },
  )
  expect(await reportThrownFailure('cli-command', new Error(OPAQUE), env)).toBe(
    'Command failed (cli-command/unexpected-error). Details could not be saved to a private diagnostics file.',
  )
  expect(traps).toBe(0)
})

test('raw text is cut only at line breaks before redaction, so no credential piece escapes', () => {
  // Redaction shrinks each 2000-character line to ten characters, so a raw
  // cut through a credential would land well inside the kept output.
  const secret = syntheticSecret(2000, 7)
  const text = `${Array.from({ length: 40 }, () => secret).join('\n')}\n`
  for (const keep of ['head', 'tail'] as const) {
    const redactor = createProviderErrorRedactor([secret])
    try {
      const lines = boundRedactedDetail(text, redactor, keep)
      expectNoPieceOf(secret, lines.join('\n'))
      expect(lines).toContain(CLI_FAILURE_OMITTED)
      expect(lines.filter((line) => line === '[REDACTED]').length).toBe(32)
    } finally {
      redactor.dispose()
    }
  }
  // A single line longer than the raw window has no safe cut point.
  const redactor = createProviderErrorRedactor([])
  try {
    expect(
      boundRedactedDetail(`${'x'.repeat(70_000)}${secret}`, redactor, 'tail'),
    ).toEqual([CLI_FAILURE_WITHHELD])
  } finally {
    redactor.dispose()
  }
})

test('an oversized redacted line is cut on a UTF-8 code point boundary', () => {
  const redactor = createProviderErrorRedactor([OPAQUE])
  try {
    const line = `${'漢'.repeat(3000)} ${OPAQUE} ✓`
    for (const keep of ['head', 'tail'] as const) {
      const lines = boundRedactedDetail(line, redactor, keep)
      const kept = keep === 'tail' ? lines[1] : lines[0]
      expect(lines).toContain(CLI_FAILURE_OMITTED)
      if (kept === undefined) throw new Error('Missing kept text')
      expect(kept).not.toContain('\uFFFD')
      const size = new TextEncoder().encode(kept).length
      expect(size).toBeLessThanOrEqual(CLI_FAILURE_DETAIL_MAX_BYTES - 1)
      expect(size).toBeGreaterThan(CLI_FAILURE_DETAIL_MAX_BYTES - 4)
      expectNoPieceOf(OPAQUE, kept)
    }
  } finally {
    redactor.dispose()
  }
})

interface CliRun {
  exitCode: number
  stdout: string
  stderr: string
}

async function runCli(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let exited = false
  const cancellation = gate()
  trackDetached(
    cancellation.wait.then(() => {
      if (!exited) child.kill()
    }),
  )
  const [exit, out, err] = await Promise.allSettled([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  exited = true
  const failures = [exit, out, err].flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (failures.length)
    throw new AggregateError(failures, 'CLI child drainage failed')
  if (
    exit.status !== 'fulfilled' ||
    out.status !== 'fulfilled' ||
    err.status !== 'fulfilled'
  )
    throw new Error('CLI child result missing')
  return {
    exitCode: exit.value,
    stdout: out.value,
    stderr: err.value,
  } satisfies CliRun
}

async function cliHome() {
  const root = await stateRoot()
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    XDG_STATE_HOME: join(root, '.local', 'state'),
    // Core's logger skips file writes when NODE_ENV is 'test'; production mode
    // lets this test check that failure detail never reaches that shared log.
    NODE_ENV: 'production',
    OPENCODE_ANTHROPIC_AUTH_LOG_FILE: join(root, 'plugin.log'),
    SYNTHETIC_SERVICE_TOKEN: OPAQUE,
  }
  const diagnostics = cliDiagnosticsDirectory(env)
  if (diagnostics === undefined) throw new Error('No diagnostics directory')
  return {
    root,
    env,
    diagnostics,
    pluginLog: env.OPENCODE_ANTHROPIC_AUTH_LOG_FILE as string,
  }
}

test('CLI prints a fixed code and the private file holding the scrubbed detail', async () => {
  const { root, env, diagnostics, pluginLog } = await cliHome()
  // A non-directory parent forces ENOTDIR to quote the credential-bearing path.
  const blocker = join(root, 'blocker')
  await writeFile(blocker, 'not a directory')
  const echoed = join(blocker, JWT, SK, OPAQUE, 'anthropic-auth.json')
  const result = await runCli(['list'], {
    ...env,
    OPENCODE_ANTHROPIC_AUTH_FILE: echoed,
    OPENCODE_ANTHROPIC_AUTH_STATE_FILE: `${echoed}.state`,
  })
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toBe('')
  expect(
    result.stderr.startsWith(
      'Account listing failed (cli-list/unexpected-error). Details were written to ',
    ),
  ).toBe(true)
  expect(result.stderr.trim().split('\n')).toHaveLength(1)

  const record = await diagnosticFile(result.stderr, diagnostics)
  for (const secret of [JWT, SK, OPAQUE]) expectNoPieceOf(secret, record.text)
  expect(record.text).toContain(' ERROR [cli] Account listing failed ')
  expect(record.payload.stage).toBe('cli-list')
  expect(record.payload.code).toBe('cli-list/unexpected-error')
  expect(record.detail).toContain('code: ENOTDIR')
  expect(JSON.stringify(record.detail)).toContain(
    `${join(blocker, '[REDACTED]', '[REDACTED]', '[REDACTED]', 'anthropic-auth.json')}`,
  )
  await expect(stat(pluginLog)).rejects.toThrow()
})

test('CLI keeps known fixed remedies word for word and records nothing', async () => {
  const { root, env, diagnostics, pluginLog } = await cliHome()
  await mkdir(join(root, 'store'))
  const result = await runCli(['list'], {
    ...env,
    OPENCODE_ANTHROPIC_AUTH_FILE: join(root, 'store', 'anthropic-auth.json'),
    OPENCODE_AUTH_CONTENT: '{}',
  })
  expect(result).toEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'Native account changes require offline setup without OPENCODE_AUTH_CONTENT\n',
  })
  await expect(stat(diagnostics)).rejects.toThrow()
  await expect(stat(pluginLog)).rejects.toThrow()
})

test('relay setup reports a failed workers.dev enablement through the same boundary', async () => {
  const state = await stateRoot()
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'cli-failure-relay-'))
  const fixture = await migrateNativeOpencodeFixture({
    root: fixtureRoot,
    lifetime: { deferCleanup, trackDetached },
    legacyConfig: { version: 1, accounts: [] },
  })
  const overrides: Record<string, string | undefined> = {
    ...fixture.env,
    XDG_STATE_HOME: state,
    CLOUDFLARE_API_TOKEN: OPAQUE,
    CLOUDFLARE_ACCOUNT_ID: 'synthetic-account',
    OPENCODE_AUTH_CONTENT: undefined,
  }
  const saved = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  )
  deferCleanup(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const fetchImpl = async (input: string | URL | Request) => {
    const url = input.toString()
    if (url.includes('/storage/kv/namespaces'))
      return Response.json({ success: true, result: { id: 'kv-id' } })
    if (url.includes('/workers/scripts/opencode-anthropic-relay/subdomain'))
      return Response.json(
        {
          success: false,
          errors: [{ message: `token ${OPAQUE} rejected; jwt ${JWT}` }],
        },
        { status: 403 },
      )
    if (url.includes('/workers/subdomain'))
      return Response.json({
        success: true,
        result: { subdomain: 'synthetic-subdomain' },
      })
    if (url.includes('/workers/scripts/opencode-anthropic-relay'))
      return Response.json({ success: true, result: {} })
    throw new Error(`Unexpected relay request ${url}`)
  }
  const warnings: string[] = []
  await relaySetup({
    fetchImpl,
    prompt: async () => '',
    warn: (message) => warnings.push(message),
  })
  expect(warnings).toHaveLength(1)
  const [warning = ''] = warnings
  expect(
    warning.startsWith(
      'Workers.dev enablement failed (cli-relay-workers-dev/unexpected-error). Details were written to ',
    ),
  ).toBe(true)
  const directory = cliDiagnosticsDirectory(process.env)
  if (directory === undefined) throw new Error('No diagnostics directory')
  const record = await diagnosticFile(warning, directory)
  expect(record.detail[0]).toBe(
    'Error: token [REDACTED] rejected; jwt [REDACTED]',
  )
  expectNoPieceOf(OPAQUE, record.text + warning)
  expectNoPieceOf(JWT, record.text + warning)
})
