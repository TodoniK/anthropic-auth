import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  detectAll,
  detectClaustrum,
  detectOpenCode,
  detectPi,
} from '../setup/detect.ts'
import type { CommandRunner } from '../setup/types.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'setup-host-detection-'))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin with spaces & symbols')
  mkdirSync(home)
  mkdirSync(bin)
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    PATH: bin,
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      root,
      'absent.json',
    ),
  }
  return { root, home, bin, env }
}

function file(path: string, executable = false) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'fake launcher')
  if (executable) chmodSync(path, 0o755)
  return path
}

function runner(expectedCommand?: string, exitCode = 0) {
  const calls: Array<{
    command: string
    args: string[]
    env: NodeJS.ProcessEnv | undefined
  }> = []
  const mock: CommandRunner = {
    async run(command, args, options) {
      calls.push({ command, args, env: options?.env })
      return {
        exitCode: command === expectedCommand ? exitCode : 1,
        stdout:
          command === expectedCommand && exitCode === 0 ? '1.18.35\n' : '',
        stderr: '',
      }
    },
  }
  return { mock, calls }
}

const win32 = { platform: 'win32' as const }

describe('setup host detection without shell PATH lookup', () => {
  test('detects opencode.cmd on Windows PATH and passes a fixed cmd.exe argument array', async () => {
    const { bin, env } = fixture()
    const launcher = file(join(bin, 'opencode.cmd'))
    env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    const { mock, calls } = runner(env.ComSpec)

    const detection = await detectOpenCode(env, mock, win32)

    expect(detection.installed).toBe(true)
    expect(detection.version).toBe('1.18.35')
    expect(calls).toEqual([
      {
        command: env.ComSpec,
        args: ['/d', '/s', '/c', launcher, '--version'],
        env,
      },
    ])
  })

  test('detects opencode.exe on Windows PATH and probes it directly', async () => {
    const { bin, env } = fixture()
    const launcher = file(join(bin, 'opencode.exe'))
    const { mock, calls } = runner(launcher)

    const detection = await detectOpenCode(env, mock, win32)

    expect(detection.installed).toBe(true)
    expect(detection.version).toBe('1.18.35')
    expect(calls).toEqual([{ command: launcher, args: ['--version'], env }])
  })

  test('a failed .cmd version probe leaves OpenCode detected with an unknown version', async () => {
    const { bin, env } = fixture()
    const launcher = file(join(bin, 'opencode.cmd'))
    const { mock, calls } = runner('cmd.exe', 1)

    const detection = await detectOpenCode(env, mock, win32)

    expect(detection.installed).toBe(true)
    expect(detection.version).toBeNull()
    expect(calls).toEqual([
      {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', launcher, '--version'],
        env,
      },
    ])
  })

  test('a directory named opencode.exe on Windows PATH is not a launcher', async () => {
    const { bin, env } = fixture()
    mkdirSync(join(bin, 'opencode.exe'))
    const { mock, calls } = runner()

    expect((await detectOpenCode(env, mock, win32)).installed).toBe(false)
    expect(calls).toEqual([])
  })

  test('nothing present remains not found even if a runner would report success', async () => {
    const { env } = fixture()
    const { mock, calls } = runner('opencode')

    const detection = await detectAll(env, mock, win32)

    expect(detection.opencode.installed).toBe(false)
    expect(detection.pi.installed).toBe(false)
    expect(detection.claustrum.ckInstalled).toBe(false)
    expect(calls).toEqual([])
  })

  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    test(`detects an empty OpenCode config directory on ${platform}`, async () => {
      const { home, env } = fixture()
      const configDir = join(home, '.config', 'opencode')
      mkdirSync(configDir, { recursive: true })
      const { mock, calls } = runner()

      const detection = await detectOpenCode(env, mock, { platform })

      expect(detection.installed).toBe(true)
      expect(detection.configPath).toBe(join(configDir, 'opencode.jsonc'))
      expect(detection.pluginInstalled).toBe(false)
      expect(detection.version).toBeNull()
      expect(calls).toEqual([])
    })
  }

  test('uses USERPROFILE ahead of HOME for Windows config and Pi agent directories', async () => {
    const { home, env } = fixture()
    env.HOME = join(home, 'other-home')
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
    const { mock } = runner()

    const detection = await detectAll(env, mock, win32)

    expect(detection.opencode.installed).toBe(true)
    expect(detection.pi.installed).toBe(true)
    expect(detection.pi.configPath).toBe(join(home, '.pi', 'agent'))
  })

  test('trims and resolves explicit OpenCode and Pi directory overrides', async () => {
    const { root, env } = fixture()
    const configDir = join(root, 'config-override')
    const agentDir = join(root, 'pi-override')
    mkdirSync(configDir)
    mkdirSync(agentDir)
    env.OPENCODE_CONFIG_DIR = `  ${configDir}/../config-override  `
    env.PI_CODING_AGENT_DIR = `  ${agentDir}/../pi-override  `
    env.PI_AGENT_DIR = join(root, 'ignored-pi-agent')
    const { mock } = runner()

    const detection = await detectAll(env, mock, win32)

    expect(detection.opencode.installed).toBe(true)
    expect(detection.opencode.configPath).toBe(
      join(resolve(configDir), 'opencode.jsonc'),
    )
    expect(detection.pi.installed).toBe(true)
    expect(detection.pi.configPath).toBe(resolve(agentDir))
  })

  test('honors XDG_CONFIG_HOME and ignores whitespace-only directory overrides', async () => {
    const { root, home, env } = fixture()
    env.XDG_CONFIG_HOME = join(root, 'xdg-config')
    env.OPENCODE_CONFIG_DIR = '  '
    env.PI_CODING_AGENT_DIR = '  '
    mkdirSync(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
    const { mock } = runner()

    const detection = await detectAll(env, mock, win32)

    expect(detection.opencode.installed).toBe(true)
    expect(detection.opencode.configPath).toBe(
      join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'),
    )
    expect(detection.pi.installed).toBe(true)
  })
})

describe('OpenCode Desktop installation markers', () => {
  for (const app of ['OpenCode.app', 'OpenCode Beta.app']) {
    test(`detects macOS user Applications/${app} without a CLI or config`, async () => {
      const { home, env } = fixture()
      mkdirSync(join(home, 'Applications', app), { recursive: true })
      const { mock, calls } = runner()

      const detection = await detectOpenCode(env, mock, { platform: 'darwin' })

      expect(detection.installed).toBe(true)
      expect(detection.version).toBeNull()
      expect(calls).toEqual([])
    })
  }

  for (const marker of ['Programs/opencode', 'opencode']) {
    test(`detects Windows LOCALAPPDATA/${marker} without a CLI or config`, async () => {
      const { env } = fixture()
      mkdirSync(join(env.LOCALAPPDATA!, marker), { recursive: true })
      const { mock, calls } = runner()

      const detection = await detectOpenCode(env, mock, win32)

      expect(detection.installed).toBe(true)
      expect(detection.version).toBeNull()
      expect(calls).toEqual([])
    })
  }

  test('Windows Desktop falls back to USERPROFILE/AppData/Local without LOCALAPPDATA', async () => {
    const { home, env } = fixture()
    delete env.LOCALAPPDATA
    mkdirSync(join(home, 'AppData', 'Local', 'Programs', 'opencode'), {
      recursive: true,
    })
    const { mock } = runner()

    expect((await detectOpenCode(env, mock, win32)).installed).toBe(true)
  })

  test('detects the Linux user opencode.desktop marker without a CLI or config', async () => {
    const { home, env } = fixture()
    file(join(home, '.local', 'share', 'applications', 'opencode.desktop'))
    const { mock, calls } = runner()

    const detection = await detectOpenCode(env, mock, { platform: 'linux' })

    expect(detection.installed).toBe(true)
    expect(detection.version).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('shared OpenCode, Pi and ck PATH lookup', () => {
  for (const name of ['opencode', 'pi', 'ck'] as const) {
    const detect =
      name === 'opencode'
        ? detectOpenCode
        : name === 'pi'
          ? detectPi
          : detectClaustrum
    for (const extension of ['', '.exe', '.cmd', '.bat']) {
      test(`detects Windows ${name}${extension} using the resolved launcher`, async () => {
        const { bin, env } = fixture()
        const launcher = file(join(bin, `${name}${extension}`))
        env.COMSPEC = 'custom-cmd.exe'
        const batch = extension === '.cmd' || extension === '.bat'
        const { mock, calls } = runner(batch ? env.COMSPEC : launcher)

        const detection = await detect(env, mock, win32)

        expect(
          'installed' in detection
            ? detection.installed
            : detection.ckInstalled,
        ).toBe(true)
        expect(
          'version' in detection ? detection.version : detection.ckVersion,
        ).toBe('1.18.35')
        expect(calls).toEqual([
          {
            command: batch ? env.COMSPEC : launcher,
            args: batch
              ? ['/d', '/s', '/c', launcher, '--version']
              : ['--version'],
            env,
          },
        ])
      })
    }

    test(`${name} respects Windows PATH directory order before extension order and skips empty entries`, async () => {
      const { root, bin, env } = fixture()
      const second = join(root, 'second')
      const launcher = file(join(bin, `${name}.bat`))
      file(join(second, `${name}.exe`))
      env.PATH = `;${bin};;${second};`
      const { mock, calls } = runner('cmd.exe')

      await detect(env, mock, win32)

      expect(calls).toEqual([
        {
          command: 'cmd.exe',
          args: ['/d', '/s', '/c', launcher, '--version'],
          env,
        },
      ])
    })

    test(`${name} prefers exe then cmd then bat then bare name in one Windows PATH directory`, async () => {
      const { bin, env } = fixture()
      for (const extension of ['', '.exe', '.cmd', '.bat'])
        file(join(bin, `${name}${extension}`))
      for (const extension of ['.exe', '.cmd', '.bat', '']) {
        const launcher = join(bin, `${name}${extension}`)
        const batch = extension === '.cmd' || extension === '.bat'
        const { mock, calls } = runner(batch ? 'cmd.exe' : launcher)

        await detect(env, mock, win32)

        expect(calls[0]?.command).toBe(batch ? 'cmd.exe' : launcher)
        expect(calls[0]?.args).toEqual(
          batch ? ['/d', '/s', '/c', launcher, '--version'] : ['--version'],
        )
        rmSync(launcher)
      }
    })

    for (const platform of ['darwin', 'linux'] as const) {
      test(`${name} requires an executable regular file on ${platform} PATH`, async () => {
        const { root, bin, env } = fixture()
        file(join(bin, name))
        const directoryBin = join(root, 'directory-bin')
        mkdirSync(join(directoryBin, name), { recursive: true })
        const executableBin = join(root, 'executable-bin')
        const launcher = file(join(executableBin, name), true)
        env.PATH = `:${bin}:${directoryBin}::${executableBin}:`
        const { mock, calls } = runner(launcher)

        const detection = await detect(env, mock, { platform })

        expect(
          'installed' in detection
            ? detection.installed
            : detection.ckInstalled,
        ).toBe(true)
        expect(calls).toEqual([{ command: launcher, args: ['--version'], env }])
      })
    }
  }

  test('detects opencode2 as an alternative CLI name', async () => {
    const { bin, env } = fixture()
    const launcher = file(join(bin, 'opencode2.exe'))
    const { mock, calls } = runner(launcher)

    expect((await detectOpenCode(env, mock, win32)).installed).toBe(true)
    expect(calls).toEqual([{ command: launcher, args: ['--version'], env }])
  })

  for (const name of ['pi', 'ck'] as const) {
    test(`a failed ${name}.cmd probe does not erase installation detection`, async () => {
      const { bin, env } = fixture()
      file(join(bin, `${name}.cmd`))
      const { mock } = runner('cmd.exe', 1)
      const detection = await (name === 'pi' ? detectPi : detectClaustrum)(
        env,
        mock,
        win32,
      )

      expect(
        'installed' in detection ? detection.installed : detection.ckInstalled,
      ).toBe(true)
      expect(
        'version' in detection ? detection.version : detection.ckVersion,
      ).toBeNull()
    })
  }
})

describe('Windows launcher and Pi directory compatibility', () => {
  test('prefers the npm opencode.cmd launcher over its extensionless shell script', async () => {
    const { bin, env } = fixture()
    file(join(bin, 'opencode'))
    const launcher = file(join(bin, 'opencode.cmd'))
    const { mock, calls } = runner('cmd.exe')

    const detection = await detectOpenCode(env, mock, win32)

    expect(detection.installed).toBe(true)
    expect(detection.version).toBe('1.18.35')
    expect(calls).toEqual([
      {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', launcher, '--version'],
        env,
      },
    ])
  })

  test('detects Pi and its installed extension through the PI_AGENT_DIR fallback', async () => {
    const { root, env } = fixture()
    const agentDir = join(root, 'legacy-pi-agent')
    env.PI_CODING_AGENT_DIR = '  '
    env.PI_AGENT_DIR = `  ${agentDir}/../legacy-pi-agent  `
    mkdirSync(agentDir)
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ packages: ['npm:@cortexkit/pi-anthropic-auth'] }),
    )
    const { mock, calls } = runner()

    const detection = await detectPi(env, mock, win32)

    expect(detection.installed).toBe(true)
    expect(detection.configPath).toBe(resolve(agentDir))
    expect(detection.pluginInstalled).toBe(true)
    expect(detection.version).toBeNull()
    expect(calls).toEqual([])
  })
})
