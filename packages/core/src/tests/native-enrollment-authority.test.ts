import { expect } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disconnectClaustrumEnrollment } from '@cortexkit/common-auth/claustrum'

import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import { readNativeEnrollmentMode } from '../native-enrollment-authority.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const lifetime = createTestLifetimeSuite()
const test = lifetime.test

async function fixture(host: 'opencode' | 'pi') {
  const root = await mkdtemp(join(tmpdir(), 'native-enrollment-authority-'))
  lifetime.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const env = {
    [`${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`]: join(
      root,
      `${host}-enrollment.json`,
    ),
  }
  const enrollment = getHostClaustrumEnrollmentPaths(host, env)
  const local = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  const files = [
    local.legacyConfig,
    local.legacyState,
    local.config,
    local.state,
    local.runtime,
    local.journal,
    local.roster,
  ]
  for (const file of files)
    await writeFile(file, JSON.stringify({ file }), { mode: 0o600 })
  const bytes = () => Promise.all(files.map((file) => readFile(file)))
  const before = await bytes()
  return { root, env, enrollment, local, before, bytes }
}

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} without enrollment stays local and does not read or write account authority`, async () => {
    const f = await fixture(host)
    expect(await readNativeEnrollmentMode(host, f.env)).toBe('local')
    expect(await f.bytes()).toEqual(f.before)
  })

  test(`${host} recovers a durable token before ceremony state without changing any local file`, async () => {
    const f = await fixture(host)
    await writeFile(
      f.enrollment.tokenPath,
      JSON.stringify({ token: 'd'.repeat(64), token_generation: 1 }),
      { mode: 0o600 },
    )
    expect(await readNativeEnrollmentMode(host, f.env)).toBe('claustrum')
    expect(await f.bytes()).toEqual(f.before)
    expect(
      await disconnectClaustrumEnrollment(
        f.enrollment,
        `anthropic-auth-${host}`,
      ),
    ).toBe('disconnected')
    expect(await readNativeEnrollmentMode(host, f.env)).toBe('local')
    expect(await f.bytes()).toEqual(f.before)
  })

  test(`${host} approved enrollment missing its token keeps vault authority instead of selecting local`, async () => {
    const f = await fixture(host)
    await writeFile(
      f.enrollment.statePath,
      JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: `anthropic-auth-${host}`,
        tokenGeneration: 1,
        updatedAt: 1,
      }),
      { mode: 0o600 },
    )
    expect(await readNativeEnrollmentMode(host, f.env)).toBe('claustrum')
    expect(await f.bytes()).toEqual(f.before)
  })

  test(`${host} malformed token refuses with a fixed error and leaves local files untouched`, async () => {
    const f = await fixture(host)
    await writeFile(f.enrollment.tokenPath, 'synthetic-secret-not-json', {
      mode: 0o600,
    })
    await expect(readNativeEnrollmentMode(host, f.env)).rejects.toMatchObject({
      code: 'invalid-token',
      message: 'Native custody refused: invalid-token',
    })
    expect(await f.bytes()).toEqual(f.before)
  })
}

test('one host enrollment cannot activate the other host', async () => {
  const f = await fixture('opencode')
  await writeFile(
    f.enrollment.tokenPath,
    JSON.stringify({ token: 'd'.repeat(64), token_generation: 1 }),
    { mode: 0o600 },
  )
  const env = {
    ...f.env,
    PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      f.root,
      'pi-enrollment.json',
    ),
  }
  expect(await readNativeEnrollmentMode('opencode', env)).toBe('claustrum')
  expect(await readNativeEnrollmentMode('pi', env)).toBe('local')
  expect(await f.bytes()).toEqual(f.before)
})

test('vault file identity is stable and disjoint from every local recovery file', async () => {
  const f = await fixture('opencode')
  const vault = nativeVaultPaths(f.local)
  expect(nativeVaultPaths(f.local)).toEqual(vault)
  expect(vault.storageId).not.toBe(f.local.storageId)
  expect(vault.config).toBe(join(f.root, 'anthropic-auth-vault-settings.json'))
  expect(vault.runtime).toBe(join(f.root, 'anthropic-auth-vault-state.json'))
  expect(vault.routing).toBe(
    join(f.root, 'anthropic-auth-vault-routing-state.json'),
  )
  const local = [
    f.local.legacyConfig,
    f.local.legacyState,
    f.local.config,
    f.local.state,
    f.local.runtime,
    f.local.journal,
    f.local.roster,
  ]
  for (const file of [
    vault.config,
    vault.state,
    vault.runtime,
    vault.roster,
    vault.routing,
  ])
    expect(local).not.toContain(file)
  expect(vault).not.toHaveProperty('journal')
  expect(await f.bytes()).toEqual(f.before)
})
