import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  isolatedEnvironment,
  sha256,
  snapshot,
  withReceipt,
} from './harness.mjs'

const exec = promisify(execFile)
if (process.platform !== 'win32') {
  console.error(
    'Native Windows packed setup proof requires Windows; not qualified.',
  )
  process.exit(77)
}
const [packs, receipt] = process.argv.slice(2)
assert(
  packs && receipt,
  'Usage: node scripts/windows/verify.mjs <tarball-directory> <receipt.json>',
)
const root = await mkdtemp(join(homedir(), 'anthropic-windows-'))
const profile = join(root, 'profile')
const consumer = join(root, 'consumer')
const env = isolatedEnvironment(profile)
const result = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  profile,
  tarballs: {},
  files: {},
  dacls: {},
  steps: [],
}
const ok = await withReceipt(
  receipt,
  result,
  async (step) => {
    await mkdir(consumer, { recursive: true })
    for (const path of [
      env.TEMP,
      env.APPDATA,
      env.LOCALAPPDATA,
      env.OPENCODE_CONFIG_DIR,
    ])
      await mkdir(path, { recursive: true })
    await writeFile(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), '{}\n')
    const archives = await readdir(packs)
    const archive = (prefix) => {
      const matches = archives.filter(
        (name) => name.startsWith(prefix) && name.endsWith('.tgz'),
      )
      assert.equal(matches.length, 1, `Exactly one ${prefix} tarball required`)
      return join(packs, matches[0])
    }
    const coreArchive = archive('cortexkit-anthropic-auth-core-')
    const opencodeArchive = archive('cortexkit-opencode-anthropic-auth-')
    const piArchive = archive('cortexkit-pi-anthropic-auth-')
    for (const path of [coreArchive, opencodeArchive, piArchive])
      result.tarballs[path.split(/[\\/]/).pop()] = sha256(await readFile(path))
    const coreName = '@cortexkit/anthropic-auth-core'
    const opencodeName = '@cortexkit/opencode-anthropic-auth'
    const piName = '@cortexkit/pi-anthropic-auth'
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          [coreName]: `file:${coreArchive}`,
          [opencodeName]: `file:${opencodeArchive}`,
          [piName]: `file:${piArchive}`,
        },
        overrides: { [coreName]: `file:${coreArchive}` },
      }),
    )
    const installed = await step('npm-install-packed-tarballs', async () => {
      assert(
        process.env.ANTHROPIC_NPM_CLI,
        'Workflow must supply the installed npm CLI path',
      )
      await exec(
        process.execPath,
        [
          process.env.ANTHROPIC_NPM_CLI,
          'install',
          '--ignore-scripts',
          '--legacy-peer-deps',
          '--no-audit',
          '--no-fund',
        ],
        { cwd: consumer, timeout: 300_000 },
      )
      return { packages: [coreName, opencodeName, piName] }
    })
    if (!installed)
      throw new Error(
        'Packed installation failed; no source fallback is allowed',
      )
    const packageRoot = (name) =>
      join(consumer, 'node_modules', ...name.split('/'))
    const cli = join(packageRoot(opencodeName), 'dist', 'cli.js')
    const privateEntry = fileURLToPath(
      import.meta.resolve('@cortexkit/private-files', pathToFileURL(cli).href),
    )
    const api = await import(pathToFileURL(privateEntry).href)
    const core = await import(
      import.meta.resolve(coreName, pathToFileURL(cli).href)
    )
    await step('installed-runtime-loader-and-prebuild', async () => {
      assert(privateEntry.startsWith(join(consumer, 'node_modules')))
      for (const arch of ['x64', 'arm64']) {
        const binary = join(
          dirname(privateEntry),
          '..',
          'prebuilds',
          `private-files-win32-${arch}.node`,
        )
        result.files[`private-files-win32-${arch}.node`] = sha256(
          await readFile(binary),
        )
      }
      const dist = join(packageRoot(opencodeName), 'dist')
      const scripts = (await readdir(dist, { recursive: true })).filter(
        (name) => name.endsWith('.js'),
      )
      const code = (
        await Promise.all(
          scripts.map((name) => readFile(join(dist, name), 'utf8')),
        )
      ).join('\n')
      assert(
        !code.includes('private-files-win32-'),
        'Native loader must not be inlined',
      )
      assert(
        !code.includes('loadPrivateFilesNative'),
        'Private-files implementation must not be inlined',
      )
      assert(
        code.includes(coreName),
        'OpenCode must resolve installed Core dist',
      )
      assert(
        code.includes('@cortexkit/private-files'),
        'Shared runner must keep the runtime import',
      )
      for (const name of [coreName, opencodeName, piName])
        result.files[`${name}/dist/index.js`] = sha256(
          await readFile(join(packageRoot(name), 'dist/index.js')),
        )
      const probe = join(profile, 'native-prebuild-probe')
      await api.createPrivateFile(probe, 'synthetic non-credential bytes')
      const verdict = await api.verifyOwnerOnly(probe)
      assert.equal(
        verdict.ok,
        true,
        'Native DACL verifier must load and accept the native-created file',
      )
      result.dacls['native-prebuild-probe'] = verdict
      return { nativeAddonLoaded: true, arch: process.arch }
    })
    await step('tasklist-preflight', async () => {
      // Use tasklist to check process discovery without populating the isolated
      // profile: PowerShell can write a LOCALAPPDATA cache even with -NoProfile.
      await exec('tasklist.exe', ['/fo', 'csv', '/nh'], {
        env,
        timeout: 15_000,
      })
      return { command: 'tasklist.exe /fo csv /nh' }
    })
    const args = [cli, 'setup', '--yes', '--no-claustrum', '--opencode=1']
    await step('setup-dry-run-no-writes', async () => {
      const before = await snapshot(profile)
      await exec(process.execPath, [...args, '--dry-run'], {
        cwd: consumer,
        env,
        timeout: 60_000,
      })
      assert.deepEqual(
        await snapshot(profile),
        before,
        'Dry-run changed the isolated profile',
      )
      return { unchangedFiles: before }
    })
    let setupError
    await step('setup-local-noninteractive', async () => {
      try {
        await exec(process.execPath, args, {
          cwd: consumer,
          env,
          timeout: 120_000,
        })
      } catch (error) {
        setupError = error
        throw new Error(`Local setup exited ${error.code ?? 'unknown'}`)
      }
      return { exitCode: 0, credentials: 'none', mode: 'local' }
    })
    await step('publication-deadline', async () => {
      let details = `${setupError?.stdout ?? ''}\n${setupError?.stderr ?? ''}`
      const files = await snapshot(profile)
      for (const file of Object.keys(files).filter((name) =>
        name.endsWith('.log'),
      ))
        details += await readFile(join(profile, file), 'utf8')
      assert(
        !/ETIMEDOUT|Publication deadline expired/.test(details),
        'common-auth publication timeout (500 ms); adopt upstream 0.20.0, no local workaround',
      )
      if (setupError)
        throw new Error(
          'Local setup failed for a reason other than publication timeout',
        )
      return { timeoutObserved: false }
    })
    await step('setup-journal-and-owner-only-readers', async () => {
      assert(!setupError, 'Successful setup is required to qualify its files')
      const paths = await core.resolveNativePoolPaths(
        join(env.OPENCODE_CONFIG_DIR, 'anthropic-auth.json'),
      )
      const journal = await core.readNativeMigrationJournal(paths)
      assert.equal(journal?.kind, 'empty-init')
      assert.equal(journal?.phase, 'committed')
      result.dacls['setup-journal'] = await api.verifyOwnerOnly(paths.journal)
      assert.equal(result.dacls['setup-journal'].ok, true)
      result.files['setup-journal'] = sha256(await readFile(paths.journal))
      // Setup without login creates no runtime account. Exercise the real writer
      // with an empty synthetic runtime, then read it through the installed Core.
      await core.updateNativeRuntime(paths.runtime, paths.storageId, () => ({
        version: 1,
        storageId: paths.storageId,
        accounts: {},
      }))
      assert.equal(
        (await core.readNativeRuntime(paths.runtime, paths.storageId)).status,
        'ready',
      )
      result.dacls['synthetic-runtime'] = await api.verifyOwnerOnly(
        paths.runtime,
      )
      assert.equal(result.dacls['synthetic-runtime'].ok, true)
      const auth = join(profile, 'synthetic-host-auth.json')
      await api.createPrivateFile(auth, '{}')
      assert.equal(
        await core.readNativeHostAuthKind('opencode', auth),
        'absent',
      )
      const token = join(profile, 'synthetic-enrollment.json')
      await api.createPrivateFile(
        token,
        JSON.stringify({ token: 'a'.repeat(64), token_generation: 1 }),
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
        journal: 'setup-written',
        runtime: 'synthetic empty',
        hostAuth: 'synthetic absent',
        enrollment: 'synthetic token, never used for a connection',
      }
    })
  },
  () => rm(root, { recursive: true, force: true }),
)
console.log(
  `Windows packed setup: ${result.steps.length} steps, ${result.status}; receipt: ${receipt}`,
)
if (!ok) process.exitCode = 1
