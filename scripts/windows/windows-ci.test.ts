import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

test('Windows proof uses packed packages under Node on all supported runners and always retains receipts', () => {
  expect(workflow.on.workflow_call).toBeDefined()
  expect(workflow.on.push.branches).toEqual(['main', 'windows-verify/**'])
  expect(workflow.on.pull_request.branches).toEqual(['main'])
  const job = workflow.jobs['packed-setup']
  expect(job.strategy.matrix.os).toEqual([
    'windows-latest',
    'windows-2022',
    'windows-11-arm',
  ])
  const pack = job.steps.find(
    (step: any) => step.name === 'Pack Core, OpenCode and Pi',
  ).run
  for (const name of ['core', 'opencode', 'pi'])
    expect(pack).toContain(`npm pack ./packages/${name}`)
  expect(pack.match(/LASTEXITCODE/g)?.length).toBeGreaterThanOrEqual(5)
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
