import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, extname, resolve } from 'node:path'
import type { CommandRunner, CommandRunnerResult } from './types.ts'

export function findHostExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const windows = platform === 'win32'
  // npm also installs an extensionless shell script; prefer launchers Windows can execute.
  const names = windows
    ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
    : [name]
  for (const directory of (env.PATH ?? '').split(windows ? ';' : delimiter)) {
    if (!directory) continue
    for (const filename of names) {
      const candidate = resolve(directory, filename)
      try {
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK)
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // A missing or inaccessible candidate does not hide later PATH entries.
      }
    }
  }
  return null
}

export async function probeHostVersion(
  executable: string | null,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
  platform: NodeJS.Platform,
): Promise<CommandRunnerResult | null> {
  if (!executable) return null
  const extension = extname(executable).toLowerCase()
  const batch =
    platform === 'win32' && (extension === '.cmd' || extension === '.bat')
  try {
    // Windows batch launchers need cmd.exe; keep the path and fixed flag as separate arguments.
    return await runner.run(
      batch ? env.ComSpec || env.COMSPEC || 'cmd.exe' : executable,
      batch ? ['/d', '/s', '/c', executable, '--version'] : ['--version'],
      { env },
    )
  } catch {
    // Installation is a filesystem fact even when its version probe cannot run.
    return null
  }
}
