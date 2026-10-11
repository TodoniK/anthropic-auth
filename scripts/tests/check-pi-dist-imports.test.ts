import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  findHostImportViolations,
  verifyPiDistRuntimeImports,
  verifyStandaloneCliRuntimeImports,
} from '../check-pi-dist-imports.ts'

const AGENT_DIR = `import { getAgentDir } from '@earendil-works/pi-coding-agent'`

async function withModules(
  modules: Record<string, string>,
  check: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'runtime-import-guard-'))
  try {
    for (const [name, source] of Object.entries(modules)) {
      const file = join(root, name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, source)
    }
    await check(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('entry-point host SDK import boundaries', () => {
  test('allows only named getAgentDir from the Pi coding-agent SDK', () => {
    for (const source of [
      AGENT_DIR,
      `import { getAgentDir as dir } from '@earendil-works/pi-coding-agent'`,
      `import { 'getAgentDir' as dir } from '@earendil-works/pi-coding-agent'`,
      `export { getAgentDir as dir } from '@earendil-works/pi-coding-agent'`,
    ]) {
      expect(findHostImportViolations(source, 'commands.js')).toEqual([])
    }
  })

  test('does not allow unknown SDK names or missing transcript helpers', () => {
    for (const source of [
      `import { getAgentDir, unknown } from '@earendil-works/pi-coding-agent'`,
      `${AGENT_DIR}; import { unknown } from '@earendil-works/pi-coding-agent'`,
      `export { 'unknown' as helper } from '@earendil-works/pi-coding-agent'`,
      `import { getAgentDir } from '@earendil-works/pi-ai'`,
      `import { collapseSystemMessages } from '@earendil-works/pi-ai'`,
      `import { normalizeContext } from '@earendil-works/pi-ai'`,
    ]) {
      expect(
        findHostImportViolations(source, 'commands.js').length,
      ).toBeGreaterThan(0)
    }
  })

  test('does not allow opaque or side-effect coding-agent SDK imports in Pi', () => {
    for (const source of [
      `import sdk from '@earendil-works/pi-coding-agent'`,
      `import sdk, { getAgentDir } from '@earendil-works/pi-coding-agent'`,
      `import * as sdk from '@earendil-works/pi-coding-agent'`,
      `import '@earendil-works/pi-coding-agent'`,
      `export * from '@earendil-works/pi-coding-agent'`,
      `export * as sdk from '@earendil-works/pi-coding-agent'`,
      `async function load() { return import('@earendil-works/pi-coding-agent') }`,
      'async function load() { return import(`@earendil-works/pi-coding-agent`) }',
      `async function load(name) { return import(name) }`,
    ]) {
      expect(
        findHostImportViolations(source, 'commands.js').length,
      ).toBeGreaterThan(0)
    }
  })

  test('keeps the full Pi dist scan while allowing getAgentDir in commands', async () => {
    await withModules({ 'commands.js': AGENT_DIR }, async (root) => {
      await expect(verifyPiDistRuntimeImports(root)).resolves.toContain(
        '1 files',
      )
      await mkdir(join(root, 'nested'))
      await writeFile(
        join(root, 'nested', 'unsupported.js'),
        `import { collapseSystemMessages } from '@earendil-works/pi-ai'`,
      )
      await expect(verifyPiDistRuntimeImports(root)).rejects.toThrow(
        'collapseSystemMessages',
      )
    })
  })

  test('rejects getAgentDir directly in the standalone CLI entry point', async () => {
    await withModules({ 'cli.js': AGENT_DIR }, async (root) => {
      await expect(
        verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
      ).rejects.toThrow(
        "cli.js: standalone CLI must not import host Pi SDK '@earendil-works/pi-coding-agent'",
      )
    })
  })

  test('rejects otherwise-allowed Pi exports under every host scope in the CLI', async () => {
    for (const scope of ['earendil-works', 'oh-my-pi', 'mariozechner']) {
      for (const source of [
        `import { getAgentDir } from '@${scope}/pi-coding-agent'`,
        `import { calculateCost, createAssistantMessageEventStream } from '@${scope}/pi-ai'`,
        `export { getAgentDir } from '@${scope}/pi-coding-agent'`,
        `import * as sdk from '@${scope}/pi-coding-agent'`,
        `import sdk from '@${scope}/pi-coding-agent'`,
        `import '@${scope}/pi-coding-agent'`,
        `export * from '@${scope}/pi-coding-agent'`,
        `async function load() { return import('@${scope}/pi-coding-agent') }`,
        `import { unknown } from '@${scope}/pi-tui'`,
      ]) {
        await withModules({ 'cli.js': source }, async (root) => {
          await expect(
            verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
          ).rejects.toThrow('standalone CLI must not import host Pi SDK')
        })
      }
    }
  })

  test('rejects getAgentDir transitively through relative imports and re-exports', async () => {
    for (const bridge of [
      `import './nested/host.js'`,
      `export { getAgentDir } from './nested/host.js'`,
      `export * from './nested/host.js'`,
    ]) {
      await withModules(
        {
          'cli.js': `import './bridge.js'`,
          'bridge.js': bridge,
          'nested/host.js': AGENT_DIR,
        },
        async (root) => {
          await expect(
            verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
          ).rejects.toThrow(
            "nested/host.js: standalone CLI must not import host Pi SDK '@earendil-works/pi-coding-agent'",
          )
        },
      )
    }
  })

  test('rejects getAgentDir in a constant dynamic chunk reached from a nested module', async () => {
    await withModules(
      {
        'cli.js': `export * from './nested/bridge.js'`,
        'nested/bridge.js': `export async function load() { return import('../host.js') }`,
        'host.js': AGENT_DIR,
      },
      async (root) => {
        await expect(
          verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
        ).rejects.toThrow(
          "host.js: standalone CLI must not import host Pi SDK '@earendil-works/pi-coding-agent'",
        )
      },
    )
  })

  test('rejects unverifiable dynamic CLI edges instead of silently skipping them', async () => {
    await withModules(
      { 'cli.js': `export async function load(name) { return import(name) }` },
      async (root) => {
        await expect(
          verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
        ).rejects.toThrow('runtime dynamic import cannot be verified')
      },
    )
  })

  test('ignores unrelated emitted plugin modules and handles shared cyclic chunks', async () => {
    await withModules(
      {
        'cli.js': `import './nested/bridge.js'; export * from './shared.js'`,
        'nested/bridge.js': `export * from '../shared.js'`,
        'shared.js': `import './nested/bridge.js'; import { readFile } from 'node:fs/promises'`,
        'plugin.js': AGENT_DIR,
      },
      async (root) => {
        await expect(
          verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
        ).resolves.toContain('3 reachable files')
      },
    )
  })

  test('fails closed for missing CLI entry points or reachable chunks', async () => {
    await withModules({}, async (root) => {
      await expect(
        verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
      ).rejects.toThrow('Missing standalone CLI module')
      await writeFile(join(root, 'cli.js'), `import './missing.js'`)
      await expect(
        verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
      ).rejects.toThrow('missing.js')
    })
  })
})
