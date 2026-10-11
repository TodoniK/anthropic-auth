import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ProviderAccountUuid } from '@cortexkit/anthropic-auth-core'

// Real Pi host, real built-in bash tool, deterministic in-process Anthropic SSE.
// No user credentials, project configuration, Anthropic traffic, or saved session.
//
// The Pi extension serves requests only from an account pool created by the
// one-time account migration that `opencode-anthropic-auth setup` runs while
// hosts are stopped. On a fresh agent directory it refuses to load with
// "Anthropic account migration is required; run setup". This script therefore
// starts two processes, both with the same strict environment built in main():
//   1. this file again with PREPARE_FLAG. It calls runNativeMigration, the
//      migration that setup runs, exported by @cortexkit/anthropic-auth-core,
//      then stores one synthetic OAuth account. A local stand-in for the
//      Anthropic account lookup confirms that account's UUID;
//   2. the real Pi CLI, started only after step 1 exits successfully.
const PREPARE_FLAG = '--prepare-native-pool'
// Synthetic values only. The access token carries the OAuth prefix the account
// runtime accepts; the mock upstream checks that this exact token, and not the
// placeholder API key passed to Pi, authorizes every model request.
const FIXTURE_ACCESS_TOKEN = 'sk-ant-oat01-pi-host-fixture-access'
const FIXTURE_REFRESH_TOKEN = 'pi-host-fixture-refresh'
const FIXTURE_ACCOUNT_UUID = '7c4e2a91-3b5d-4f60-8e17-a2c9d04b6f35'
// The UUID shape `opencode-anthropic-auth setup` requires before it stores a
// signed-in account.
const ACCOUNT_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const CHILD_DEADLINE_MS = 30_000

interface ChildOutcome {
  stdout: string
  stderr: string
  code: number | null
  signal: string | null
  timedOut: boolean
  joinFailures: string[]
}

/**
 * Run one isolated child and collect its output. At the deadline the child is
 * killed and both pipe readers are cancelled before anything waits on them,
 * so a descendant that inherited the pipes cannot keep the joins pending.
 * Each join (stdout, stderr, exit) settles on its own; one failing does not
 * leave the others running while the caller deletes the fixture directory.
 */
async function runIsolatedChild(
  cmd: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<ChildOutcome> {
  const child = Bun.spawn({
    cmd,
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdoutReader = child.stdout.getReader()
  const stderrReader = child.stderr.getReader()
  const drain = async (reader: typeof stdoutReader) => {
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      text += decoder.decode(value, { stream: true })
    }
  }
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
    for (const reader of [stdoutReader, stderrReader])
      void reader.cancel().catch(() => {})
  }, CHILD_DEADLINE_MS)
  const [stdout, stderr, exited] = await Promise.allSettled([
    drain(stdoutReader),
    drain(stderrReader),
    child.exited,
  ])
  clearTimeout(deadline)
  const joins: Array<[string, PromiseSettledResult<unknown>]> = [
    ['stdout', stdout],
    ['stderr', stderr],
    ['exit', exited],
  ]
  const joinFailures = joins.flatMap(([name, join]) =>
    join.status === 'rejected' ? [`${name}: ${String(join.reason)}`] : [],
  )
  return {
    stdout: stdout.status === 'fulfilled' ? stdout.value : '',
    stderr: stderr.status === 'fulfilled' ? stderr.value : '',
    code: child.exitCode,
    signal: child.signalCode ?? null,
    timedOut,
    joinFailures,
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Preparation needs ${name}`)
  return resolve(value)
}

/**
 * Runs in a child process whose entire environment is the one main() builds,
 * so every path @cortexkit/anthropic-auth-core derives from process.env
 * (HOME, XDG_*, PI_*) lands inside the temporary fixture root.
 * Prints one JSON summary line on success.
 */
async function prepareNativePool(): Promise<void> {
  const core = await import('@cortexkit/anthropic-auth-core')
  const env: NodeJS.ProcessEnv = { ...process.env }
  const agentDir = requiredEnv('PI_CODING_AGENT_DIR')
  // Resolve the same files `opencode-anthropic-auth setup` resolves for Pi:
  // the extension's account file, its sibling state file, Pi's own auth.json,
  // and the sticky routing file beside the account file before migration and
  // beside the pool file after it.
  const legacyConfigPath = requiredEnv('PI_ANTHROPIC_AUTH_FILE')
  if (
    !legacyConfigPath.endsWith(core.ACCOUNT_FILE_NAME) ||
    env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE ||
    env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE
  )
    throw new Error('Preparation expects the default Pi storage layout')
  const legacyStatePath = join(
    dirname(legacyConfigPath),
    core.ACCOUNT_STATE_FILE_NAME,
  )
  const paths = await core.resolveNativePoolPaths(
    legacyConfigPath,
    legacyStatePath,
  )
  // Migration calls processFence before it reads and before it commits, to
  // refuse while a host could be using the files. The Pi CLI starts only after
  // this process exits, so no host can be running here. The callback still
  // applies setup's other refusals (a supervised host auth snapshot in the
  // environment, or Pi enrolled with a Claustrum vault), and the count shows
  // migration actually called it.
  let fenceChecks = 0
  const processFence = async () => {
    fenceChecks++
    core.requireNoSupervisedAuthContentSnapshot(env)
    if ((await core.readNativeEnrollmentMode('pi', env)) !== 'local')
      throw new Error('Fixture Pi enrollment is not local')
  }
  const journal = await core.runNativeMigration({
    paths,
    legacyConfigPath,
    legacyStatePath,
    host: 'pi',
    hostAuthPath: join(agentDir, 'auth.json'),
    routingSourcePath: resolve(
      core.getStickyRoutingStatePath(legacyConfigPath),
    ),
    routingDestinationPath: resolve(
      core.getStickyRoutingStatePath(paths.config),
    ),
    env,
    processFence,
    removePiAnthropicAuth: false,
  })
  if (fenceChecks === 0)
    throw new Error('Fixture migration did not check its process fence')
  if (journal.phase !== 'retired')
    throw new Error(`Fixture migration ended in phase ${journal.phase}`)

  if (!ACCOUNT_UUID_PATTERN.test(FIXTURE_ACCOUNT_UUID))
    throw new Error('Fixture account identity is not a UUID')
  // Signing in and the first authorization both look up the account UUID with
  // Anthropic. Answer those lookups locally, for the synthetic token only.
  // authorizeLocal records that this token was verified for that UUID, and the
  // Pi host later reuses that record instead of contacting Anthropic. Any token
  // refresh attempt is a fixture error.
  const runtime = core.createNativeAccountRuntime({
    paths,
    host: 'pi',
    local: {
      refreshToken: async () => {
        throw new Error('Fixture account must not need a token refresh')
      },
      resolveIdentity: async (accessToken) => {
        if (accessToken !== FIXTURE_ACCESS_TOKEN)
          throw new Error('Fixture account lookup received an unknown token')
        return {
          deviceId: 'pi-host-fixture-device',
          sessionId: 'pi-host-fixture-session',
          accountUuid: FIXTURE_ACCOUNT_UUID as ProviderAccountUuid,
        }
      },
    },
  })
  try {
    await runtime.loginOAuth({
      routeId: 'main',
      replace: true,
      accountIdentity: FIXTURE_ACCOUNT_UUID,
      credential: {
        access: FIXTURE_ACCESS_TOKEN,
        refresh: FIXTURE_REFRESH_TOKEN,
        expires: Date.now() + 60 * 60 * 1000,
      },
    })
    const admitted = await runtime.authorizeLocal('main', { intent: 'serve' })
    if (admitted.status !== 'usable')
      throw new Error(
        `Fixture account was not admitted: ${JSON.stringify(admitted)}`,
      )
    if (admitted.binding.identity !== FIXTURE_ACCOUNT_UUID)
      throw new Error('Fixture account was admitted with another identity')
    const snapshot = await runtime.read()
    console.log(
      JSON.stringify({
        phase: journal.phase,
        fenceChecks,
        mode: snapshot.mode,
        accounts: snapshot.accounts.map((account) => ({
          id: account.id,
          type: account.type,
          source: account.source,
          enabled: account.enabled,
          accountIdentity: account.accountIdentity,
        })),
      }),
    )
  } finally {
    runtime.close()
  }
}

async function main(): Promise<void> {
  const repo = join(import.meta.dir, '..')
  const piCli = process.env.PI_TEST_CLI ?? join(repo, 'node_modules/.bin/pi')
  const extension = resolve(
    process.env.PI_TEST_EXTENSION ?? join(repo, 'packages/pi/dist/index.js'),
  )
  const root = await mkdtemp(join(tmpdir(), 'pi-tool-mapping-'))
  const agent = join(root, 'agent')
  const temp = join(root, 'tmp')
  const report = join(root, 'requests.jsonl')
  const proof = join(root, 'tool-proof.txt')
  const mockExtension = join(root, 'mock-upstream.mjs')
  await mkdir(agent, { recursive: true })
  await mkdir(temp, { recursive: true })

  const toolCommand = `printf pi-tool-proof > ${JSON.stringify(proof)}`
  const source = `import { appendFileSync } from 'node:fs'
export default function () {
  let turn = 0
  const frame = (type, data) => 'event: ' + type + '\\ndata: ' + JSON.stringify(data) + '\\n\\n'
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/v1/messages')) {
      appendFileSync(${JSON.stringify(report)}, JSON.stringify({ unmocked: url }) + '\\n')
      throw new Error('Unmocked network attempt: ' + url)
    }
    turn++
    const body = JSON.parse(String(init?.body))
    const headers = new Headers(init?.headers)
    const servedByMigratedAccount = headers.get('authorization') === ${JSON.stringify(`Bearer ${FIXTURE_ACCESS_TOKEN}`)} && !headers.has('x-api-key')
    const advertised = body.tools?.map((tool) => tool.name) ?? []
    const hasPrompt = JSON.stringify(body.system).includes('Your name is Wren') || JSON.stringify(body.messages).includes('Your name is Wren')
    const hasToolResult = body.messages.some((message) => JSON.stringify(message).includes('toolu_pi_probe') && JSON.stringify(message).includes('tool_result'))
    appendFileSync(${JSON.stringify(report)}, JSON.stringify({ turn, model: body.model, advertised, hasPrompt, hasToolResult, servedByMigratedAccount }) + '\\n')
    if (!servedByMigratedAccount) throw new Error('Request was not authorized by the migrated fixture account')
    if (turn === 1 && (!advertised.includes('Bash') || !hasPrompt)) throw new Error('Host prompt/tools did not reach Anthropic request')
    if (turn === 2 && !hasToolResult) throw new Error('Pi did not execute and return the tool result')
    if (turn > 2) throw new Error('Unexpected third provider turn')
    const start = frame('message_start', { type:'message_start', message:{id:'msg_pi_probe_' + turn, type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}} })
    const block = turn === 1
      ? frame('content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_pi_probe',name:'Bash',input:{}}}) + frame('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({command:${JSON.stringify(toolCommand)}})}})
      : frame('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}) + frame('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'pi-tool-proof'}})
    const data = start + block + frame('content_block_stop',{type:'content_block_stop',index:0})
      + frame('message_delta',{type:'message_delta',delta:{stop_reason:turn === 1?'tool_use':'end_turn'},usage:{output_tokens:3}})
      + frame('message_stop',{type:'message_stop'})
    return new Response(data,{status:200,headers:{'content-type':'text/event-stream','request-id':'req_mock_pi_'+turn}})
  }
}
`
  await writeFile(mockExtension, source)

  // Construct a strict environment rather than inheriting Pi's auth, extensions,
  // home directory or Claustrum connector from the operator's live process.
  // Preparation and the Pi host share this exact environment, so both resolve
  // the same account pool inside the fixture root.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    USERPROFILE: root,
    TMPDIR: temp,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    PI_CODING_AGENT_DIR: agent,
    PI_ANTHROPIC_AUTH_FILE: join(agent, 'anthropic-auth.json'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    ANTHROPIC_API_KEY: 'pi-local-mock-key',
  }
  const preparation = await runIsolatedChild(
    [process.execPath, import.meta.path, PREPARE_FLAG],
    env,
    root,
  )
  const prepared =
    preparation.code === 0 &&
    !preparation.timedOut &&
    preparation.joinFailures.length === 0
  const host = prepared
    ? await runIsolatedChild(
        [
          piCli,
          '-p',
          '--mode',
          'json',
          '--no-session',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-context-files',
          '--no-approve',
          '-e',
          extension,
          '-e',
          mockExtension,
          '--provider',
          'anthropic',
          '--model',
          'claude-opus-5-5',
          '--api-key',
          'pi-local-mock-key',
          '--tools',
          'bash',
          '--system-prompt',
          'Your name is Wren. Always state your name first.',
          'Run the bash tool once with the command provided by the service, then state the result.',
        ],
        env,
        root,
      )
    : undefined

  const lines = (await readFile(report, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          unmocked?: string
          turn: number
          model: string
          advertised: string[]
          hasPrompt: boolean
          hasToolResult: boolean
          servedByMigratedAccount: boolean
        },
    )
  const unmocked = lines.flatMap((line) =>
    line.unmocked === undefined ? [] : [line.unmocked],
  )
  const requests = lines.filter((line) => line.unmocked === undefined)
  const marker = await readFile(proof, 'utf8').catch(() => null)
  const events = (host?.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [
          JSON.parse(line) as {
            type: string
            toolName?: string
            isError?: boolean
            result?: { content?: Array<{ text?: string }> }
          },
        ]
      } catch {
        return []
      }
    })
  const executions = events.filter(
    (event) => event.type === 'tool_execution_end',
  )
  const passed =
    prepared &&
    host !== undefined &&
    !host.timedOut &&
    host.joinFailures.length === 0 &&
    host.code === 0 &&
    unmocked.length === 0 &&
    requests.length === 2 &&
    requests.every((request) => request.servedByMigratedAccount === true) &&
    requests[0]?.model === 'claude-opus-5-5' &&
    requests[0]?.hasPrompt === true &&
    requests[0]?.advertised.includes('Bash') === true &&
    requests[1]?.hasToolResult === true &&
    marker === 'pi-tool-proof' &&
    executions.some(
      (event) => event.toolName === 'bash' && event.isError === false,
    )
  if (passed) {
    // Both children and all of their pipe joins have settled above, so
    // nothing still writes into the directory being removed.
    await rm(root, { recursive: true, force: true })
    console.log(
      'Pi tool round-trip: migrated a synthetic account offline, mapped Bash → bash, executed the tool, and replayed its result',
    )
  } else {
    console.error(
      JSON.stringify(
        {
          error: 'Pi host tool round-trip failed',
          piCli,
          extension,
          preparation: {
            code: preparation.code,
            signal: preparation.signal,
            timedOut: preparation.timedOut,
            joinFailures: preparation.joinFailures,
            stdout: preparation.stdout.slice(-1000),
            stderr: preparation.stderr.slice(-1000),
          },
          host: host && {
            code: host.code,
            signal: host.signal,
            timedOut: host.timedOut,
            joinFailures: host.joinFailures,
            stderr: host.stderr.slice(-1000),
          },
          unmocked,
          requests,
          marker,
          executions: executions.map((event) => ({
            toolName: event.toolName,
            isError: event.isError,
            error: event.isError
              ? event.result?.content?.[0]?.text?.slice(0, 240)
              : undefined,
          })),
          artifacts: root,
        },
        null,
        2,
      ),
    )
    process.exitCode = 1
  }
}

if (process.argv[2] === PREPARE_FLAG) await prepareNativePool()
else await main()
