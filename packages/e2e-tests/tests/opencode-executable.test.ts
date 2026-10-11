import { expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTestLifetimeSuite } from '../../core/src/tests/test-lifetime'
import type { resolveOpencodeTestExecutable } from '../src/opencode-executable'

const lifetime = createTestLifetimeSuite()

async function capturedResolver(required: string, installed: string) {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-host-binary-'))
  lifetime.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const sourceDir = join(root, 'packages/e2e-tests/src')
  const sdkDir = join(root, 'node_modules/opencode-ai')
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const name = `opencode-${platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}`
  const nativeDir = join(root, 'node_modules', name)
  for (const path of [sourceDir, sdkDir, join(nativeDir, 'bin')])
    await mkdir(path, { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      devDependencies: { 'opencode-ai': required },
    }),
  )
  await writeFile(
    join(sdkDir, 'package.json'),
    JSON.stringify({ name: 'opencode-ai', version: installed }),
  )
  await writeFile(
    join(nativeDir, 'package.json'),
    JSON.stringify({ name, version: installed }),
  )
  const executable = join(
    nativeDir,
    'bin',
    process.platform === 'win32' ? 'opencode.exe' : 'opencode',
  )
  await writeFile(executable, 'synthetic binary; never executed')
  // Copy the current resolver so these fixtures exercise its actual version guards.
  const copy = join(sourceDir, 'opencode-executable.ts')
  await writeFile(
    copy,
    await readFile(
      join(import.meta.dir, '../src/opencode-executable.ts'),
      'utf8',
    ),
  )
  const module: {
    resolveOpencodeTestExecutable: typeof resolveOpencodeTestExecutable
  } = await import(pathToFileURL(copy).href)
  return { resolve: module.resolveOpencodeTestExecutable, executable }
}

lifetime.test(
  'test host resolves its locked platform binary without a postinstall wrapper',
  async () => {
    const fixture = await capturedResolver('1.18.18', '1.18.18')
    expect(await fixture.resolve()).toBe(fixture.executable)
    expect(await readFile(fixture.executable, 'utf8')).toBe(
      'synthetic binary; never executed',
    )
  },
)

lifetime.test(
  'test host refuses a different platform binary version',
  async () => {
    const fixture = await capturedResolver('1.18.18', '1.18.17')
    await expect(fixture.resolve()).rejects.toThrow(
      'platform binary differs from the repository version',
    )
  },
)

lifetime.test(
  'test host requires an exact repository dependency pin',
  async () => {
    const fixture = await capturedResolver('^1.18.18', '1.18.18')
    await expect(fixture.resolve()).rejects.toThrow(
      'exact repository dependency version',
    )
  },
)
