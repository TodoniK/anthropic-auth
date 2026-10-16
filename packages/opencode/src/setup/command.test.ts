import { expect, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSetupCommand, type SetupCommandOptions } from './command.ts'
import type { HarnessKind } from './types.ts'

/** Run the real shared callbacks with fixture executables and a fixture vault. */
async function run(
  argv: string[],
  input: {
    piLocalAuth?: boolean
    fail?: HarnessKind
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'setup-command-vault-'))
  try {
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      PATH: join(root, 'bin'),
      XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
        root,
        'connection',
      ),
      PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(root, 'connection'),
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'),
      PI_CODING_AGENT_DIR: join(root, '.pi', 'agent'),
    }
    await mkdir(join(root, '.config', 'opencode'), { recursive: true })
    await writeFile(
      join(root, '.config', 'opencode', 'opencode.jsonc'),
      '{\n  "plugin": []\n}\n',
    )
    if (input.piLocalAuth) {
      await mkdir(env.PI_CODING_AGENT_DIR!, { recursive: true })
      await writeFile(
        join(env.PI_CODING_AGENT_DIR!, 'auth.json'),
        JSON.stringify({
          anthropic: {
            type: 'oauth',
            access: 'fixture-access',
            refresh: 'fixture-refresh',
            expires: 1,
          },
        }),
      )
    }
    const activations: Array<{ host: HarnessKind; consent: boolean }> = []
    const options: SetupCommandOptions = {
      env,
      migrateLocal: async () => {},
      fence: { listRunningHosts: async () => [] },
      runner: {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      },
      fs: {
        exists: (path) =>
          path === env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE ||
          existsSync(path),
        isDirectory: (path) => {
          try {
            return statSync(path).isDirectory()
          } catch {
            return false
          }
        },
        isFile: (path) =>
          ['opencode', 'pi', 'ck'].some(
            (name) => path === join(root, 'bin', name),
          ),
        isExecutable: (path) =>
          ['opencode', 'pi', 'ck'].some(
            (name) => path === join(root, 'bin', name),
          ),
        readText: (path) => readFileSync(path, 'utf8'),
        realpath: realpathSync,
      },
      connect: async () => {
        let name = ''
        return {
          close() {},
          enrollPropose: async (input) => {
            name = input.name
            return { requestId: 'fixture-request' }
          },
          enrollPoll: async () => ({
            status: 'approved',
            name,
            token: 'c'.repeat(64),
            tokenGeneration: 1,
          }),
        }
      },
      vaultActivate: async (host, options) => {
        activations.push({ host, consent: options.removePiAnthropicAuth })
        if (host === input.fail) throw new Error('synthetic activation refusal')
        return 'committed'
      },
    }
    const code = await runSetupCommand(argv, options)
    return { code, activations }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('--yes alone never switches custody even when the vault daemon is available', async () => {
  const result = await run(['--yes'])
  expect(result.code).toBe(0)
  expect(result.activations).toEqual([])
})

test('--claustrum activates each selected host on its own and stops at the first failure', async () => {
  expect(await run(['--yes', '--claustrum'])).toEqual({
    code: 0,
    activations: [
      { host: 'opencode', consent: false },
      { host: 'pi', consent: false },
    ],
  })
  expect(await run(['--yes', '--claustrum'], { fail: 'opencode' })).toEqual({
    code: 1,
    activations: [{ host: 'opencode', consent: false }],
  })
})

test('a stored Pi login is removed only with the explicit --remove-pi-auth flag', async () => {
  expect(await run(['--yes', '--claustrum'], { piLocalAuth: true })).toEqual({
    code: 1,
    activations: [],
  })
  expect(
    await run(['--yes', '--claustrum', '--remove-pi-auth'], {
      piLocalAuth: true,
    }),
  ).toEqual({
    code: 0,
    activations: [
      { host: 'opencode', consent: false },
      { host: 'pi', consent: true },
    ],
  })
})
