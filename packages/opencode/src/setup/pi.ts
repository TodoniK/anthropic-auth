import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultCommandRunner } from './command-runner.ts'
import {
  getPiAgentDir,
  getPiAuthPath,
  PI_PACKAGE_NAME,
  piPluginEntry,
} from './paths.ts'
import type { CommandRunner } from './types.ts'

export function isPiPackageInstalled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const settingsPath = join(getPiAgentDir(env), 'settings.json')
  if (!existsSync(settingsPath)) return false
  try {
    const content = JSON.parse(readFileSyncUtf8(settingsPath))
    const packages = content?.packages
    if (!Array.isArray(packages)) return false
    return packages.some((p: unknown) => {
      const source =
        typeof p === 'string'
          ? p
          : typeof p === 'object' && p !== null
            ? (p as { source?: unknown }).source
            : ''
      if (typeof source !== 'string') return false
      return (
        source === PI_PACKAGE_NAME ||
        source.startsWith(`${PI_PACKAGE_NAME}@`) ||
        source === `npm:${PI_PACKAGE_NAME}` ||
        source.startsWith(`npm:${PI_PACKAGE_NAME}@`)
      )
    })
  } catch {
    return false
  }
}

function readFileSyncUtf8(path: string): string {
  const fs = require('node:fs')
  return fs.readFileSync(path, 'utf8')
}

export async function hasPiLocalAnthropicAuth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const authPath = getPiAuthPath(env)
  if (!existsSync(authPath)) return false
  try {
    const raw = await readFile(authPath, 'utf8')
    const parsed = JSON.parse(raw)
    return Boolean(parsed?.anthropic && typeof parsed.anthropic === 'object')
  } catch {
    return false
  }
}

export async function cleanPiLocalAnthropicAuth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const authPath = getPiAuthPath(env)
  if (!existsSync(authPath)) return false
  try {
    const raw = await readFile(authPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.anthropic) {
      delete parsed.anthropic
      await writeFile(authPath, `${JSON.stringify(parsed, null, 2)}\n`, {
        mode: 0o600,
      })
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * A failed install carries the child's raw exit code and stderr for the
 * diagnostic log only; stderr can echo credentials from the environment, so it
 * is never meant for the screen.
 */
export type PiInstallResult =
  | { ok: true; message: string }
  | { ok: false; exitCode: number; stderr: string }

export async function installPiExtension(
  version: string,
  runner: CommandRunner = defaultCommandRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiInstallResult> {
  const entry = piPluginEntry(version)
  const result = await runner.run('pi', ['install', entry], { env })
  if (result.exitCode !== 0)
    return { ok: false, exitCode: result.exitCode, stderr: result.stderr }
  return { ok: true, message: `Installed ${entry}` }
}
