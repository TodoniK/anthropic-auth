import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBundleGlobals } from './check-bundle-globals'

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-bundle-check-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const body = (name = '__anthropicAuthRpcServers') =>
  `export const registry = ${JSON.stringify(name)};\n/*${'padding'.repeat(200)}*/`

test('a small entry is valid when its imported chunk contains the implementation', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, 'index.js'),
      'export { registry } from "./shared.js"',
    )
    await writeFile(join(root, 'shared.js'), body())
    await expect(
      checkBundleGlobals(join(root, 'index.js')),
    ).resolves.toBeUndefined()
  })
})

test('an unrelated chunk cannot supply the registry positive control', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), body('not-the-registry'))
    await writeFile(join(root, 'unrelated.js'), body())
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'positive-control',
    )
  })
})

test('a stale singleton in an imported chunk is refused', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), 'import "./shared.js"')
    await writeFile(
      join(root, 'shared.js'),
      `${body()}\nexport const stale = "__anthropicAuthRpcServer"`,
    )
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'stale-global',
    )
  })
})

test('a missing imported chunk refuses the artifact', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), 'import "./missing.js"')
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'missing',
    )
  })
})

test('a chunk cycle is checked once without hiding a stale singleton', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), 'import "./shared.js"')
    await writeFile(
      join(root, 'shared.js'),
      `import "./index.js";\n${body()}\nexport const stale = "__anthropicAuthRpcServer"`,
    )
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'stale-global',
    )
  })
})

test('a fresh packed prefix resolves the RPC client alongside server and TUI', async () => {
  await fixture(async (root) => {
    const packageRoot = resolve(import.meta.dir, '..')
    await Bun.$`${process.execPath} pm pack --destination ${root}`
      .cwd(packageRoot)
      .quiet()
    const archives = (await readdir(root)).filter((name) =>
      name.endsWith('.tgz'),
    )
    expect(archives).toHaveLength(1)
    const prefix = join(root, 'prefix')
    const packed = join(
      prefix,
      'node_modules/@cortexkit/opencode-anthropic-auth',
    )
    await mkdir(packed, { recursive: true })
    await Bun.$`tar -xzf ${join(root, archives[0]!)} -C ${packed} --strip-components=1`.quiet()
    const manifest = JSON.parse(
      await readFile(join(packed, 'package.json'), 'utf8'),
    )

    // Resolve from an extracted archive outside the workspace, so a source
    // alias or workspace link cannot conceal a missing packed export.
    const probe = join(prefix, 'resolve.mjs')
    await writeFile(
      probe,
      `for (const subpath of ['rpc', 'server', 'tui']) console.log(import.meta.resolve('@cortexkit/opencode-anthropic-auth/' + subpath));`,
    )
    const result = await Bun.$`${process.execPath} ${probe}`.cwd(prefix).quiet()
    const entries = result
      .text()
      .trim()
      .split('\n')
      .map((entry) => fileURLToPath(entry))
    expect(entries).toEqual([
      join(packed, 'dist/rpc/rpc-client.js'),
      join(packed, 'dist/v2/server.js'),
      join(packed, 'src/tui/entry.mjs'),
    ])
    for (const entry of entries)
      expect((await readFile(entry, 'utf8')).length).toBeGreaterThan(0)
    expect(manifest.exports['./rpc']).toEqual({
      types: './dist/rpc/rpc-client.d.ts',
      import: './dist/rpc/rpc-client.js',
    })
    expect(manifest['oc-plugin']).toEqual(['server', 'tui'])
    expect(await readFile(entries[0]!, 'utf8')).toContain('createRpcClient')
    expect(
      await readFile(join(packed, manifest.exports['./rpc'].types), 'utf8'),
    ).toContain('createRpcClient')
  })
})
