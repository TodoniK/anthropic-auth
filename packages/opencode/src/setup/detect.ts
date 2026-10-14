import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  connectClaustrumEnrollmentClient,
  resolveClaustrumConnectionPath,
} from '@cortexkit/anthropic-auth-core'
import { defaultCommandRunner } from './command-runner.ts'
import { findHostExecutable, probeHostVersion } from './host-executable.ts'
import { readJsonc } from './jsonc.ts'
import { detectOpenCodeConfigFile } from './opencode-config.ts'
import {
  getHostHome,
  getOpenCodeConfigDir,
  getPiAgentDir,
  OPENCODE_PACKAGE_NAME,
} from './paths.ts'
import { hasPiLocalAnthropicAuth, isPiPackageInstalled } from './pi.ts'
import type {
  ClaustrumDetection,
  CommandRunner,
  HostDetection,
  SetupDetection,
} from './types.ts'

export interface DetectionOptions {
  platform?: NodeJS.Platform
}

function hasOpenCodeDesktop(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  const home = getHostHome(env, platform)
  let markers: string[]
  switch (platform) {
    case 'darwin':
      markers = [
        '/Applications/OpenCode.app',
        '/Applications/OpenCode Beta.app',
        join(home, 'Applications', 'OpenCode.app'),
        join(home, 'Applications', 'OpenCode Beta.app'),
      ]
      break
    case 'win32': {
      const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
      markers = [
        join(localAppData, 'Programs', 'opencode'),
        join(localAppData, 'opencode'),
      ]
      break
    }
    case 'linux':
      markers = [
        '/opt/OpenCode',
        '/usr/lib/opencode',
        join(home, '.local', 'share', 'applications', 'opencode.desktop'),
      ]
      break
    default:
      markers = []
  }
  return markers.some((marker) => existsSync(marker))
}

export async function detectOpenCode(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultCommandRunner,
  options: DetectionOptions = {},
): Promise<HostDetection> {
  const platform = options.platform ?? process.platform
  const configDir = getOpenCodeConfigDir(env, platform)
  const hasInstallation =
    existsSync(configDir) || hasOpenCodeDesktop(env, platform)
  const executable =
    findHostExecutable('opencode', env, platform) ??
    findHostExecutable('opencode2', env, platform)
  const installed = hasInstallation || executable !== null
  const versionRes = await probeHostVersion(executable, env, runner, platform)
  const version =
    versionRes?.exitCode === 0 ? versionRes.stdout.trim() || null : null
  const { path: configPath, exists: configExists } =
    detectOpenCodeConfigFile(configDir)

  let pluginInstalled = false
  if (configExists) {
    const { value } = readJsonc<{ plugin?: string[] }>(configPath)
    if (Array.isArray(value?.plugin)) {
      pluginInstalled = value.plugin.some(
        (p) =>
          typeof p === 'string' &&
          (p === OPENCODE_PACKAGE_NAME ||
            p.startsWith(`${OPENCODE_PACKAGE_NAME}@`)),
      )
    }
  }

  return {
    kind: 'opencode',
    installed,
    version,
    configPath,
    pluginInstalled,
  }
}

export async function detectPi(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultCommandRunner,
  options: DetectionOptions = {},
): Promise<HostDetection> {
  const platform = options.platform ?? process.platform
  const agentDir = getPiAgentDir(env, platform)
  const hasAgentDir = existsSync(agentDir)
  const executable = findHostExecutable('pi', env, platform)
  const installed = hasAgentDir || executable !== null
  const versionRes = await probeHostVersion(executable, env, runner, platform)

  let version: string | null = null
  if (versionRes?.exitCode === 0) {
    const text = versionRes.stdout.trim() || versionRes.stderr.trim()
    const match = text
      .split(/\r?\n/)
      .find((l) => /^\d+\.\d+\.\d+/.test(l.trim()))
    version = match?.trim() || text || null
  }

  const pluginInstalled = isPiPackageInstalled(env, agentDir)
  const hasLocalAuth = await hasPiLocalAnthropicAuth(env)

  return {
    kind: 'pi',
    installed,
    version,
    configPath: agentDir,
    pluginInstalled,
    hasLocalAuth,
  }
}

export async function detectClaustrum(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultCommandRunner,
  options: DetectionOptions = {},
): Promise<ClaustrumDetection> {
  const platform = options.platform ?? process.platform
  const executable = findHostExecutable('ck', env, platform)
  const ckInstalled = executable !== null
  const ckRes = await probeHostVersion(executable, env, runner, platform)
  const ckVersion = ckRes?.exitCode === 0 ? ckRes.stdout.trim() || null : null

  let connectionPath: string | null = null
  let daemonRunning = false

  try {
    connectionPath = resolveClaustrumConnectionPath(undefined, env)
    if (connectionPath && existsSync(connectionPath)) {
      // Prove the daemon is actually running with a real handshake
      const client = await connectClaustrumEnrollmentClient({
        connectionFile: connectionPath,
        handshakeTimeoutMs: 2000,
      })
      daemonRunning = true
      client.close()
    }
  } catch {
    daemonRunning = false
  }

  return {
    ckInstalled,
    ckVersion,
    daemonRunning,
    connectionPath,
  }
}

export async function detectAll(
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultCommandRunner,
  options: DetectionOptions = {},
): Promise<SetupDetection> {
  const [opencode, pi, claustrum] = await Promise.all([
    detectOpenCode(env, runner, options),
    detectPi(env, runner, options),
    detectClaustrum(env, runner, options),
  ])

  return { opencode, pi, claustrum }
}
