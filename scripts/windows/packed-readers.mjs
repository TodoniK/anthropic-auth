import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertFreshOpenCode1Journal, sha256, snapshot } from './harness.mjs'

/** Resolve from the installed CLI, including import-only package export maps. */
export async function loadPackedRuntime(consumer) {
  const cli = join(
    consumer,
    'node_modules',
    '@cortexkit',
    'opencode-anthropic-auth',
    'dist',
    'cli.js',
  )
  const parent = pathToFileURL(cli).href
  const privateEntry = fileURLToPath(
    import.meta.resolve('@cortexkit/private-files', parent),
  )
  const api = await import(pathToFileURL(privateEntry).href)
  const core = await import(
    import.meta.resolve('@cortexkit/anthropic-auth-core', parent)
  )
  return { cli, privateEntry, api, core }
}

/** Shared by native CI and the portable packed-consumer proof; never imports product source. */
export async function verifySetupReaders({
  core,
  api,
  env,
  profile,
  result,
  fixtureToken,
}) {
  const paths = await core.resolveNativePoolPaths(
    join(env.OPENCODE_CONFIG_DIR, 'anthropic-auth.json'),
    join(env.OPENCODE_CONFIG_DIR, 'anthropic-auth-state.json'),
  )
  const journal = await core.readNativeMigrationJournal(paths)
  assertFreshOpenCode1Journal(journal)
  result.dacls['setup-journal'] = await api.verifyOwnerOnly(paths.journal)
  assert.equal(result.dacls['setup-journal'].ok, true)
  result.files['setup-journal'] = sha256(await readFile(paths.journal))

  // The no-login setup already wrote an empty runtime. Verify its pinned private
  // bytes instead of reaching into Core's unexported runtime implementation.
  const runtimeBytes = await api.readPrivateFile(paths.runtime)
  assert.deepEqual(JSON.parse(runtimeBytes.toString('utf8')), {
    version: 1,
    storageId: paths.storageId,
    accounts: {},
  })
  result.dacls['setup-runtime'] = await api.verifyOwnerOnly(paths.runtime)
  assert.equal(result.dacls['setup-runtime'].ok, true)
  result.files['setup-runtime'] = sha256(runtimeBytes)

  const auth = join(profile, 'synthetic-host-auth.json')
  await api.createPrivateFile(auth, '{}')
  assert.equal(await core.readNativeHostAuthKind('opencode', auth), 'absent')
  const token = join(profile, 'synthetic-enrollment.json')
  await api.createPrivateFile(
    token,
    JSON.stringify({ token: fixtureToken, token_generation: 1 }),
  )
  assert.equal(
    (
      await core.readClaustrumEnrollmentStatus({
        tokenPath: token,
        statePath: join(profile, 'missing-state'),
      })
    ).state,
    'approved',
  )
  result.files.profile = await snapshot(profile)
  return {
    journal: 'setup-written v4 retired migration',
    runtime: 'setup-written empty runtime; private-files verified bytes',
    hostAuth: 'synthetic absent',
    enrollment: 'synthetic token, never used for a connection',
    ownershipBackend:
      process.platform === 'win32' ? 'native-dacl' : 'posix-mode-and-owner',
  }
}
