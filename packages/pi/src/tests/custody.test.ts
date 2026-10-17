import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  type AccountStorage,
  getClaustrumMode,
  getHostClaustrumEnrollmentPaths,
} from '@cortexkit/anthropic-auth-core'
import { createPiCustodyCommands } from '../custody.ts'

let dir: string | undefined

function isPathWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  )
}
afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})
async function fixture() {
  dir = await mkdtemp(join(tmpdir(), 'pi-custody-command-'))
  const storagePath = join(dir, 'accounts.json')
  const tokenPath = join(dir, 'token.json')
  process.env.PI_CODING_AGENT_DIR = dir
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
  await writeLegacyAccountFiles(storagePath, {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    accounts: [],
  })
  await writeFile(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  return {
    storagePath,
    tokenPath,
    authPath: join(dir, 'auth.json'),
    commands: createPiCustodyCommands(),
  }
}

test('custody mode commands give offline guidance without granting or changing authority', async () => {
  const f = await fixture()
  const before = await readFile(f.storagePath, 'utf8')
  const tokenBefore = await readFile(f.tokenPath, 'utf8')
  expect((await f.commands.transition('claustrum')).text).toContain(
    'offline setup',
  )
  expect(
    getClaustrumMode(await readLegacyJson<AccountStorage>(f.storagePath)),
  ).toBe('local')
  expect((await f.commands.transition('local')).text).toContain('offline setup')
  expect(
    getClaustrumMode(await readLegacyJson<AccountStorage>(f.storagePath)),
  ).toBe('local')
  expect(await readFile(f.storagePath, 'utf8')).toBe(before)
  expect(await readFile(f.tokenPath, 'utf8')).toBe(tokenBefore)
})

test('local OAuth requires explicit setup consent; a slash command never deletes it', async () => {
  const f = await fixture()
  const auth = JSON.stringify({
    anthropic: {
      type: 'oauth',
      access: 'local-test-access',
      refresh: 'local-test-refresh',
      expires: 0,
    },
  })
  await writeFile(f.authPath, auth, { mode: 0o600 })
  const before = await readFile(f.storagePath, 'utf8')
  expect((await f.commands.transition('claustrum')).text).toContain('Refused:')
  expect(await readFile(f.authPath, 'utf8')).toBe(auth)
  expect(await readFile(f.storagePath, 'utf8')).toBe(before)
})

test('offline custody guidance does not need a live vault preflight or reconfigure the provider', async () => {
  const f = await fixture()
  await rm(f.tokenPath)
  const before = await readFile(f.storagePath, 'utf8')
  expect((await f.commands.transition('claustrum')).text).toContain(
    'offline setup',
  )
  expect(
    getClaustrumMode(await readLegacyJson<AccountStorage>(f.storagePath)),
  ).toBe('local')
  expect(await readFile(f.storagePath, 'utf8')).toBe(before)
  await expect(readFile(f.tokenPath, 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

test('Pi preload resolves default enrollment paths inside the test sandbox', () => {
  const sandboxStateHome = process.env.XDG_STATE_HOME
  expect(sandboxStateHome).toBeDefined()
  if (!sandboxStateHome)
    throw new Error('Pi test sandbox state home is missing')

  const sandboxDirectory = dirname(sandboxStateHome)
  expect(basename(sandboxDirectory).startsWith('anthropic-auth-pi-test-')).toBe(
    true,
  )
  expect(sandboxStateHome).toBe(join(sandboxDirectory, 'xdg-state'))

  const paths = getHostClaustrumEnrollmentPaths('pi')
  for (const path of [paths.tokenPath, paths.statePath]) {
    expect(isPathWithin(sandboxStateHome, path)).toBe(true)
  }

  const defaultEnrollmentDir = join(
    homedir(),
    '.local',
    'state',
    'cortexkit',
    'anthropic-auth',
  )
  expect(paths.tokenPath).not.toBe(
    join(defaultEnrollmentDir, 'pi-enrollment.json'),
  )
  expect(paths.statePath).not.toBe(
    join(defaultEnrollmentDir, 'pi-enrollment-state.json'),
  )
})

test('terminal enrollment reset is local, locked and independent of daemon availability', async () => {
  const f = await fixture()
  await rm(f.tokenPath)
  const paths = getHostClaustrumEnrollmentPaths('pi')
  await writeFile(
    paths.statePath,
    JSON.stringify({
      version: 1,
      phase: 'denied',
      proposedName: 'anthropic-auth-pi',
      updatedAt: 1,
    }),
    { mode: 0o600 },
  )
  expect((await f.commands.reset()).text).toContain('cleared')
  expect(await f.commands.status()).toEqual({ state: 'idle' })
})

import {
  readLegacyJson,
  writeLegacyAccountFiles,
} from '../../../core/src/tests/legacy-account-fixture.ts'
