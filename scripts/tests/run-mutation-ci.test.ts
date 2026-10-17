import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { createTestLifetimeSuite } from '../../packages/core/src/tests/test-lifetime.ts'
import {
  BROAD_ROWS_PER_SHARD,
  broadShardCount,
  MUTATION_RUNNER_REVISION,
  MUTATION_RUNNER_VERSION,
  mutationSelection,
  parseMutationShard,
  shardArguments,
  shardRowIds,
  verifyMutationReport,
  verifyShardedAudit,
} from '../run-mutation-ci.ts'

const base = 'a'.repeat(40)
const ids = ['history', 'fast', 'binding']
const caught = (id: string, broad = false) => ({
  id,
  outcome: 'CAUGHT',
  breadth_observed: broad,
})

test('PR target edits use the official committed diff selector', () => {
  expect(
    mutationSelection('pull_request', base, [
      'packages/core/src/request-history.ts',
    ]),
  ).toEqual(['--diff', base])
  expect(mutationSelection('pull_request', base, ['mutations.toml'])).toEqual([
    '--diff',
    base,
  ])
  expect(mutationSelection('pull_request', base, ['README.md'])).toEqual([
    '--diff',
    base,
  ])
})

test('wrapper and shared configuration changes force every row', () => {
  for (const path of [
    'scripts/run-mutation-bun.ts',
    'scripts/tests/run-mutation-bun.test.ts',
    'scripts/run-mutation-ci.ts',
    'scripts/tests/run-mutation-ci.test.ts',
    '.github/workflows/mutations.yml',
    'package.json',
    'bun.lock',
    'mise.toml',
    'packages/core/src/tests/setup.ts',
    'packages/core/src/tests/test-lifetime.ts',
    'bunfig.toml',
    'packages/pi/src/tests/setup.ts',
  ])
    expect(mutationSelection('pull_request', base, [path])).toEqual(['--all'])
})

test('main runs all named checks and scheduled or manual runs require breadth', () => {
  expect(mutationSelection('push', undefined, [])).toEqual(['--all'])
  expect(mutationSelection('schedule', undefined, [])).toEqual([
    '--all',
    '--broad',
  ])
  expect(mutationSelection('workflow_dispatch', undefined, [])).toEqual([
    '--all',
    '--broad',
  ])
})

test('unknown events and missing or injectable PR bases refuse', () => {
  expect(() => mutationSelection('pull_request_target', base, [])).toThrow()
  for (const invalid of [
    undefined,
    '',
    'main',
    '-HEAD',
    `${base}; echo unsafe`,
    'A'.repeat(40),
  ])
    expect(() =>
      mutationSelection('pull_request', invalid, [
        'scripts/run-mutation-bun.ts',
      ]),
    ).toThrow()
})

test('empty diff selections succeed, but full replays cannot omit rows', () => {
  expect(verifyMutationReport([], ['--diff', base], ids)).toBe(0)
  expect(verifyMutationReport([caught('fast')], ['--diff', base], ids)).toBe(1)
  expect(() => verifyMutationReport([], ['--all'], ids)).toThrow()
  expect(() => verifyMutationReport([caught('fast')], ['--all'], ids)).toThrow()
  expect(
    verifyMutationReport(
      ids.map((id) => caught(id)),
      ['--all'],
      ids,
    ),
  ).toBe(3)
})

test('missing reports, unknown IDs, duplicates and non-catches refuse', () => {
  for (const value of [
    null,
    {},
    [caught('other')],
    [caught('fast'), caught('fast')],
    [{ id: 'fast', outcome: 'SURVIVED', breadth_observed: false }],
    [{ id: 'fast', outcome: 'SKIPPED_PLATFORM', breadth_observed: false }],
    [{ id: 'fast', outcome: 'EQUIVALENT', breadth_observed: false }],
    [{ id: 'fast', outcome: 'ERROR', breadth_observed: false }],
    [{ id: 'fast', outcome: 'CAUGHT' }],
  ])
    expect(() => verifyMutationReport(value, ['--diff', base], ids)).toThrow()
  expect(() =>
    verifyMutationReport([], ['--diff', base], ['fast', 'fast']),
  ).toThrow()
})

test('nightly breadth is required on every reported row, not just one', () => {
  expect(() =>
    verifyMutationReport(
      [caught('history', true), caught('fast'), caught('binding', true)],
      ['--all', '--broad'],
      ids,
    ),
  ).toThrow()
  expect(
    verifyMutationReport(
      ids.map((id) => caught(id, true)),
      ['--all', '--broad'],
      ids,
    ),
  ).toBe(3)
  expect(() =>
    verifyMutationReport(
      [{ id: 'fast', outcome: 'CAUGHT_BROADLY', breadth_observed: false }],
      ['--diff', base],
      ids,
    ),
  ).toThrow()
})

test('shard values are 1-based i/n and anything else refuses', () => {
  expect(parseMutationShard(undefined)).toBeUndefined()
  expect(parseMutationShard('')).toBeUndefined()
  expect(parseMutationShard('1/1')).toEqual({ index: 1, count: 1 })
  expect(parseMutationShard('3/6')).toEqual({ index: 3, count: 6 })
  for (const invalid of [
    '0/6',
    '7/6',
    '1/0',
    '1',
    '1/',
    '/6',
    ' 1/6',
    '1/6 ',
    '01/6',
    '1/2/3',
    '-1/6',
    '1.0/6',
  ])
    expect(() => parseMutationShard(invalid)).toThrow()
})

test('only the broad audit is sharded, and it always is', () => {
  const shard = { index: 2, count: 6 }
  expect(shardArguments(['--all', '--broad'], shard)).toEqual([
    '--shard',
    '2/6',
  ])
  expect(() => shardArguments(['--all', '--broad'], undefined)).toThrow()
  expect(shardArguments(['--all'], undefined)).toEqual([])
  expect(shardArguments(['--diff', base], undefined)).toEqual([])
  expect(() => shardArguments(['--all'], shard)).toThrow()
  expect(() => shardArguments(['--diff', base], shard)).toThrow()
})

test('shards take every n-th row in byte-sorted ID order, like the runner', () => {
  expect(
    shardRowIds(['e', 'a', 'd', 'b', 'c'], { index: 1, count: 2 }),
  ).toEqual(['a', 'c', 'e'])
  expect(
    shardRowIds(['e', 'a', 'd', 'b', 'c'], { index: 2, count: 2 }),
  ).toEqual(['b', 'd'])
  // Rust compares UTF-8 bytes: U+FF01 (EF BC 81) sorts before U+1F600
  // (F0 9F 98 80), although UTF-16 code-unit order puts the emoji first.
  expect(
    shardRowIds(['\u{1F600}', '\uFF01', 'B', 'a'], { index: 1, count: 1 }),
  ).toEqual(['B', 'a', '\uFF01', '\u{1F600}'])
})

test('every catalogue row lands in exactly one shard for any shard count', () => {
  const catalogue = Bun.TOML.parse(
    readFileSync(new URL('../../mutations.toml', import.meta.url), 'utf8'),
  ) as { control: { id: string }[] }
  const catalogueIds = catalogue.control.map((control) => control.id)
  expect(new Set(catalogueIds).size).toBe(catalogueIds.length)
  for (let count = 1; count <= catalogueIds.length; count++) {
    const seen = new Map<string, number>()
    for (let index = 1; index <= count; index++) {
      const rows = shardRowIds(catalogueIds, { index, count })
      expect(rows.length).toBeGreaterThan(0)
      // Round robin keeps shard sizes within one row of each other.
      expect(Math.abs(rows.length - catalogueIds.length / count)).toBeLessThan(
        1,
      )
      for (const id of rows) seen.set(id, (seen.get(id) ?? 0) + 1)
    }
    expect([...seen.keys()].sort()).toEqual([...catalogueIds].sort())
    expect([...seen.values()].every((times) => times === 1)).toBe(true)
  }
})

test('the planned shard count keeps every shard at three rows or fewer', () => {
  expect(BROAD_ROWS_PER_SHARD).toBe(3)
  expect([1, 3, 4, 6, 7, 51, 52].map(broadShardCount)).toEqual([
    1, 1, 2, 2, 3, 17, 18,
  ])
  for (const invalid of [0, -1, 1.5, Number.NaN])
    expect(() => broadShardCount(invalid)).toThrow()
  const catalogue = Bun.TOML.parse(
    readFileSync(new URL('../../mutations.toml', import.meta.url), 'utf8'),
  ) as { control: { id: string }[] }
  const catalogueIds = catalogue.control.map((control) => control.id)
  const count = broadShardCount(catalogueIds.length)
  for (let index = 1; index <= count; index++)
    expect(
      shardRowIds(catalogueIds, { index, count }).length,
    ).toBeLessThanOrEqual(BROAD_ROWS_PER_SHARD)
})

test('sharded audit passes only when every shard reports exactly its own caught rows', () => {
  const all = ['a', 'b', 'c', 'd', 'e']
  const broad = (id: string, outcome = 'CAUGHT') => ({
    id,
    outcome,
    breadth_observed: true,
  })
  const healthy = () =>
    new Map<number, unknown>([
      [1, ['a', 'c', 'e'].map((id) => broad(id))],
      [2, ['b', 'd'].map((id) => broad(id))],
    ])
  const passed = verifyShardedAudit(healthy(), 2, all)
  expect(passed.problems).toEqual([])
  expect(passed.lines).toEqual([
    'shard 1/2: 3 expected rows; reported 3 CAUGHT',
    'shard 2/2: 2 expected rows; reported 2 CAUGHT',
  ])

  const missing = healthy()
  missing.delete(2)
  expect(verifyShardedAudit(missing, 2, all).problems).toEqual([
    'shard 2/2: no report',
    'all shards: Full replay omitted catalogue rows',
  ])

  const survived = healthy()
  survived.set(2, [broad('b'), broad('d', 'SURVIVED')])
  const failed = verifyShardedAudit(survived, 2, all)
  expect(failed.lines[1]).toBe(
    'shard 2/2: 2 expected rows; reported 1 CAUGHT, 1 SURVIVED',
  )
  expect(failed.problems[0]).toStartWith('shard 2/2:')

  const misplaced = healthy()
  misplaced.set(
    1,
    ['a', 'c', 'e', 'b'].map((id) => broad(id)),
  )
  misplaced.set(2, [broad('d')])
  // Shard 1 reports a row it does not own and shard 2 omits it; the union
  // alone would look complete.
  expect(verifyShardedAudit(misplaced, 2, all).problems.length).toBe(2)

  const extra = healthy()
  extra.set(3, [])
  expect(verifyShardedAudit(extra, 2, all).problems).toContain(
    'Unexpected report for mutation shard 3/2',
  )

  const narrow = healthy()
  narrow.set(2, [
    broad('b'),
    { id: 'd', outcome: 'CAUGHT', breadth_observed: false },
  ])
  expect(verifyShardedAudit(narrow, 2, all).problems.length).toBe(2)
})

test('workflow installs the public pinned runner without write permissions or secrets', () => {
  const text = readFileSync(
    new URL('../../.github/workflows/mutations.yml', import.meta.url),
    'utf8',
  )
  expect(text).toContain('contents: read')
  expect(text).toContain('persist-credentials: false')
  expect(text).toContain(`--rev ${MUTATION_RUNNER_REVISION}`)
  expect(text).toContain(MUTATION_RUNNER_VERSION.replace(' ', '-'))
  expect(text).toContain('bun install --frozen-lockfile')
  expect(text).toContain('if: always()')
  expect(text).not.toContain('pull_request_target')
  expect(text).not.toContain('secrets.')
})

test('catalogue prebuilds current Core then packed OpenCode exports for command replays', () => {
  const catalogue = Bun.TOML.parse(
    readFileSync(new URL('../../mutations.toml', import.meta.url), 'utf8'),
  )
  // Command prebuilds run after mutation application and again after restoration;
  // a workflow-only build would leave clean or stale exports in packed hosts.
  expect(catalogue).toHaveProperty('prebuild', [
    {
      name: 'core-current-source',
      command: ['bun', 'run', '--cwd', 'packages/core', 'build'],
    },
    {
      name: 'opencode-current-source',
      command: ['bun', 'run', '--cwd', 'packages/opencode', 'build'],
    },
  ])
})

const lifetimes = createTestLifetimeSuite()

lifetimes.test(
  'mutation preparation packs every advertised OpenCode import and type export',
  async () => {
    const root = await mkdtemp(
      resolve(process.env.TMPDIR ?? '/tmp', 'mutation-pack-'),
    )
    lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
    const packageRoot = resolve(import.meta.dir, '../../packages/opencode')
    const manifest = await Bun.file(resolve(packageRoot, 'package.json')).json()
    const archive = resolve(root, 'opencode.tgz')
    const packed = Bun.spawnSync(
      [process.execPath, 'pm', 'pack', '--filename', archive],
      { cwd: packageRoot, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(packed.exitCode, packed.stderr.toString()).toBe(0)
    for (const entry of Object.values(manifest.exports)) {
      for (const target of Object.values(entry as Record<string, string>)) {
        const extracted = Bun.spawnSync(
          ['tar', '-xOf', archive, `package/${target.replace(/^\.\//, '')}`],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        expect(extracted.exitCode, `${target}: ${extracted.stderr}`).toBe(0)
        expect(extracted.stdout).toEqual(
          Buffer.from(await Bun.file(resolve(packageRoot, target)).bytes()),
        )
        expect(extracted.stdout.byteLength).toBeGreaterThan(0)
      }
    }
  },
)

async function ciFixture() {
  await mkdir(resolve(import.meta.dir, '../../tmp'), { recursive: true })
  const root = await mkdtemp(
    resolve(import.meta.dir, '../../tmp/mutation-ci-fixture-'),
  )
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  await mkdir(resolve(root, 'scripts'), { recursive: true })
  await mkdir(resolve(root, 'bin'), { recursive: true })
  await writeFile(
    resolve(root, 'scripts/run-mutation-ci.ts'),
    await readFile(new URL('../run-mutation-ci.ts', import.meta.url)),
  )
  await writeFile(
    resolve(root, 'mutations.toml'),
    ids.map((id) => `[[control]]\nid = "${id}"\n`).join('\n'),
  )
  await writeFile(resolve(root, 'README.md'), 'baseline\n')
  const binary = resolve(root, 'bin/ckdev-mutate')
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
if(process.argv[2] === '--version') { console.log(process.env.FAKE_VERSION ?? ${JSON.stringify(MUTATION_RUNNER_VERSION)}); process.exit(0) }
writeFileSync('runner-argv.json', JSON.stringify(process.argv.slice(2)))
const report = process.argv[process.argv.indexOf('--report') + 1]
const shard = process.argv.indexOf('--shard')
const [index, count] = shard < 0 ? [1, 1] : process.argv[shard + 1].split('/').map(Number)
const selected = ['history','fast','binding'].sort().filter((_, position) => position % count === index - 1)
const rows = process.env.FAKE_EMPTY === '1' ? [] : selected.map(id => ({ id, outcome: process.env.FAKE_SURVIVED === id ? 'SURVIVED' : 'CAUGHT', breadth_observed:process.argv.includes('--broad') }))
writeFileSync(report, process.env.FAKE_BAD_JSON === '1' ? 'invalid' : JSON.stringify(rows))
process.exit(process.env.FAKE_FAILURE === '1' ? 1 : 0)
`,
  )
  await chmod(binary, 0o700)
  // This disposable repository must not depend on or change a real author's
  // identity or Git configuration.
  const env = {
    ...process.env,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  for (const argv of [
    ['init', '-q'],
    ['add', '.'],
    [
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'synthetic CI baseline',
    ],
  ]) {
    const child = Bun.spawnSync(['git', ...argv], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (child.exitCode !== 0)
      throw new Error(
        `Synthetic Git ${argv.join(' ')} failed: ${child.stderr.toString()}`,
      )
    expect(child.exitCode).toBe(0)
  }
  const base = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: root,
    env,
    stdout: 'pipe',
  })
    .stdout.toString()
    .trim()
  return { root, base, env }
}

lifetimes.test(
  'synthetic Git author stays in the disposable repository and leaves real config unchanged',
  async () => {
    const cwd = resolve(import.meta.dir, '../..')
    const realEnv = { ...process.env }
    // A remote snapshot can have a different owner. Permit only this checkout
    // for the read-only path lookup, without changing any Git configuration.
    const configPath = Bun.spawnSync(
      [
        'git',
        '-c',
        `safe.directory=${cwd}`,
        'rev-parse',
        '--git-path',
        'config',
      ],
      { cwd, env: realEnv, stdout: 'pipe', stderr: 'pipe' },
    )
    if (configPath.exitCode !== 0)
      throw new Error(
        `Real Git config lookup failed: ${configPath.stderr.toString()}`,
      )
    expect(configPath.exitCode).toBe(0)
    const realConfig = resolve(cwd, configPath.stdout.toString().trim())
    const before = await readFile(realConfig)
    const fixture = await ciFixture()
    const author = Bun.spawnSync(
      ['git', 'log', '-1', '--format=%an <%ae>%n%cn <%ce>'],
      { cwd: fixture.root, env: fixture.env, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(author.exitCode).toBe(0)
    expect(author.stdout.toString().trim()).toBe(
      'Fixture <fixture@example.invalid>\nFixture <fixture@example.invalid>',
    )
    expect(fixture.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(fixture.env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(before.equals(await readFile(realConfig))).toBe(true)
  },
)

function invokeCI(
  fixture: Awaited<ReturnType<typeof ciFixture>>,
  event: string,
  extra: Record<string, string | undefined> = {},
) {
  return Bun.spawnSync([process.execPath, 'scripts/run-mutation-ci.ts'], {
    cwd: fixture.root,
    env: {
      ...fixture.env,
      PATH: `${fixture.root}/bin:${process.env.PATH}`,
      GITHUB_ACTIONS: 'true',
      MUTATION_EVENT: event,
      MUTATION_BASE: fixture.base,
      ...extra,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

lifetimes.test(
  'real CLI driver preserves official diff argv in a clean synthetic repository',
  async () => {
    const fixture = await ciFixture()
    const result = invokeCI(fixture, 'pull_request')
    expect(result.exitCode).toBe(0)
    const argv = JSON.parse(
      await readFile(resolve(fixture.root, 'runner-argv.json'), 'utf8'),
    )
    expect(argv.slice(0, 3)).toEqual(['run', '--diff', fixture.base])
    expect(result.stdout.toString()).toContain(
      '3 selected rows; breadth not requested',
    )
  },
)

lifetimes.test(
  'real CLI driver records empty diff selection without claiming a catch',
  async () => {
    const fixture = await ciFixture()
    const result = invokeCI(fixture, 'pull_request', { FAKE_EMPTY: '1' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('0 selected rows')
  },
)

lifetimes.test(
  'real CLI driver rejects empty full replay, invalid report and runner failure',
  async () => {
    const fixture = await ciFixture()
    for (const extra of [
      { FAKE_EMPTY: '1' },
      { FAKE_BAD_JSON: '1' },
      { FAKE_FAILURE: '1' },
    ]) {
      const result = invokeCI(fixture, 'push', extra)
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).not.toContain('Mutation CI passed')
    }
  },
)

lifetimes.test(
  'real CLI driver validates broad mode and rejects dirty input or wrong binary',
  async () => {
    const fixture = await ciFixture()
    expect(
      invokeCI(fixture, 'schedule', { MUTATION_SHARD: '1/1' }).exitCode,
    ).toBe(0)
    const argv = JSON.parse(
      await readFile(resolve(fixture.root, 'runner-argv.json'), 'utf8'),
    )
    expect(argv.slice(0, 5)).toEqual([
      'run',
      '--all',
      '--broad',
      '--shard',
      '1/1',
    ])
    expect(invokeCI(fixture, 'schedule').exitCode).toBe(1)
    expect(invokeCI(fixture, 'push', { MUTATION_SHARD: '1/2' }).exitCode).toBe(
      1,
    )
    const shard = invokeCI(fixture, 'workflow_dispatch', {
      MUTATION_SHARD: '2/2',
    })
    expect(shard.exitCode).toBe(0)
    expect(shard.stdout.toString()).toContain(
      '1 selected rows in shard 2/2; breadth observed',
    )
    expect(
      invokeCI(fixture, 'schedule', {
        MUTATION_SHARD: '2/2',
        FAKE_SURVIVED: 'fast',
      }).exitCode,
    ).toBe(1)
    expect(
      invokeCI(fixture, 'push', { FAKE_VERSION: 'ckdev-mutate 0.8.0' })
        .exitCode,
    ).toBe(1)
    await writeFile(resolve(fixture.root, 'README.md'), 'uncommitted change\n')
    expect(invokeCI(fixture, 'push').exitCode).toBe(1)
  },
)

test('parsed workflow has isolated read-only PR/main/nightly jobs and retained artifacts', () => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(
      new URL('../../.github/workflows/mutations.yml', import.meta.url),
      'utf8',
    ),
  )
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  if (
    !record(workflow) ||
    !record(workflow.on) ||
    !record(workflow.permissions) ||
    !record(workflow.jobs)
  )
    throw new Error('Invalid mutation workflow')
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(Object.keys(workflow.on).sort()).toEqual([
    'pull_request',
    'push',
    'schedule',
    'workflow_dispatch',
  ])
  if (!record(workflow.on.push)) throw new Error('Missing main trigger')
  expect(workflow.on.push.branches).toEqual(['main'])
  expect(Array.isArray(workflow.on.schedule)).toBe(true)
  const job = workflow.jobs.guards
  if (!record(job) || !Array.isArray(job.steps) || !record(job.env))
    throw new Error('Invalid mutation job')
  expect(job.env.MUTATION_EVENT).toBe(`\${{ github.event_name }}`)
  expect(job.env.MUTATION_BASE).toBe(
    `\${{ github.event.pull_request.base.sha }}`,
  )
  const steps: unknown[] = job.steps
  const checkout = steps.find(
    (step) =>
      record(step) &&
      typeof step.uses === 'string' &&
      step.uses.startsWith('actions/checkout@'),
  )
  if (!record(checkout) || !record(checkout.with))
    throw new Error('Missing isolated checkout')
  expect(checkout.with['fetch-depth']).toBe(0)
  expect(checkout.with['persist-credentials']).toBe(false)
  const upload = steps.find(
    (step) =>
      record(step) &&
      typeof step.uses === 'string' &&
      step.uses.startsWith('actions/upload-artifact@'),
  )
  if (!record(upload) || !record(upload.with))
    throw new Error('Missing artifact retention')
  expect(upload.if).toBe('always()')
  expect(upload.with.path).toBe('tmp/mutations/')
  // Scheduled and manual runs (the sharded --broad audit) skip this job; it
  // serves only pull requests and main pushes.
  expect(job.if).toBe(
    "github.event_name == 'pull_request' || github.event_name == 'push'",
  )

  const audit = workflow.jobs.audit
  if (
    !record(audit) ||
    !record(audit.strategy) ||
    !record(audit.strategy.matrix) ||
    !record(audit.env) ||
    !Array.isArray(audit.steps)
  )
    throw new Error('Invalid sharded audit job')
  expect(audit.if).toBe(
    "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
  )
  expect(audit['timeout-minutes']).toBe(30)
  expect(audit.strategy['fail-fast']).toBe(false)
  expect(audit.needs).toBe('audit-plan')
  expect(audit.strategy.matrix.shard).toBe(
    `\${{ fromJSON(needs.audit-plan.outputs.shards) }}`,
  )
  expect(audit.env.MUTATION_EVENT).toBe(`\${{ github.event_name }}`)
  expect(audit.env.MUTATION_SHARD).toBe(
    `\${{ matrix.shard }}/\${{ needs.audit-plan.outputs.count }}`,
  )
  const plan = workflow.jobs['audit-plan']
  if (!record(plan) || !record(plan.outputs) || !Array.isArray(plan.steps))
    throw new Error('Invalid audit plan job')
  expect(plan.if).toBe(audit.if)
  expect(plan.outputs).toEqual({
    count: `\${{ steps.plan.outputs.count }}`,
    shards: `\${{ steps.plan.outputs.shards }}`,
  })
  expect(plan.steps).toContainEqual({
    id: 'plan',
    run: 'bun scripts/run-mutation-ci.ts --plan',
  })
  const auditUpload = audit.steps.find(
    (step: unknown) =>
      record(step) &&
      typeof step.uses === 'string' &&
      step.uses.startsWith('actions/upload-artifact@'),
  )
  if (!record(auditUpload) || !record(auditUpload.with))
    throw new Error('Missing shard artifact retention')
  expect(auditUpload.if).toBe('always()')
  expect(auditUpload.with.path).toBe('tmp/mutations/')
  expect(auditUpload.with.name).toBe(
    `mutation-\${{ github.run_id }}-\${{ github.run_attempt }}-shard-\${{ matrix.shard }}`,
  )

  const summary = workflow.jobs['audit-summary']
  if (!record(summary) || !record(summary.env) || !Array.isArray(summary.steps))
    throw new Error('Invalid audit summary job')
  expect(summary.needs).toEqual(['audit-plan', 'audit'])
  expect(summary.if).toBe(
    "always() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')",
  )
  expect(summary.env.MUTATION_SHARD_COUNT).toBe(
    `\${{ needs.audit-plan.outputs.count }}`,
  )
  expect(summary.env.AUDIT_RESULT).toBe(`\${{ needs.audit.result }}`)
  const download = summary.steps.find(
    (step: unknown) =>
      record(step) &&
      typeof step.uses === 'string' &&
      step.uses.startsWith('actions/download-artifact@'),
  )
  if (!record(download) || !record(download.with))
    throw new Error('Missing shard report download')
  expect(download.with.pattern).toBe(
    `mutation-\${{ github.run_id }}-\${{ github.run_attempt }}-shard-*`,
  )
  expect(download.with.path).toBe('tmp/mutation-shards/')
  const runs = summary.steps.filter(
    (step: unknown) => record(step) && typeof step.run === 'string',
  ) as Record<string, unknown>[]
  expect(runs.map((step) => [step.if, step.run])).toEqual([
    [
      'always()',
      'bun scripts/run-mutation-ci.ts --summarize tmp/mutation-shards',
    ],
    ['always()', expect.stringContaining('"$AUDIT_RESULT" != success')],
  ])
})

async function writeShardReport(
  directory: string,
  shard: string,
  rows: unknown,
) {
  const artifact = resolve(directory, `mutation-1-1-shard-${shard}`)
  const folder = resolve(artifact, 'ci-run')
  await mkdir(folder, { recursive: true })
  await writeFile(
    resolve(folder, 'invocation.json'),
    JSON.stringify({ event: 'schedule', shard }),
  )
  if (rows !== undefined)
    await writeFile(resolve(folder, 'rows.json'), JSON.stringify(rows))
  // A real shard artifact also carries the Bun wrapper's per-command evidence
  // folders, each with an invocation.json that names no shard. The summary
  // must not mistake them for shard reports.
  for (const audit of ['named-x1', 'package-x2']) {
    const evidence = resolve(artifact, 'audits', audit)
    await mkdir(evidence, { recursive: true })
    await writeFile(
      resolve(evidence, 'invocation.json'),
      JSON.stringify({ argv: ['bun', 'test'], cwd: '.', exitCode: 0 }),
    )
  }
}

lifetimes.test(
  'real CLI plan sizes the shard matrix from the catalogue',
  async () => {
    const fixture = await ciFixture()
    const output = resolve(fixture.root, 'github-output')
    const plan = () =>
      Bun.spawnSync(
        [process.execPath, 'scripts/run-mutation-ci.ts', '--plan'],
        {
          cwd: fixture.root,
          env: { ...fixture.env, GITHUB_OUTPUT: output },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
    expect(plan().exitCode).toBe(0)
    expect(await readFile(output, 'utf8')).toBe('count=1\nshards=[1]\n')
    await writeFile(
      resolve(fixture.root, 'mutations.toml'),
      Array.from(
        { length: 7 },
        (_, row) => `[[control]]\nid = "row-${row}"\n`,
      ).join('\n'),
    )
    await rm(output)
    const grown = plan()
    expect(grown.exitCode).toBe(0)
    expect(grown.stdout.toString()).toContain('Broad mutation audit: 3 shards')
    expect(await readFile(output, 'utf8')).toBe('count=3\nshards=[1,2,3]\n')
  },
)

lifetimes.test(
  'real CLI summary combines downloaded shard reports into one verdict',
  async () => {
    const fixture = await ciFixture()
    // Six rows plan two shards: a, c, e and b, d, f.
    await writeFile(
      resolve(fixture.root, 'mutations.toml'),
      ['f', 'e', 'd', 'c', 'b', 'a']
        .map((id) => `[[control]]\nid = "${id}"\n`)
        .join('\n'),
    )
    const summarize = (directory: string, count = '2') =>
      Bun.spawnSync(
        [
          process.execPath,
          'scripts/run-mutation-ci.ts',
          '--summarize',
          directory,
        ],
        {
          cwd: fixture.root,
          env: { ...fixture.env, MUTATION_SHARD_COUNT: count },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
    const odd = () => ['a', 'c', 'e'].map((id) => caught(id, true))
    const healthy = resolve(fixture.root, 'healthy')
    await writeShardReport(healthy, '1/2', odd())
    await writeShardReport(
      healthy,
      '2/2',
      ['b', 'd', 'f'].map((id) => caught(id, true)),
    )
    const passed = summarize(healthy)
    expect(passed.exitCode, passed.stderr.toString()).toBe(0)
    expect(passed.stdout.toString()).toContain(
      'shard 2/2: 3 expected rows; reported 3 CAUGHT',
    )
    expect(passed.stdout.toString()).toContain(
      'Mutation audit passed: 2 shards',
    )
    // The reports form a 2-shard audit, and the catalogue plans 2 shards.
    expect(summarize(healthy, '3').exitCode).toBe(1)
    expect(summarize(healthy, '').exitCode).toBe(1)

    const lost = resolve(fixture.root, 'lost')
    await writeShardReport(lost, '1/2', odd())
    await writeShardReport(lost, '2/2', undefined)
    const missing = summarize(lost)
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr.toString()).toContain(
      'shard 2/2: missing or invalid rows.json',
    )
    expect(missing.stdout.toString()).not.toContain('Mutation audit passed')

    const survived = resolve(fixture.root, 'survived')
    await writeShardReport(survived, '1/2', odd())
    await writeShardReport(survived, '2/2', [
      caught('b', true),
      { id: 'd', outcome: 'SURVIVED', breadth_observed: true },
      caught('f', true),
    ])
    const uncaught = summarize(survived)
    expect(uncaught.exitCode).toBe(1)
    expect(uncaught.stdout.toString()).toContain('2 CAUGHT, 1 SURVIVED')
    expect(uncaught.stdout.toString()).not.toContain('Mutation audit passed')
  },
)
