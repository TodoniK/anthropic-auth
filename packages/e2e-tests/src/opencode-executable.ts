import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

/** Use the locked platform binary directly; installs intentionally omit postinstall scripts. */
export async function resolveOpencodeTestExecutable(): Promise<string> {
  const root = JSON.parse(
    await readFile(resolve(import.meta.dir, '../../../package.json'), 'utf8'),
  )
  const version: unknown = root.devDependencies?.['opencode-ai']
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(
      'E2E OpenCode requires an exact repository dependency version',
    )
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  // Baseline builds also run on x64 hosts without AVX2.
  const packageName = `opencode-${platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}`
  const sdkRequire = createRequire(require.resolve('opencode-ai/package.json'))
  const manifestPath = sdkRequire.resolve(`${packageName}/package.json`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== version)
    throw new Error(
      'E2E OpenCode platform binary differs from the repository version',
    )
  return join(
    dirname(manifestPath),
    'bin',
    process.platform === 'win32' ? 'opencode.exe' : 'opencode',
  )
}
