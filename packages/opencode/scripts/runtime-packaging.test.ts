import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)
test('OpenCode externalizes Core and resource-owning runtime packages with direct dependencies', async () => {
  const core = await Bun.file(new URL('core/package.json', root)).json()
  const opencode = await Bun.file(new URL('opencode/package.json', root)).json()
  for (const name of [
    '@cortexkit/anthropic-auth-core',
    ...Object.keys(core.dependencies),
  ]) {
    expect(opencode.scripts.build).toContain(`--external ${name}`)
    expect(opencode.dependencies[name]).toBeDefined()
    if (name !== '@cortexkit/anthropic-auth-core') {
      // OpenCode's own copy and Core's must resolve to one installed package,
      // or setup's instanceof checks see two different error classes.
      expect(opencode.dependencies[name]).toBe(core.dependencies[name])
    }
  }
  const pi = JSON.parse(
    await readFile(new URL('pi/package.json', root), 'utf8'),
  )
  expect(pi.scripts.build).toBe('rm -rf dist && tsc -p tsconfig.build.json')
  expect(pi.dependencies['@cortexkit/anthropic-auth-core']).toBe(core.version)
})
