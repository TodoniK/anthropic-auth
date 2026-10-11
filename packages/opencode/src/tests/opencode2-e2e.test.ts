// This is an unconditional CI gate on the real pinned hosts and packed plugin.
// CLI installation failure is a failure, not a skipped interoperability test.
import { afterAll, beforeAll, describe, expect } from 'bun:test'
import {
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

const { test, gate, trackDetached } = createTestLifetimeSuite()

const PACKAGE = '@cortexkit/opencode-anthropic-auth'
const TOKEN = 'sk-ant-oat01-oc2-disposable-only'
const IDENTITY = '11111111-2222-4333-8444-555555555555'
const PASSWORD = 'anthropic-oc2-disposable-only'
const workspace = resolve(import.meta.dir, '../../../..')
let scratch = ''
let cli = ''
let oc1 = ''
let packedProject = ''
const children = new Set<Bun.Subprocess>()
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
) {
  const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  children.add(child)
  const stdoutWork = new Response(child.stdout).text()
  const stderrWork = new Response(child.stderr).text()
  const exitWork = child.exited
  const completed = Promise.withResolvers<void>()
  let settled = false
  const stopWork = cancellation
    ? Promise.race([cancellation.wait, completed.promise]).then(() => {
        if (!settled && child.exitCode === null) child.kill('SIGKILL')
      })
    : Promise.resolve()
  if (cancellation) trackDetached(stopWork)
  const timer = setTimeout(() => child.kill('SIGKILL'), limit)
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
      await writeFile(join(logs, `${prefix}-stdout.log`), stdout)
      await writeFile(join(logs, `${prefix}-stderr.log`), stderr)
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
) {
  const result = await command(args, cwd, env)
  if (result.exit !== 0)
    throw new Error(
      `Disposable command failed: ${args[0]} ${args[1]}\n${result.stdout}\n${result.stderr}`,
    )
  return result
}

beforeAll(async () => {
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
  await requireCommand(
    ['npm', 'install', '--no-audit', '--no-fund', 'opencode-ai@1.18.31'],
    install1,
    await isolatedEnv(install1),
  )
  oc1 = join(install1, 'node_modules', '.bin', 'opencode')
  packedProject = join(scratch, 'packed')
  await mkdir(packedProject, { recursive: true })
  const pack = join(scratch, 'archives')
  await mkdir(pack, { recursive: true })
  for (const pkg of ['core', 'opencode']) {
    await requireCommand(
      ['bun', 'pm', 'pack', '--destination', pack],
      join(workspace, 'packages', pkg),
      env,
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
  )
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
async function scenario(
  transport: 'direct' | 'http' | 'websocket',
  host: 'oc1' | 'oc2' = 'oc2',
  entry: 'package' | 'main' = 'package',
  mode?: 'tool' | 'structured',
) {
  const root = await mkdtemp(join(scratch, 'scenario-'))
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
        return toolReply(payload.model, payload.tool_choice.name, {
          [key]: join(project, 'fixture.txt'),
        })
      }
      return reply(
        payload.model,
        mode === 'structured'
          ? '{"answer":"OC2_SYNTHETIC_OK"}'
          : 'OC2_SYNTHETIC_OK',
      )
    },
  })
  const relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const envelope = (await request.json()) as RelayEnvelope
      envelopes.push(envelope)
      expect(request.headers.get('authorization')).toBeNull()
      expect(request.headers.get('x-relay-token')).toBe('relay-disposable-only')
      return fetch(envelope.upstream.url, {
        method: envelope.upstream.method,
        headers: envelope.upstream.headers,
        body: envelope.body,
      })
    },
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
  )
  if (result.exit !== 0)
    console.error(JSON.stringify({ host, entry, mode, ...result }))
  if (mode)
    console.error(
      JSON.stringify({
        mode,
        audit: await readFile(join(project, 'hook-audit.jsonl'), 'utf8').catch(
          () => 'not-created',
        ),
        stdout: result.stdout,
        stderr: result.stderr,
        models: wire.map((send) => ({
          model: JSON.parse(send.body).model,
          toolChoice: JSON.parse(send.body).tool_choice,
          outputConfig: JSON.parse(send.body).output_config,
        })),
      }),
    )
  try {
    return { result, wire, envelopes, paths, root, env }
  } finally {
    await upstream.stop(true)
    await relay.stop(true)
  }
}

/**
 * Runs one host scenario and hands it to `body`, then deletes the scenario's
 * temporary directory, including its host logs. If `body` fails, the logs are
 * printed first so the failure can still be diagnosed after the deletion.
 */
async function withScenario(
  args: Parameters<typeof scenario>,
  body: (run: Awaited<ReturnType<typeof scenario>>) => Promise<void> | void,
) {
  const run = await scenario(...args)
  try {
    await body(run)
  } catch (error) {
    const logs = hostLogDirectory(run.env)
    for (const name of logs ? await readdir(logs).catch(() => []) : [])
      console.error(
        `${name}:\n${await readFile(join(logs ?? '', name), 'utf8')}`,
      )
    throw error
  } finally {
    await rm(run.root, { recursive: true, force: true })
  }
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
