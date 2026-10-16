import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  requireDisjointNativeSetupPaths,
  resolveNativeSetupPaths,
} from './native-paths.ts'
import { getPiAuthPath } from './paths.ts'

async function fixture(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'native-setup-paths-'))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('selected host paths use injected configuration, data and Pi overrides without ambient mutation', async () => {
  await fixture(async (root) => {
    const env = {
      OPENCODE_CONFIG_DIR: join(root, 'opencode'),
      XDG_DATA_HOME: join(root, 'data'),
      PI_AGENT_DIR: join(root, 'pi'),
    }
    const before = process.env.OPENCODE_CONFIG_DIR
    const opencode = await resolveNativeSetupPaths('opencode', env)
    const pi = await resolveNativeSetupPaths('pi', env)
    expect(opencode.legacyConfigPath).toBe(
      join(root, 'opencode', 'anthropic-auth.json'),
    )
    expect(opencode.hostAuthPath).toBe(
      join(root, 'data', 'opencode', 'auth.json'),
    )
    expect(pi.legacyConfigPath).toBe(join(root, 'pi', 'anthropic-auth.json'))
    expect(pi.hostAuthPath).toBe(join(homedir(), '.pi', 'agent', 'auth.json'))
    const sdkPi = await resolveNativeSetupPaths('pi', {
      ...env,
      PI_CODING_AGENT_DIR: join(root, 'sdk-pi'),
    })
    expect(sdkPi.hostAuthPath).toBe(join(root, 'sdk-pi', 'auth.json'))
    expect(opencode.routingSourcePath).not.toBe(opencode.routingDestinationPath)
    expect(process.env.OPENCODE_CONFIG_DIR).toBe(before)
    await expect(
      requireDisjointNativeSetupPaths([opencode, pi]),
    ).resolves.toBeUndefined()
  })
})

test('an explicit routing override remains same-path and shared legacy state refuses cross-host setup', async () => {
  await fixture(async (root) => {
    const route = join(root, 'routing.json')
    const env = {
      OPENCODE_CONFIG_DIR: join(root, 'opencode'),
      XDG_DATA_HOME: join(root, 'data'),
      PI_AGENT_DIR: join(root, 'pi'),
      OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: route,
      OPENCODE_ANTHROPIC_AUTH_STATE_FILE: join(root, 'shared-state.json'),
    }
    const opencode = await resolveNativeSetupPaths('opencode', env)
    const pi = await resolveNativeSetupPaths('pi', env)
    expect(opencode.routingSourcePath).toBe(route)
    expect(opencode.routingDestinationPath).toBe(route)
    await expect(
      requireDisjointNativeSetupPaths([opencode, pi]),
    ).rejects.toThrow('overlap')
  })
})

test('Pi SDK tilde and file-URL auth paths participate in cross-host alias checks', async () => {
  await fixture(async (root) => {
    const sdkDirectory = join(root, 'data', 'opencode')
    for (const configured of [
      '~/data/opencode',
      pathToFileURL(sdkDirectory).href,
    ]) {
      const env = {
        HOME: root,
        OPENCODE_CONFIG_DIR: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        PI_CODING_AGENT_DIR: configured,
        PI_AGENT_DIR: join(root, 'not-the-sdk-slot'),
      }
      const opencode = await resolveNativeSetupPaths('opencode', env)
      const pi = await resolveNativeSetupPaths('pi', env)
      expect(getPiAuthPath(env)).toBe(join(sdkDirectory, 'auth.json'))
      expect(pi.hostAuthPath).toBe(opencode.hostAuthPath)
      await expect(
        requireDisjointNativeSetupPaths([opencode, pi]),
      ).rejects.toThrow('overlap')
    }
  })
})

test('canonical aliases between selected native pool owners refuse even when spelling differs', async () => {
  await fixture(async (root) => {
    const config = join(root, 'config')
    const alias = join(root, 'pi-alias')
    await mkdir(config)
    await symlink(config, alias, 'dir')
    const env = {
      HOME: root,
      OPENCODE_CONFIG_DIR: config,
      XDG_DATA_HOME: join(root, 'data'),
      PI_AGENT_DIR: alias,
    }
    const opencode = await resolveNativeSetupPaths('opencode', env)
    const pi = await resolveNativeSetupPaths('pi', env)
    await expect(
      requireDisjointNativeSetupPaths([opencode, pi]),
    ).rejects.toThrow('overlap')
    await expect(
      requireDisjointNativeSetupPaths([opencode]),
    ).resolves.toBeUndefined()
  })
})
