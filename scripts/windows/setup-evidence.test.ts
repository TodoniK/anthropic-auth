import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const harness = new URL('harness.mjs', import.meta.url).href

for (const exitCode of [0, 7]) {
  test(`setup receipt and job log retain bounded redacted child evidence on exit ${exitCode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-evidence-'))
    try {
      const receipt = join(root, 'receipt.json')
      const childSource = String.raw`
        const fs = require('node:fs'); const path = require('node:path');
        const root = process.argv[1]; const token = process.argv[2];
        fs.mkdirSync(path.join(root, 'diagnostics'), { recursive: true });
        fs.writeFileSync(path.join(root, 'diagnostics', 'cli-setup-fixture.log'),
          '[time] ERROR [cli] Setup failed ' + JSON.stringify({ stage: 'cli-setup', code: 'cli-setup/unexpected-error', pid: 1 }) +
          '\nPrivateFileError: Private file refused at rename: ' + path.join(root, 'private file.json') +
          ' (ETIMEDOUT)\ncaused by: Publication deadline expired\n' + token);
        process.stdout.write('prefix' + 'x'.repeat(6000) + ' ' + root + '/private.json (stdout) ' + token + ' END-STDOUT');
        process.stderr.write('prefix' + 'é'.repeat(3000) + ' ' + root + '/private.json (stderr) ' + token + ' END-STDERR');
        process.exit(${exitCode});
      `
      await run('node', [
        '--input-type=module',
        '-e',
        `
        import assert from 'node:assert/strict';
        import { execFile } from 'node:child_process';
        import { promisify } from 'node:util';
        import { join } from 'node:path';
        import { withReceipt } from ${JSON.stringify(harness)};
        const exec = promisify(execFile);
        const root = process.argv[1];
        const token = 'a'.repeat(64);
        const child = ${JSON.stringify(childSource)};
        const result = { platform: 'win32', profile: root };
        const echoed = [];
        await withReceipt(process.argv[2], result, async step => {
          await step('setup-fixture', async () => {
            const output = await exec(process.execPath, ['-e', child, root, token]);
            return { ...output, exitCode: 0 };
          }, { setupChild: true });
        }, async () => {}, {
          fixtureRoots: [root], secrets: [token], diagnosticsDirectory: join(root, 'diagnostics'),
          log: line => echoed.push(JSON.parse(line)),
        });
        const entry = result.steps[0];
        assert.equal(entry.evidence.exitCode, ${exitCode});
        assert.equal(entry.status, ${JSON.stringify(exitCode === 0 ? 'passed' : 'failed')});
        for (const key of ['stdoutTail', 'stderrTail']) {
          assert(Buffer.byteLength(entry.evidence[key]) <= 4096);
          assert(!entry.evidence[key].includes('prefix'));
          assert(entry.evidence[key].includes(key === 'stdoutTail' ? 'END-STDOUT' : 'END-STDERR'));
        }
        assert.equal(entry.evidence.diagnostics.files[0].stage, 'cli-setup');
        assert.equal(entry.evidence.diagnostics.files[0].code, 'cli-setup/unexpected-error');
        assert(entry.evidence.diagnostics.files[0].contentsTail.includes('Publication deadline expired'));
        assert.equal(entry.evidence.publication.kind, 'publication-timeout');
        assert.deepEqual(echoed, [entry]);
        assert(!JSON.stringify(result).includes(root));
        assert(!JSON.stringify(result).includes(token));
        assert(JSON.stringify(result).includes('<redacted'));
      `,
        root,
        receipt,
      ])
      const evidence = JSON.parse(await readFile(receipt, 'utf8')).steps[0]
        .evidence
      expect(evidence.exitCode).toBe(exitCode)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('setup failure without a diagnostic signature stays unclassified rather than excluding publication timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-unknown-'))
  try {
    await run('node', [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { withReceipt } from ${JSON.stringify(harness)};
      const result = { platform: 'win32', profile: process.argv[1] };
      await withReceipt(process.argv[2], result, async step => {
        await step('setup-fixture', () => {
          throw Object.assign(new Error('Command failed'), { code: 1, stdout: '', stderr: '' });
        }, { setupChild: true });
      }, async () => {}, { log() {} });
      assert.equal(result.steps[0].evidence.publication.kind, 'unclassified-setup-failure');
      assert.equal(result.nativeWindowsQualified, false);
    `,
      root,
      join(root, 'receipt.json'),
    ])
    expect(
      JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8')).status,
    ).toBe('failed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows fixture redaction covers path spellings and redacts before UTF-8 tail truncation', async () => {
  const evidence = new URL('setup-evidence.mjs', import.meta.url).href
  const output = await run('node', [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { fixtureRedactor, boundedTail } from ${JSON.stringify(evidence)};
    const root = ${JSON.stringify('C:\\fixture home\\profile')};
    const token = 'a'.repeat(64);
    const redact = fixtureRedactor({ fixtureRoots: [root], secrets: [token] });
    for (const path of [root + '\\\\private folder\\\\key.json', JSON.stringify(root + '\\\\private folder\\\\key.json'), root.toLowerCase().replaceAll('\\\\', '/') + '/private folder/key.json', 'file:///' + encodeURI(root.replaceAll('\\\\', '/')) + '/private%20folder/key.json']) {
      const clean = redact(path + ' (EPERM) ' + token);
      assert(clean.includes('<redacted-fixture-path>'));
      assert(!clean.includes('private folder'));
      assert(!clean.includes('private%20folder'));
      assert(!clean.includes(token));
      assert(clean.includes('EPERM'));
    }
    const tail = boundedTail('é'.repeat(3000) + token + root + '/private folder/key.json (END)', redact);
    assert(Buffer.byteLength(tail) <= 4096);
    assert(!tail.includes('�'));
    assert(!tail.includes('private folder'));
    assert(!tail.includes('aaaa'));
    assert(tail.endsWith('(END)'));
    console.log('4 Windows path spellings and UTF-8 tail controls checked');
  `,
  ])
  expect(output.stdout).toContain(
    '4 Windows path spellings and UTF-8 tail controls checked',
  )
})

test('publication classification detects rename deadlines without calling unrelated ETIMEDOUT a publication failure', async () => {
  const evidence = new URL('setup-evidence.mjs', import.meta.url).href
  const output = await run('node', [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { classifyPublication } from ${JSON.stringify(evidence)};
    for (const options of [
      { stderr: 'PrivateFileError: Private file refused at rename: <fixture> (ETIMEDOUT)' },
      { stdout: 'Publication deadline expired' },
      { diagnostics: ['[header] stage cli-setup code cli-setup/unexpected-error', 'caused by: publication\\nDEADLINE expired'] },
    ]) assert.equal(classifyPublication({ exitCode: 1, ...options }).kind, 'publication-timeout');
    assert.equal(classifyPublication({ exitCode: 1, stderr: 'connect ETIMEDOUT' }).kind, 'unclassified-setup-failure');
    assert.equal(classifyPublication({ exitCode: 1 }).kind, 'unclassified-setup-failure');
    assert.equal(classifyPublication({ exitCode: 0 }).kind, 'succeeded');
    console.log('6 publication classifications checked');
  `,
  ])
  expect(output.stdout).toContain('6 publication classifications checked')
})

for (const failed of [true, false]) {
  test(`locked addon cleanup records leftovers without changing a ${failed ? 'failed' : 'passing'} product result`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-cleanup-'))
    try {
      const evidence = new URL('setup-evidence.mjs', import.meta.url).href
      const output = await run('node', [
        '--input-type=module',
        '-e',
        `
        import assert from 'node:assert/strict';
        import { mkdir, writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        import { withReceipt } from ${JSON.stringify(harness)};
        import { cleanupFixture } from ${JSON.stringify(evidence)};
        const root = process.argv[1];
        await mkdir(join(root, 'consumer'), { recursive: true });
        await writeFile(join(root, 'consumer', 'private-files-win32-x64.node'), 'synthetic addon');
        const result = { platform: 'win32', profile: root };
        await withReceipt(join(root, 'receipt.json'), result, async step => {
          await step('product', () => { if (${failed}) throw new Error('primary setup failure'); return 'ok'; });
        }, () => cleanupFixture(root, { remove: async () => { throw Object.assign(new Error('locked ' + root), { code: 'EPERM' }); } }));
        assert.equal(result.status, ${JSON.stringify(failed ? 'failed' : 'passed')});
        assert.equal(result.nativeWindowsQualified, ${!failed});
        const cleanup = result.steps[1];
        assert.equal(cleanup.status, 'passed');
        assert.equal(cleanup.evidence.removed, false);
        assert.equal(cleanup.evidence.errorCode, 'EPERM');
        assert(cleanup.evidence.leftoverFiles.includes('consumer/private-files-win32-x64.node'));
        assert(!JSON.stringify(result).includes(root));
        console.log('cleanup result retained without overriding product');
      `,
        root,
      ])
      expect(output.stdout).toContain(
        'cleanup result retained without overriding product',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('stderr rename deadline metadata remains release-blocking even without a private diagnostic file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metadata-deadline-'))
  try {
    const evidence = new URL('setup-evidence.mjs', import.meta.url).href
    const payload = {
      error: { name: 'PrivateFileError', code: 'ETIMEDOUT', stage: 'rename' },
      saveError: {
        name: 'DiagnosticFileError',
        code: 'ERR_DIAGNOSTICS_NOT_OWNER_ONLY',
      },
    }
    const line = `CLI failure metadata: ${JSON.stringify(payload)}\n`
    const child = `process.stderr.write(${JSON.stringify(line)}); process.exit(1);`
    const output = await run('node', [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { execFile } from 'node:child_process';
      import { promisify } from 'node:util'; import { join } from 'node:path';
      import { withReceipt } from ${JSON.stringify(harness)};
      import { classifyPublication } from ${JSON.stringify(evidence)};
      const exec = promisify(execFile);
      const result = { platform: 'win32', profile: process.argv[1] };
      const ok = await withReceipt(join(process.argv[1], 'receipt.json'), result, async step => {
        await step('setup-local-noninteractive', () => exec(process.execPath, ['-e', ${JSON.stringify(child)}]), { setupChild: true });
        const metadata = result.steps[0].evidence;
        await step('publication-deadline', () => {
          assert.notEqual(metadata.publication.kind, 'publication-timeout', 'common-auth publication timeout; upstream adoption is required');
        });
      }, async () => {}, { diagnosticsDirectory: join(process.argv[1], 'absent-diagnostics'), log() {} });
      assert.equal(result.steps[0].evidence.publication.kind, 'publication-timeout');
      assert.equal(result.steps[0].evidence.publication.basis, 'private-file-rename-metadata');
      assert.equal(result.steps[0].evidence.diagnostics.state, 'absent');
      assert.equal(result.steps[1].name, 'publication-deadline');
      assert.equal(result.steps[1].status, 'failed');
      assert.equal(ok, false); assert.equal(result.nativeWindowsQualified, false);
      for (const body of [null, [], { saveError: ${JSON.stringify(payload.error)} },
        { error: { name: 'Error', code: 'ETIMEDOUT', stage: 'rename' } },
        { error: { name: 'PrivateFileError', code: 'ETIMEDOUT', stage: 'verify' } },
        { error: { name: 'PrivateFileError', code: 'EPERM', stage: 'rename' } }]) {
        assert.equal(classifyPublication({ exitCode: 1, stderr: 'CLI failure metadata: ' + JSON.stringify(body) }).kind, 'unclassified-setup-failure');
      }
      assert.equal(classifyPublication({ exitCode: 1, stderr: 'CLI failure metadata: {invalid' }).kind, 'unclassified-setup-failure');
      console.log('metadata timeout blocks release; 7 malformed/non-primary controls stay unclassified');
    `,
      root,
    ])
    expect(output.stdout).toContain(
      'metadata timeout blocks release; 7 malformed/non-primary controls stay unclassified',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
