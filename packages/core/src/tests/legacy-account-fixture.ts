import { readFile, writeFile } from 'node:fs/promises'

/** Write already-shaped 1.x JSON; fixture callers own the data and paths. */
export async function writeLegacyAccountFiles(
  configPath: string,
  config: unknown,
  statePath?: string,
  state?: unknown,
): Promise<void> {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  })
  if (statePath !== undefined)
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    })
}

/** Read one fixture file verbatim as JSON, without combining or interpreting it. */
export async function readLegacyJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
