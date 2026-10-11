// This is an unconditional CI gate on the real pinned hosts and packed plugin.
// CLI installation failure is a failure, not a skipped interoperability test.
import { afterAll, beforeAll, describe, expect } from 'bun:test'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CLAUDE_CODE_IDENTITY,
  captureNativeLocalPoolBinding,
  createNativePoolStore,
  custodyTombstoneOAuth,
  resolveNativePoolPaths,
  runNativeMigration,
  signRequestBody,
  USER_AGENT,
} from '@cortexkit/anthropic-auth-core'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { fingerprintOf } from '@cortexkit/common-auth/store'
import { Host } from '@opencode/plugin/host'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import {
  createTestLifetimeSuite,
  type TestGate,
} from '../../../core/src/tests/test-lifetime'
import { tokenFingerprint } from '../../../core/src/token-fingerprint'
import { seedOpencodeConfigDependencies } from '../../../e2e-tests/src/opencode-runner'

const { test, gate, trackDetached, deferCleanup } = createTestLifetimeSuite()

const PACKAGE = '@cortexkit/opencode-anthropic-auth'
const TOKEN = 'sk-ant-oat01-oc2-disposable-only'
const IDENTITY = '11111111-2222-4333-8444-555555555555'
const PASSWORD = 'anthropic-oc2-disposable-only'
const workspace = resolve(import.meta.dir, '../../../..')
let scratch = ''
let cli = ''
let oc1 = ''
let packedProject = ''
/** The plugin SDK tree OpenCode 1 (OC1) expects in each config directory, at OC1's own version. */
let oc1ConfigDependencies = { fixture: '', version: '' }
const children = new Set<Bun.Subprocess>()

function phaseClock() {
  const started = performance.now()
  const phases: Record<string, { at: string; elapsedMs: number }> = {}
  return {
    phases,
    mark(name: string) {
      phases[name] ??= {
        at: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - started),
      }
    },
  }
}
const installation = phaseClock()
type CommandClock = { clock: ReturnType<typeof phaseClock>; name: string }

const redactFixtureSecrets = (text: string) =>
  [TOKEN, PASSWORD, 'synthetic-refresh', 'relay-disposable-only'].reduce(
    (redacted, secret) => redacted.replaceAll(secret, '[redacted]'),
    text,
  )
/**
 * Host output is kept inside the fixture that ran it: the temporary directory
 * isolatedEnv gives each host as TMPDIR. Removing that fixture removes these
 * logs, so they never outlive the test run.
 */
const hostLogDirectory = (env: Record<string, string>) =>
  env.TMPDIR ? join(env.TMPDIR, 'host-logs') : undefined

/** Also used for installation: the CLI's postinstall runs --version itself. */
async function isolatedEnv(root: string): Promise<Record<string, string>> {
  const directories = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    TMPDIR: join(root, 'tmp'),
  }
  await Promise.all(
    Object.values(directories).map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  )
  return {
    PATH: process.env.PATH ?? '',
    ...directories,
    OPENCODE_DB: join(root, 'disposable.sqlite'),
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    OPENCODE_PASSWORD: PASSWORD,
    OPENCODE_ANTHROPIC_AUTH_LOG_FILE: join(root, 'anthropic-auth.log'),
  }
}
async function command(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  limit = 60_000,
  cancellation?: TestGate,
  timing?: CommandClock,
) {
  timing?.clock.mark(`${timing.name}.start`)
  const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  children.add(child)
  const stdoutWork = new Response(child.stdout).text()
  const stderrWork = new Response(child.stderr).text()
  const exitWork = child.exited.then((exit) => {
    timing?.clock.mark(`${timing.name}.exit`)
    return exit
  })
  const completed = Promise.withResolvers<void>()
  let settled = false
  const stopWork = cancellation
    ? Promise.race([cancellation.wait, completed.promise]).then(() => {
        if (!settled && child.exitCode === null) {
          timing?.clock.mark(`${timing.name}.cancelled`)
          child.kill('SIGKILL')
        }
      })
    : Promise.resolve()
  if (cancellation) trackDetached(stopWork)
  const timer = setTimeout(() => {
    timing?.clock.mark(`${timing.name}.deadline`)
    child.kill('SIGKILL')
  }, limit)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      stdoutWork,
      stderrWork,
      exitWork,
    ])
    const logs = hostLogDirectory(env)
    if (logs && (args[0] === cli || args[0] === oc1)) {
      await mkdir(logs, { recursive: true })
      const prefix = `${Date.now()}-${args[0] === cli ? 'oc2' : 'oc1'}`
      await writeFile(
        join(logs, `${prefix}-stdout.log`),
        redactFixtureSecrets(stdout),
      )
      await writeFile(
        join(logs, `${prefix}-stderr.log`),
        redactFixtureSecrets(stderr),
      )
    }
    return { stdout, stderr, exit }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
    settled = true
    completed.resolve()
    await Promise.allSettled([stdoutWork, stderrWork, exitWork, stopWork])
    children.delete(child)
  }
}
async function requireCommand(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timing?: CommandClock,
) {
  const result = await command(args, cwd, env, 60_000, undefined, timing)
  if (result.exit !== 0)
    throw new Error(
      redactFixtureSecrets(
        `Disposable command failed: ${args[0]} ${args[1]}\n${result.stdout}\n${result.stderr}`,
      ),
    )
  return result
}

async function installPackedHosts() {
  const cache = join(workspace, 'node_modules', '.cache', 'opencode2-e2e')
  await mkdir(cache, { recursive: true })
  scratch = await mkdtemp(join(cache, 'fixture-'))
  const install = join(scratch, 'install')
  await mkdir(install, { recursive: true })
  const env = await isolatedEnv(install)
  // Both real hosts are installed from the npm registry. If it is
  // unreachable, fail here before an install stalls: an offline runner must
  // report this test as failed, never skip it.
  const registry = await command(
    [
      'npm',
      'ping',
      '--registry=https://registry.npmjs.org',
      '--fetch-retries=0',
      '--fetch-timeout=2000',
    ],
    install,
    env,
    10_000,
    undefined,
    { clock: installation, name: 'registry' },
  )
  if (registry.exit !== 0)
    throw new Error(
      `Packed OpenCode host verification requires npm registry access. Run this gate in network-enabled CI; no host checks ran.\n${registry.stdout}\n${registry.stderr}`,
    )
  await writeFile(
    join(install, 'package.json'),
    JSON.stringify({ private: true }),
  )
  await requireCommand(
    ['npm', 'install', '--no-audit', '--no-fund', '@opencode/cli@2.0.22'],
    install,
    env,
    { clock: installation, name: 'oc2.install' },
  )
  cli = join(install, 'node_modules', '.bin', 'opencode')
  const version = await requireCommand([cli, '--version'], install, env)
  expect(version.stdout).toContain('2.0.22')
  const install1 = join(scratch, 'install1')
  await mkdir(install1, { recursive: true })
  await writeFile(
    join(install1, 'package.json'),
    JSON.stringify({ private: true }),
  )
  const env1 = await isolatedEnv(install1)
  await requireCommand(
    ['npm', 'install', '--no-audit', '--no-fund', 'opencode-ai@1.18.31'],
    install1,
    env1,
    { clock: installation, name: 'oc1.install' },
  )
  oc1 = join(install1, 'node_modules', '.bin', 'opencode')
  const oc1Version = JSON.parse(
    await readFile(
      join(install1, 'node_modules', 'opencode-ai', 'package.json'),
      'utf8',
    ),
  ).version
  expect(oc1Version).toBe('1.18.31')
  // OC1 installs @opencode-ai/plugin at its own version into each config
  // directory before it loads plugins. Install that tree once here, while
  // the registry is reachable, the same way OC1 does (npm, no install
  // scripts), so each OC1 scenario can be given a complete copy.
  const sdk = join(scratch, 'oc1-config-deps')
  await mkdir(sdk, { recursive: true })
  await writeFile(
    join(sdk, 'package.json'),
    JSON.stringify({ dependencies: { '@opencode-ai/plugin': oc1Version } }),
  )
  await requireCommand(
    ['npm', 'install', '--no-audit', '--no-fund', '--ignore-scripts'],
    sdk,
    env1,
    { clock: installation, name: 'oc1.sdk.install' },
  )
  oc1ConfigDependencies = { fixture: sdk, version: oc1Version }
  packedProject = join(scratch, 'packed')
  await mkdir(packedProject, { recursive: true })
  const pack = join(scratch, 'archives')
  await mkdir(pack, { recursive: true })
  for (const pkg of ['core', 'opencode']) {
    await requireCommand(
      ['bun', 'pm', 'pack', '--destination', pack],
      join(workspace, 'packages', pkg),
      env,
      { clock: installation, name: `${pkg}.pack` },
    )
  }
  const archives = (await readdir(pack))
    .filter((file) => file.endsWith('.tgz'))
    .map((file) => join(pack, file))
  expect(archives).toHaveLength(2)
  await writeFile(
    join(packedProject, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  )
  await requireCommand(
    ['npm', 'install', '--no-audit', '--no-fund', ...archives],
    packedProject,
    env,
    { clock: installation, name: 'packed.install' },
  )
}

beforeAll(async () => {
  installation.mark('dependencies.start')
  try {
    await installPackedHosts()
    installation.mark('dependencies.ready')
  } catch (error) {
    installation.mark('dependencies.failed')
    console.error(
      JSON.stringify({ phaseClocks: { installation: installation.phases } }),
    )
    throw error
  }
}, 180_000)
afterAll(async () => {
  for (const child of children)
    if (child.exitCode === null) child.kill('SIGKILL')
  await Promise.all([...children].map((child) => child.exited))
  children.clear()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

/**
 * Seed synthetic accounts without network access. The plugin serves model
 * requests only after the native credential migration has committed its
 * journal (the record that host credentials moved into the account pool), so
 * the seed runs that migration before adding accounts.
 */
async function seed(
  env: Record<string, string>,
  relay?: { url: string; transport: 'http' | 'websocket' },
) {
  const config = join(env.XDG_CONFIG_HOME!, 'opencode', 'anthropic-auth.json')
  await mkdir(dirname(config), { recursive: true, mode: 0o700 })
  const paths = await resolveNativePoolPaths(
    config,
    join(dirname(config), 'anthropic-auth-state.json'),
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
    hostAuthPath: join(env.XDG_DATA_HOME!, 'opencode', 'auth.json'),
    routingSourcePath: join(dirname(config), 'legacy-routing.json'),
    routingDestinationPath: join(dirname(config), 'native-routing.json'),
    env,
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  await store.add({
    id: 'main',
    identity: IDENTITY,
    credential: {
      type: 'oauth',
      access: TOKEN,
      refresh: 'synthetic-refresh',
      expires: Date.now() + 3600_000,
    },
  })
  await store.updateSettings(() => ({
    mainAccountId: 'main',
    routing: { mode: 'main-first' },
    quota: { enabled: false },
    ...(relay
      ? { relay: { enabled: true, ...relay, fallbackToDirect: true } }
      : {}),
  }))
  const current = await store.read()
  if (
    current.status !== 'ready' ||
    !current.rows[0]?.credential ||
    current.rows[0].credential.type !== 'oauth'
  )
    throw new Error('Seeded row missing')
  const row = current.rows[0]
  const credential = row.credential
  if (
    credential?.type !== 'oauth' ||
    !credential.access ||
    credential.expires === undefined
  )
    throw new Error('Seeded access missing')
  const binding = captureNativeLocalPoolBinding(paths, row)
  await writeFile(
    paths.runtime,
    JSON.stringify({
      version: 1,
      storageId: paths.storageId,
      ...(relay ? { relay: { token: 'relay-disposable-only' } } : {}),
      accounts: {
        main: {
          binding,
          credentialValidation: {
            binding,
            credentialFingerprint: fingerprintOf(credential),
            version: {
              accessFingerprint: tokenFingerprint(credential.access),
              expires: credential.expires,
              ...(Object.hasOwn(credential, 'lastRefreshedAt')
                ? { lastRefreshedAt: credential.lastRefreshedAt }
                : {}),
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  )
  // Corrupt the pre-migration account files. A request can then succeed only
  // with the credentials in migrated storage, and the direct-request test
  // checks the legacy credential file is still unchanged afterwards.
  await writeFile(paths.legacyConfig, '{invalid legacy config')
  await writeFile(paths.legacyState, '{invalid legacy credential state')
  return paths
}

/**
 * OpenCode 1.18.31 prepares two dependency trees before it loads plugins and
 * sends the model request, and installs either one from the npm registry
 * when it is missing. The scenario's proxy blocks the registry, and npm's
 * retry backoff can outlast the 60-second host deadline, so the host never
 * reaches the synthetic upstream. Seed both trees from packages installed
 * earlier in this run, only inside the scenario root the test body removes:
 *
 * - Every config directory OC1 reads gets @opencode-ai/plugin at OC1's own
 *   version as a manifest, lockfile and installed tree. OC1 skips its install
 *   when node_modules exists and the lockfile root names every dependency.
 * - OC1 installs a plugin named by bare package name into its own package
 *   cache, never resolving it from the project's node_modules, and reuses an
 *   existing install there. That cache gets the packed plugin and its
 *   dependencies, so OC1 loads the packed build rather than fetching the
 *   published `latest` one.
 */
async function seedOc1Bootstrap(
  root: string,
  project: string,
  env: Record<string, string>,
  plugin: string,
  dependencies: { fixture: string; version: string },
) {
  const declared = JSON.parse(
    await readFile(join(dependencies.fixture, 'package.json'), 'utf8'),
  ).dependencies?.['@opencode-ai/plugin']
  if (declared !== dependencies.version)
    throw new Error(
      `OC1 ${dependencies.version} needs @opencode-ai/plugin ${dependencies.version}; the config dependency fixture declares ${declared}`,
    )
  const configDirectory = join(env.XDG_CONFIG_HOME!, 'opencode')
  const seeded = await seedOpencodeConfigDependencies(
    {
      tempDir: root,
      workdir: project,
      homeDir: env.HOME!,
      configDir: env.XDG_CONFIG_HOME!,
      dataDir: env.XDG_DATA_HOME!,
      cacheDir: env.XDG_CACHE_HOME!,
      quotaFeedDir: join(root, 'quota-feed'),
    },
    // OC1 runs here without OPENCODE_CONFIG_DIR, but the shared helper always
    // adds that variable's directory as a target. Name the XDG config
    // directory, which is already a target, so an unset value cannot resolve
    // to the test process's working directory.
    { ...env, OPENCODE_CONFIG_DIR: configDirectory },
    dependencies.fixture,
  )
  if (plugin === PACKAGE)
    await cp(
      join(project, 'node_modules'),
      join(
        env.XDG_CACHE_HOME!,
        'opencode',
        'packages',
        `${PACKAGE}@latest`,
        'node_modules',
      ),
      {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      },
    )
  return seeded.targets
}

/**
 * Startup evidence that host stdout and stderr do not carry. OC1 writes its
 * own log, including any failed background dependency install, under
 * XDG_DATA_HOME/opencode/log. Report that log with fixture secrets redacted,
 * and the plugin SDK version installed in the isolated config directory.
 */
async function hostBootstrapReport(env: Record<string, string>) {
  const lines: string[] = []
  if (env.XDG_CONFIG_HOME)
    lines.push(
      `config plugin SDK: ${await readFile(
        join(
          env.XDG_CONFIG_HOME,
          'opencode',
          'node_modules',
          '@opencode-ai',
          'plugin',
          'package.json',
        ),
        'utf8',
      ).then(
        (text) => String(JSON.parse(text).version),
        () => 'missing',
      )}`,
    )
  const logs = env.XDG_DATA_HOME
    ? join(env.XDG_DATA_HOME, 'opencode', 'log')
    : undefined
  for (const name of logs ? await readdir(logs).catch(() => []) : [])
    lines.push(
      `host log ${name}:\n${redactFixtureSecrets(
        await readFile(join(logs ?? '', name), 'utf8'),
      )}`,
    )
  return lines
}

const frame = (type: string, data: unknown) =>
  `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
function reply(model: string, text = 'OC2_SYNTHETIC_OK') {
  return new Response(
    [
      frame('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_oc2_synthetic',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join(''),
    {
      headers: {
        'content-type': 'text/event-stream',
        'request-id': 'req_oc2_synthetic',
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
      },
    },
  )
}
function toolReply(
  model: string,
  name: string,
  input: Record<string, unknown>,
) {
  return new Response(
    [
      frame('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_oc2_tool',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_oc2_read',
          name,
          input: {},
        },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(input),
        },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 6 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join(''),
    {
      headers: {
        'content-type': 'text/event-stream',
        'request-id': 'req_oc2_tool',
      },
    },
  )
}
interface Wire {
  readonly body: string
  readonly headers: Headers
  readonly url: string
}
interface RelayEnvelope extends Record<string, unknown> {
  readonly upstream: {
    url: string
    method: string
    headers: Record<string, string>
  }
  readonly body: string
}
type ScenarioArgs = [
  transport: 'direct' | 'http' | 'websocket',
  host?: 'oc1' | 'oc2',
  entry?: 'package' | 'main',
  mode?: 'tool' | 'structured',
]
async function scenario(
  args: ScenarioArgs,
  clock: ReturnType<typeof phaseClock>,
) {
  const [transport, host = 'oc2', entry = 'package', mode] = args
  clock.mark('fixture.start')
  const root = await mkdtemp(join(scratch, 'scenario-'))
  // Remove everything this scenario seeds even if setup fails before it
  // returns; withScenario reports failure evidence before this runs.
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await requireCommand(['git', 'init', '-q'], project, {
    PATH: process.env.PATH ?? '',
  })
  await Bun.$`cp -R ${join(packedProject, 'node_modules')} ${join(project, 'node_modules')}`.quiet()
  const env = await isolatedEnv(root)
  Object.assign(env, {
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  })
  const wire: Wire[] = []
  const envelopes: Record<string, unknown>[] = []
  let usedTool = false
  await writeFile(join(project, 'fixture.txt'), 'OC2_NATIVE_TOOL_FILE')
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      clock.mark('upstream.first_request')
      try {
        const body = await request.text()
        wire.push({
          body,
          headers: new Headers(request.headers),
          url: request.url,
        })
        const payload = JSON.parse(body)
        if (
          mode === 'tool' &&
          payload.tool_choice?.type === 'tool' &&
          !usedTool
        ) {
          usedTool = true
          const tool = payload.tools.find(
            (tool: { name: string }) => tool.name === payload.tool_choice.name,
          )
          const key = tool?.input_schema?.properties?.path ? 'path' : 'filePath'
          const response = toolReply(payload.model, payload.tool_choice.name, {
            [key]: join(project, 'fixture.txt'),
          })
          clock.mark('upstream.first_response')
          return response
        }
        const response = reply(
          payload.model,
          mode === 'structured'
            ? '{"answer":"OC2_SYNTHETIC_OK"}'
            : 'OC2_SYNTHETIC_OK',
        )
        clock.mark('upstream.first_response')
        return response
      } catch {
        clock.mark('upstream.transport_failure')
        throw new Error(
          'Synthetic upstream transport failed (details redacted)',
        )
      }
    },
  })
  const relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      clock.mark('relay.first_request')
      try {
        const envelope = (await request.json()) as RelayEnvelope
        envelopes.push(envelope)
        expect(request.headers.get('authorization')).toBeNull()
        expect(request.headers.get('x-relay-token')).toBe(
          'relay-disposable-only',
        )
        const response = await fetch(envelope.upstream.url, {
          method: envelope.upstream.method,
          headers: envelope.upstream.headers,
          body: envelope.body,
        })
        clock.mark('relay.first_response')
        return response
      } catch {
        clock.mark('relay.transport_failure')
        throw new Error('Synthetic relay transport failed (details redacted)')
      }
    },
  })
  deferCleanup(async () => {
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => upstream.stop(true)),
      Promise.resolve().then(() => relay.stop(true)),
    ])
    if (stopped.some((result) => result.status === 'rejected')) {
      clock.mark('fixture.cleanup_failure')
      throw new Error('Synthetic transport cleanup failed (details redacted)')
    }
  })
  const paths = await seed(
    env,
    transport === 'direct' ? undefined : { url: relay.url.href, transport },
  )
  const configDirectory = join(env.XDG_CONFIG_HOME!, 'opencode')
  const packed = join(project, 'node_modules', PACKAGE)
  const manifest = JSON.parse(
    await readFile(join(packed, 'package.json'), 'utf8'),
  )
  let plugin = entry === 'main' ? join(packed, manifest.main) : PACKAGE
  if (mode) {
    // OpenCode 2 loads a local plugin from a directory package's server.js.
    // This server.js registers a request hook that adds the test's forced
    // read-tool choice or JSON output schema, then runs the packed ./server
    // setup, so those requests pass through the packed production adapter.
    const pluginDirectory = join(project, 'wire-loop')
    await mkdir(pluginDirectory)
    await writeFile(
      join(pluginDirectory, 'package.json'),
      JSON.stringify({
        name: '@cortexkit/oc2-wire-fixture',
        version: '0.0.0',
        type: 'module',
        exports: { './server': './server.js' },
      }),
    )
    plugin = join(pluginDirectory, 'server.js')
    await writeFile(
      plugin,
      `import native from '${PACKAGE}/server'; import {appendFileSync} from 'node:fs';
export default {id:'cortexkit-anthropic-auth',async setup(ctx){appendFileSync('${join(project, 'hook-audit.jsonl')}',JSON.stringify({setup:true})+'\\n');let forced=false;const hook=await ctx.session.hook('http.request',async draft=>{appendFileSync('${join(project, 'hook-audit.jsonl')}',JSON.stringify({kind:draft.kind,model:draft.model})+'\\n');if(draft.kind!=='primary')return;const body=await draft.request.json();${mode === 'structured' ? `body.output_config={...body.output_config,format:{type:'json_schema',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false}}};` : `if(!forced){const tool=body.tools.find(tool=>/read/i.test(tool.name));if(!tool)throw new Error('Native read tool is missing');body.tool_choice={type:'tool',name:tool.name};forced=true;}`}draft.request=new Request(draft.request,{body:JSON.stringify(body)});},{providerID:'anthropic'});const cleanup=await native.setup(ctx);return async()=>{await cleanup();await hook.dispose()}}};`,
    )
    plugin = pathToFileURL(pluginDirectory).href
  }
  if (host === 'oc1') {
    await mkdir(join(env.XDG_DATA_HOME!, 'opencode'), { recursive: true })
    await writeFile(
      join(env.XDG_DATA_HOME!, 'opencode', 'auth.json'),
      JSON.stringify({ anthropic: custodyTombstoneOAuth('anthropic') }),
      { mode: 0o600 },
    )
  }
  await writeFile(
    join(configDirectory, 'opencode.json'),
    JSON.stringify(
      host === 'oc2'
        ? {
            plugins: [plugin],
            providers: {
              anthropic: {
                settings: {
                  apiKey: placeholderSecret('anthropic'),
                  baseURL: `${upstream.url.origin}/v1`,
                },
                models: { 'claude-sonnet-5': { name: 'Sonnet 5 synthetic' } },
              },
            },
          }
        : {
            plugin: [plugin],
            provider: {
              anthropic: { options: { baseURL: `${upstream.url.origin}/v1` } },
            },
          },
    ),
  )
  const executable = host === 'oc2' ? cli : oc1
  if (host === 'oc1')
    await seedOc1Bootstrap(root, project, env, plugin, oc1ConfigDependencies)
  const result = await command(
    [
      executable,
      'run',
      ...(host === 'oc2'
        ? ['--standalone', '--print-logs', '--log-level', 'debug']
        : []),
      '--auto',
      '--format',
      'json',
      '--model',
      'anthropic/claude-sonnet-5',
      'Say OC2_SYNTHETIC_OK',
    ],
    project,
    env,
    60_000,
    gate(),
    { clock, name: 'host' },
  )
  return { result, wire, envelopes, paths, root, env }
}

/**
 * Keep failure evidence until lifetime cancellation has drained the host.
 * Successful scenarios stay quiet; deadline failures retain their last phase.
 */
async function withScenario(
  args: ScenarioArgs,
  body: (run: Awaited<ReturnType<typeof scenario>>) => Promise<void> | void,
) {
  const clock = phaseClock()
  let passed = false
  let run: Awaited<ReturnType<typeof scenario>> | undefined
  deferCleanup(async () => {
    if (
      !passed ||
      clock.phases['host.cancelled'] ||
      clock.phases['host.deadline']
    ) {
      clock.mark('failure.report')
      console.error(
        JSON.stringify({
          scenario: args,
          phaseClocks: {
            installation: installation.phases,
            scenario: clock.phases,
          },
        }),
      )
      if (run) {
        const logs = hostLogDirectory(run.env)
        for (const name of logs ? await readdir(logs).catch(() => []) : [])
          console.error(
            `${name}:\n${await readFile(join(logs ?? '', name), 'utf8')}`,
          )
        if (args[3])
          console.error(
            await readFile(
              join(run.root, 'project/hook-audit.jsonl'),
              'utf8',
            ).catch(() => 'audit not created'),
          )
        for (const line of await hostBootstrapReport(run.env))
          console.error(line)
      }
    }
    if (run) await rm(run.root, { recursive: true, force: true })
  })
  run = await scenario(args, clock)
  await body(run)
  passed = true
}

describe('packed Anthropic plugin on pinned real hosts', () => {
  test('OC2 published loader discovers the actual packed server export and its setup function', async () => {
    const entry = Host.resolve({ name: PACKAGE, directory: packedProject })
    expect(entry.server).toContain('/dist/v2/server.js')
    if (!entry.server) throw new Error('Packed ./server export missing')
    const mod = (await Host.load(entry.server)) as {
      default: { setup: unknown; server: unknown }
    }
    expect(typeof mod.default.setup).toBe('function')
    expect(typeof mod.default.server).toBe('function')
  })
  test('real OC2 direct request uses native authority without legacy credential reads', async () => {
    await withScenario(['direct'], async (run) => {
      expect(run.result.exit).toBe(0)
      expect(run.result.stdout).toContain('OC2_SYNTHETIC_OK')
      expect(run.wire.length).toBeGreaterThan(0)
      for (const send of run.wire) {
        expect(send.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
        expect(send.headers.get('x-api-key')).toBeNull()
        expect(send.headers.get('user-agent')).toBe(USER_AGENT)
        expect(send.headers.get('x-common-auth-attempt')).toBeNull()
        const body = JSON.parse(send.body)
        expect(
          body.system.some(
            (block: { text?: string }) => block.text === CLAUDE_CODE_IDENTITY,
          ),
        ).toBe(true)
        if (body.model === 'claude-sonnet-5')
          expect(body.thinking).toEqual({
            type: 'adaptive',
            display: 'summarized',
          })
        expect(await signRequestBody(send.body)).toBe(send.body)
      }
      expect(await readFile(run.paths.legacyState, 'utf8')).toBe(
        '{invalid legacy credential state',
      )
    })
  }, 60_000)
  test('real OC2 HTTP relay delivers the exact signed native body and upstream headers', async () => {
    await withScenario(['http'], async (run) => {
      expect(run.result.exit).toBe(0)
      expect(run.result.stdout).toContain('OC2_SYNTHETIC_OK')
      expect(run.envelopes.length).toBeGreaterThan(0)
      expect(run.envelopes).toHaveLength(run.wire.length)
      for (const [index, send] of run.wire.entries()) {
        expect(run.envelopes[index]?.body).toBe(send.body)
        expect(run.envelopes[index]?.mode).toBe('full_sync')
        expect(send.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
        expect(send.headers.get('x-relay-token')).toBeNull()
        expect(await signRequestBody(send.body)).toBe(send.body)
      }
    })
  }, 60_000)
  test('real OC2 selected WebSocket relay is a zero-provider zero-relay dispatch refusal', async () => {
    await withScenario(['websocket'], async (run) => {
      expect(run.result.stdout + run.result.stderr).toContain(
        'WebSocket relay is not supported',
      )
      expect(run.wire).toHaveLength(0)
      expect(run.envelopes).toHaveLength(0)
    })
  }, 60_000)
  test('real OC2 forced tool loop restores names and round-trips tool history over HTTP relay', async () => {
    await withScenario(['http', 'oc2', 'package', 'tool'], async (run) => {
      expect(run.result.exit).toBe(0)
      expect(run.result.stdout).toContain('OC2_SYNTHETIC_OK')
      const bodies = run.wire.map((send) => JSON.parse(send.body))
      expect(
        bodies.some((body) => body.tool_choice?.name?.startsWith('mcp_')),
      ).toBe(true)
      expect(
        bodies.some((body) =>
          body.messages.some(
            (message: {
              content?: Array<{ type: string; tool_use_id?: string }>
            }) =>
              Array.isArray(message.content) &&
              message.content.some(
                (block) =>
                  block.type === 'tool_result' &&
                  block.tool_use_id === 'toolu_oc2_read',
              ),
          ),
        ),
      ).toBe(true)
    })
  }, 60_000)
  test('real OC2 native structured output keeps its schema and structured-output beta', async () => {
    await withScenario(
      ['direct', 'oc2', 'package', 'structured'],
      async (run) => {
        expect(run.result.exit).toBe(0)
        expect(run.result.stdout).toContain('OC2_SYNTHETIC_OK')
        const structured = run.wire.find(
          (send) =>
            JSON.parse(send.body).output_config?.format?.type === 'json_schema',
        )
        expect(structured).toBeDefined()
        if (!structured)
          throw new Error('Native structured output request was not dispatched')
        expect(
          JSON.parse(structured.body).output_config.format.schema.required,
        ).toEqual(['answer'])
        expect(structured.headers.get('anthropic-beta')).toContain(
          'structured-outputs',
        )
      },
    )
  }, 60_000)
  test('supported OC1 loads the packed ./server entry without invoking OC2 setup', async () => {
    await withScenario(['direct', 'oc1'], async (run) => {
      expect(run.result.exit).toBe(0)
      expect(run.result.stdout).toContain('OC2_SYNTHETIC_OK')
      expect(run.wire.length).toBeGreaterThan(0)
      expect(run.wire[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    })
  }, 60_000)
  test('supported OC1 still loads the actual packed legacy main entry', async () => {
    await withScenario(['direct', 'oc1', 'main'], async (run) => {
      expect(run.result.exit).toBe(0)
      expect(run.result.stdout).toContain('OC2_SYNTHETIC_OK')
      expect(run.wire.length).toBeGreaterThan(0)
      expect(run.wire[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    })
  }, 60_000)
})
