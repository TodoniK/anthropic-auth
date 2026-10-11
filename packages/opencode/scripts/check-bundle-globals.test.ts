import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
