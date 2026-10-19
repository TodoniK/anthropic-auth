import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex')

export async function snapshot(root) {
  const files = {}
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        files[`${relative(root, path).replaceAll('\\', '/')}/`] = 'directory'
        await walk(path)
      } else
        files[relative(root, path).replaceAll('\\', '/')] = sha256(
          await readFile(path),
        )
    }
  }
  await walk(root)
  return files
}

export function isolatedEnvironment(root, inherited = process.env) {
  const env = { ...inherited }
  for (const key of Object.keys(env)) {
    if (/^(OPENCODE|PI_|CLAUSTRUM|XDG_|ANTHROPIC|CLAUDE|CORTEXKIT)/i.test(key))
      delete env[key]
  }
  return {
    ...env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
    TEMP: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_STATE_HOME: join(root, '.local', 'state'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    XDG_CACHE_HOME: join(root, '.cache'),
    OPENCODE_CONFIG_DIR: join(root, '.config', 'opencode'),
    PI_CODING_AGENT_DIR: join(root, '.pi', 'agent'),
  }
}

/** A failed proof still produces a receipt; no failed or skipped step qualifies Windows. */
export async function withReceipt(path, result, run, cleanup = async () => {}) {
  result.steps = []
  const step = async (name, action) => {
    try {
      const evidence = await action()
      result.steps.push({ name, status: 'passed', evidence })
      return evidence
    } catch (error) {
      result.steps.push({
        name,
        status: 'failed',
        error: String(error).replaceAll(result.profile ?? '\0', '<profile>'),
      })
      return undefined
    }
  }
  try {
    await run(step)
  } catch (error) {
    await step('verification', () => {
      throw error
    })
  } finally {
    await step('cleanup', cleanup)
    result.nativeWindowsQualified =
      result.platform === 'win32' &&
      result.steps.every((s) => s.status === 'passed')
    result.status = result.steps.every((s) => s.status === 'passed')
      ? 'passed'
      : 'failed'
    delete result.profile
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
  }
  return result.status === 'passed'
}
