import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = new URL('../../', import.meta.url)
const workflow = Bun.YAML.parse(
  await readFile(new URL('.github/workflows/windows.yml', root), 'utf8'),
) as any
const release = Bun.YAML.parse(
  await readFile(new URL('.github/workflows/release.yaml', root), 'utf8'),
) as any

test('one Linux producer builds and packs the release artifacts once', () => {
  const job = workflow.jobs['build-packages']
  expect(job?.['runs-on']).toBe('ubuntu-latest')
  expect(job.strategy).toBeUndefined()
  expect(job.steps[0].with.ref).toBe('$' + '{{ inputs.ref || github.sha }}')
  const build = job.steps.find(
    (step: any) => step.name === 'Build release packages',
  )
  expect(build.run).toBe('bun run build')
  const pack = job.steps.find(
    (step: any) => step.name === 'Pack Core, OpenCode and Pi',
  ).run
  for (const name of ['core', 'opencode', 'pi'])
    expect(pack).toContain(`npm pack ./packages/${name} --ignore-scripts`)
  const upload = job.steps.find((step: any) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  )
  expect(upload.with.name).toBe('anthropic-release-packages')
  expect(upload.with.path).toContain('anthropic-packed/*.tgz')
  expect(upload.with['if-no-files-found']).toBe('error')
  expect(workflow.on.workflow_call.inputs.version.type).toBe('string')
  expect(
    job.steps.find(
      (step: any) => step.name === 'Sync requested release version',
    ).run,
  ).toContain('scripts/version-sync.mjs')
})

test('Windows proof downloads shared tarballs under Node without repository dev installation on any runner', () => {
  expect(workflow.on.workflow_call).toBeDefined()
  expect(workflow.on.push.branches).toEqual(['main', 'windows-verify/**'])
  expect(workflow.on.pull_request.branches).toEqual(['main'])
  const job = workflow.jobs['packed-setup']
  expect(job.strategy.matrix.os).toEqual([
    'windows-latest',
    'windows-2022',
    'windows-11-arm',
  ])
  expect(job.needs).toContain('build-packages')
  expect(job.steps[0].with.ref).toBe('$' + '{{ inputs.ref || github.sha }}')
  const download = job.steps.find((step: any) =>
    step.uses?.startsWith('actions/download-artifact@'),
  )
  expect(download.with.name).toBe('anthropic-release-packages')
  expect(download.with.path).toContain('anthropic-packed')
  expect(
    job.steps.some((step: any) => step.uses?.startsWith('oven-sh/setup-bun@')),
  ).toBe(false)
  for (const step of job.steps) {
    expect(step.run ?? '').not.toMatch(/\bbun\b|npm\s+(?:ci|install|pack)\b/)
  }
  const proof = job.steps.find(
    (step: any) =>
      step.name === 'Verify installed packages under Node and retain receipt',
  ).run
  expect(proof).toContain(
    'node --experimental-import-meta-resolve scripts/windows/verify.mjs $packs $receipt',
  )
  expect(proof).toContain('exit $LASTEXITCODE')
  const upload = job.steps.find((step: any) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  )
  expect(upload.if).toBe('always()')
  expect(upload.with['if-no-files-found']).toBe('error')
  expect(upload.with.path).toContain('anthropic-windows-receipt.json')
})

test('release publishing waits for the reusable Windows proof at the exact release ref', () => {
  expect(release.jobs.windows.uses).toBe('./.github/workflows/windows.yml')
  expect(release.jobs.windows.with.ref).toBe(
    '$' + '{{ github.event.inputs.ref || github.ref }}',
  )
  expect(release.jobs['publish-npm'].needs).toContain('windows')
  expect(release.jobs['github-release'].needs).toContain('windows')
})

test('receipt preserves named publication timeout failures and does not qualify failed Windows runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'windows-receipt-'))
  try {
    const receipt = join(dir, 'receipt.json')
    const harness = new URL('harness.mjs', import.meta.url).href
    const output = await run(
      'node',
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { withReceipt } from ${JSON.stringify(harness)};
      const result = { platform: 'win32', profile: 'synthetic-profile' };
      let cleaned = false;
      const ok = await withReceipt(process.argv[1], result, async step => {
        await step('publication-deadline', () => { throw new Error('ETIMEDOUT synthetic-profile'); });
        await step('independent-loader', () => ({ loaded: true }));
      }, async () => { cleaned = true; });
      assert.equal(ok, false); assert.equal(cleaned, true);
      assert.equal(result.nativeWindowsQualified, false);
      console.log('3 receipt steps verified');
    `,
        receipt,
      ],
      { cwd: fileURLToPath(root) },
    )
    expect(output.stdout).toContain('3 receipt steps verified')
    const record = JSON.parse(await readFile(receipt, 'utf8'))
    expect(record.steps.map((step: any) => [step.name, step.status])).toEqual([
      ['publication-deadline', 'failed'],
      ['independent-loader', 'passed'],
      ['cleanup', 'passed'],
    ])
    expect(record.steps[0].error).toContain('ETIMEDOUT')
    expect(JSON.stringify(record)).not.toContain('synthetic-profile')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('isolated profile removes inherited credentials and snapshots detect files and empty directories', async () => {
  const harness = new URL('harness.mjs', import.meta.url).href
  const output = await run('node', [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os'; import { join } from 'node:path';
    import { snapshot, isolatedEnvironment } from ${JSON.stringify(harness)};
    const root = await mkdtemp(join(tmpdir(), 'windows-snapshot-'));
    try {
      const inherited = { ANTHROPIC_API_KEY: 'secret', OPENCODE_AUTH_CONTENT: 'secret', PATH: 'tools' };
      const env = isolatedEnvironment(root, inherited);
      assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.OPENCODE_AUTH_CONTENT, undefined);
      assert.equal(inherited.ANTHROPIC_API_KEY, 'secret'); assert.equal(env.PATH, 'tools');
      const initial = await snapshot(root); await mkdir(join(root, 'empty'));
      assert.notDeepEqual(await snapshot(root), initial);
      await writeFile(join(root, 'record'), 'one'); const before = await snapshot(root);
      await writeFile(join(root, 'record'), 'two'); assert.notDeepEqual(await snapshot(root), before);
      console.log('4 isolation and snapshot controls verified');
    } finally { await rm(root, { recursive: true, force: true }); }
  `,
  ])
  expect(output.stdout).toContain('4 isolation and snapshot controls verified')
})

test('OpenCode 1 journal proof accepts the real v4 retired migration and rejects empty-init or unfinished state', async () => {
  const harness = new URL('harness.mjs', import.meta.url).href
  const output = await run('node', [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { assertFreshOpenCode1Journal } from ${JSON.stringify(harness)};
    const journal = { version: 4, host: 'opencode', phase: 'retired', sources: {
      config: null, state: null, hostAuth: 'absent', routing: null,
    } };
    assertFreshOpenCode1Journal(journal);
    for (const bad of [undefined, { ...journal, version: 5 }, { ...journal, kind: 'empty-init' }, { ...journal, phase: 'committed' }, { ...journal, host: 'pi' }])
      assert.throws(() => assertFreshOpenCode1Journal(bad));
    console.log('v4 retired journal accepted and 5 wrong-route/unfinished controls refused');
  `,
  ])
  expect(output.stdout).toContain(
    'v4 retired journal accepted and 5 wrong-route/unfinished controls refused',
  )
})

test('release publishes the exact verified tarballs without a second build or lifecycle repack', () => {
  expect(release.jobs.windows.with.version).toBe(
    '$' + '{{ github.event.inputs.version || github.ref_name }}',
  )
  const job = release.jobs['publish-npm']
  const download = job.steps.find((step: any) =>
    step.uses?.startsWith('actions/download-artifact@'),
  )
  expect(download?.with.name).toBe('anthropic-release-packages')
  const publish = job.steps.find(
    (step: any) => step.name === 'Publish package to npm',
  ).run
  expect(publish).toContain('anthropic-packed')
  expect(publish).toContain('.tgz')
  expect(publish).toContain('--ignore-scripts')
  expect(publish).not.toContain('--workspace')
  expect(
    job.steps.some((step: any) => step.uses?.startsWith('oven-sh/setup-bun@')),
  ).toBe(false)
  for (const step of job.steps)
    expect(step.run ?? '').not.toMatch(
      /bun install|bun run build|version-sync\.mjs/,
    )
})

test('artifact publishing selects the supplied scoped-package tarball and disables lifecycle scripts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verified-package-publish-'))
  try {
    await mkdir(join(dir, 'anthropic-packed'))
    const script = release.jobs['publish-npm'].steps.find(
      (step: any) => step.name === 'Publish package to npm',
    ).run
    for (const { package: name } of release.jobs['publish-npm'].strategy.matrix
      .include) {
      const archive = join(
        dir,
        'anthropic-packed',
        `${name.slice(1).replace('/', '-')}-9.8.7.tgz`,
      )
      await writeFile(archive, 'synthetic tarball path fixture')
      const result = await run(
        'bash',
        ['-c', `npm() { printf '%s\\n' "$@"; }; ${script}`],
        {
          env: {
            ...process.env,
            RUNNER_TEMP: dir,
            PACKAGE_NAME: name,
            PACKAGE_VERSION: '9.8.7',
          },
        },
      )
      expect(result.stdout.trim().split('\n')).toEqual([
        'publish',
        archive,
        '--ignore-scripts',
        '--access',
        'public',
        '--provenance',
      ])
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('publication-deadline passes healthy setup after the adopted upstream fix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'healthy-publication-'))
  try {
    const harness = new URL('harness.mjs', import.meta.url).href
    const output = await run('node', [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { withReceipt, assertHealthySetupPublication } from ${JSON.stringify(harness)};
      const result = { platform: 'win32' };
      const ok = await withReceipt(process.argv[1], result, async step => {
        await step('publication-deadline', () => assertHealthySetupPublication({ exitCode: 0, publication: { kind: 'succeeded' } }, true));
      });
      assert.equal(ok, true); assert.equal(result.nativeWindowsQualified, true);
      assert.equal(result.steps[0].status, 'passed');
      assert.deepEqual(result.steps[0].evidence, { timeoutObserved: false });
      console.log('healthy setup qualifies with a passed publication-deadline step');
    `,
      join(dir, 'receipt.json'),
    ])
    expect(output.stdout).toContain(
      'healthy setup qualifies with a passed publication-deadline step',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('publication timeout is an unexpected failure and missing success cannot qualify', async () => {
  const harness = new URL('harness.mjs', import.meta.url).href
  const output = await run('node', [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { assertHealthySetupPublication } from ${JSON.stringify(harness)};
    assert.throws(() => assertHealthySetupPublication({ exitCode: 1, publication: { kind: 'publication-timeout' } }, false), /Unexpected Windows publication timeout/);
    for (const [record, success] of [
      [{ exitCode: 1, publication: { kind: 'unclassified-setup-failure' } }, true],
      [{ exitCode: 1, publication: { kind: 'succeeded' } }, true],
      [{ exitCode: 0, publication: { kind: 'unclassified-setup-failure' } }, true],
      [{ exitCode: 0, publication: { kind: 'succeeded' } }, false],
      [undefined, true],
    ]) assert.throws(() => assertHealthySetupPublication(record, success));
    console.log('timeout and 5 incomplete/failed setup controls refused');
  `,
  ])
  expect(output.stdout).toContain(
    'timeout and 5 incomplete/failed setup controls refused',
  )
})
