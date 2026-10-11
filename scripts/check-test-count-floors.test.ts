import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve(import.meta.dir, 'check-test-count-floors.ts')
const workspaces: string[] = []

type Floors = Record<'core' | 'opencode' | 'pi', number>

type LoweringMarker = {
  reason: string
  lowering: Partial<
    Record<'core' | 'opencode' | 'pi', { from: number; to: number }>
  >
}

function runGit(cwd: string, args: string[]) {
  // The harness injects a git hooksPath for the active project. These are
  // throwaway Git repositories, so isolate their commits from inherited hooks
  // rather than waiting for an unrelated hook to run in each fixture.
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_')) delete env[key]
  }
  const result = Bun.spawnSync(
    ['git', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      cwd,
      env: {
        ...env,
        GIT_AUTHOR_NAME: 'Test Runner',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test Runner',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
  return new TextDecoder().decode(result.stdout).trim()
}

async function writeFloors(
  cwd: string,
  floors: Floors,
  measurement: { head: string; dirtyPaths: number },
) {
  await mkdir(join(cwd, '.ci'), { recursive: true })
  await writeFile(
    join(cwd, '.ci', 'test-count-floors.json'),
    `${JSON.stringify({ floors, measurement }, null, 2)}\n`,
  )
}

async function makeStaleBranch(
  baseFloors: Floors,
  staleFloors: Floors,
  marker?: LoweringMarker,
) {
  const cwd = await mkdtemp(join(tmpdir(), 'test-count-floor-'))
  workspaces.push(cwd)

  runGit(cwd, ['init', '--initial-branch=main'])
  runGit(cwd, ['commit', '--allow-empty', '-m', 'seed measurement subject'])
  const staleMeasurementHead = runGit(cwd, ['rev-parse', 'HEAD'])
  await writeFloors(cwd, staleFloors, {
    head: staleMeasurementHead,
    dirtyPaths: 0,
  })
  runGit(cwd, ['add', '.ci/test-count-floors.json'])
  runGit(cwd, ['commit', '-m', 'record stale floors'])
  runGit(cwd, ['branch', 'stale'])

  if (JSON.stringify(baseFloors) !== JSON.stringify(staleFloors)) {
    await writeFloors(cwd, baseFloors, {
      head: runGit(cwd, ['rev-parse', 'HEAD']),
      dirtyPaths: 0,
    })
    runGit(cwd, ['add', '.ci/test-count-floors.json'])
    runGit(cwd, ['commit', '-m', 'raise main floor'])
  }
  runGit(cwd, ['checkout', 'stale'])

  if (marker) {
    await writeFile(
      join(cwd, '.ci', 'allow-test-count-floor-lowering.json'),
      `${JSON.stringify(marker, null, 2)}\n`,
    )
    runGit(cwd, ['add', '.ci/allow-test-count-floor-lowering.json'])
    runGit(cwd, ['commit', '-m', 'authorize floor lowering'])
  }

  return cwd
}

function runGate(cwd: string, counts: Floors, baseRef = 'main') {
  const result = Bun.spawnSync(
    [
      'bun',
      script,
      '--floor-file',
      '.ci/test-count-floors.json',
      '--base-ref',
      baseRef,
      '--counts',
      JSON.stringify(counts),
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    exitCode: result.exitCode,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
  }
}

function runGateWithCounts(cwd: string, counts: string, baseRef = 'main') {
  const result = Bun.spawnSync(
    [
      'bun',
      script,
      '--floor-file',
      '.ci/test-count-floors.json',
      '--base-ref',
      baseRef,
      '--counts',
      counts,
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    exitCode: result.exitCode,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
  }
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true })),
  )
})

test('passes when counts equal the branch floors', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGate(cwd, floors)

  expect(result.exitCode).toBe(0)
  expect(result.output).toContain(
    'VERDICT: PASS packages=core,opencode,pi (test counts and floor ratchet satisfied)',
  )
})

test('passes when counts exceed the branch floors', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGate(cwd, { core: 11, opencode: 21, pi: 31 })

  expect(result.exitCode).toBe(0)
  expect(result.output).toContain('VERDICT: PASS')
})

test('fails when a measured count falls below its branch floor', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGate(cwd, { core: 9, opencode: 20, pi: 30 })

  expect(result.exitCode).toBe(1)
  expect(result.output).toContain('core measured 9 < branch floor 10')
  expect(result.output).toContain('VERDICT: FAIL packages=core,opencode,pi')
})

test('fails when the branch floor is lower than the merge target floor', async () => {
  const cwd = await makeStaleBranch(
    { core: 11, opencode: 20, pi: 30 },
    { core: 10, opencode: 20, pi: 30 },
  )
  const result = runGate(cwd, { core: 10, opencode: 20, pi: 30 })

  expect(result.exitCode).toBe(1)
  expect(result.output).toContain(
    'core branch floor 10 < merge target floor 11',
  )
})

test('passes an explicit lowering marker that names the target floor', async () => {
  const cwd = await makeStaleBranch(
    { core: 11, opencode: 20, pi: 30 },
    { core: 10, opencode: 20, pi: 30 },
    {
      reason: 'The core suite intentionally removed obsolete coverage.',
      lowering: { core: { from: 11, to: 10 } },
    },
  )
  const result = runGate(cwd, { core: 10, opencode: 20, pi: 30 })

  expect(result.exitCode).toBe(0)
  expect(result.output).toContain('deliberate lowering authorized')
})

test('reports an unchecked non-zero verdict when the merge target is unavailable', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGate(cwd, floors, 'missing-target')

  expect(result.exitCode).toBe(2)
  expect(result.output).toContain('VERDICT: UNCHECKED packages=none')
})

test('reports an unchecked verdict when CI supplies an empty merge target', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGate(cwd, floors, '')

  expect(result.exitCode).toBe(2)
  expect(result.output).toContain('VERDICT: UNCHECKED packages=none')
})

test('reports an unchecked verdict for a floor stamped by an unrelated commit', async () => {
  const staleFloors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(
    { core: 11, opencode: 20, pi: 30 },
    staleFloors,
  )
  await writeFloors(cwd, staleFloors, {
    head: runGit(cwd, ['rev-parse', 'main']),
    dirtyPaths: 0,
  })
  const result = runGate(cwd, staleFloors)

  expect(result.exitCode).toBe(2)
  expect(result.output).toContain('VERDICT: UNCHECKED')
  expect(result.output).toContain('not an ancestor')
})

test('allows the gate to run from a dirty working tree', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  await writeFile(join(cwd, 'uncommitted-note'), 'local work is allowed\n')
  const result = runGate(cwd, floors)

  expect(result.exitCode).toBe(0)
  expect(result.output).toContain('VERDICT: PASS')
})

test('fails as a noncompliant source when the branch floor file is absent', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  await rm(join(cwd, '.ci', 'test-count-floors.json'))
  const result = runGate(cwd, floors)

  expect(result.exitCode).toBe(1)
  expect(result.output).toContain(
    'VERDICT: FAIL packages=none (NONCOMPLIANT SOURCE',
  )
})

test('rejects incomplete --counts input without claiming a measurement', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGateWithCounts(cwd, '{}')

  expect(result.exitCode).toBe(1)
  expect(result.output).toContain('VERDICT: FAIL packages=none')
  expect(result.output).toContain('--counts must contain exactly')
  expect(result.output).not.toContain('VERDICT: PASS')
})

test('replays a stale branch after main raises the floor and rejects the replay', async () => {
  const cwd = await makeStaleBranch(
    { core: 11, opencode: 20, pi: 30 },
    { core: 10, opencode: 20, pi: 30 },
  )
  const branch = Bun.spawnSync(['git', 'branch', '--show-current'], {
    cwd,
    stdout: 'pipe',
  })
  const result = runGate(cwd, { core: 10, opencode: 20, pi: 30 })

  expect(new TextDecoder().decode(branch.stdout).trim()).toBe('stale')
  expect(result.exitCode, result.output).toBe(1)
  expect(result.output).toContain(
    'core branch floor 10 < merge target floor 11',
  )
})

test('counts a zero-test suite as a real floor violation, not invalid CLI input', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGate(cwd, { core: 0, opencode: 20, pi: 30 })
  expect(result.exitCode).toBe(1)
  expect(result.output).toContain('core measured 0 < branch floor 10')
  expect(result.output).toContain('VERDICT: FAIL packages=core,opencode,pi')
})

test('rejects a branch that claims more tests than it actually has', async () => {
  const cwd = await makeStaleBranch(
    { core: 10, opencode: 20, pi: 30 },
    { core: 10, opencode: 25, pi: 30 },
  )
  const result = runGate(cwd, { core: 10, opencode: 22, pi: 30 })
  expect(result.exitCode).toBe(1)
  expect(result.output).toContain('opencode measured 22 < branch floor 25')
  expect(result.output).not.toContain('opencode branch floor 25 < merge target')
})

test('rejects a leftover lowering marker when no branch floor is lowered', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors, {
    reason: 'A previous branch lowered core, but this one does not.',
    lowering: { core: { from: 11, to: 10 } },
  })
  const result = runGate(cwd, floors)
  expect(result.exitCode).toBe(1)
  expect(result.output).toContain(
    'stale deliberate-lowering marker must be removed',
  )
})

test('CI and release each measure unit suites once and keep UNCHECKED blocking', async () => {
  const root = resolve(import.meta.dir, '..')
  const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8')
  const release = await readFile(
    join(root, '.github/workflows/release.yaml'),
    'utf8',
  )
  for (const workflow of [ci, release]) {
    expect(workflow).toContain('bun run check:workspace-lock')
    expect(workflow).toContain('bun run check:claustrum-golden')
    expect(workflow).not.toContain('--counts')
    expect(workflow).not.toContain('--floor-file')
    expect(workflow).not.toMatch(/run: bun run test\s*\n/)
    expect(workflow).toContain('bun run test:e2e')
    expect(workflow).not.toMatch(
      /check-test-count-floors\.ts[^\n]*\n\s*continue-on-error:/,
    )
    expect(workflow).toContain('bun run test:pi-host')
  }
  expect(ci).toContain('bun scripts/check-test-count-floors.ts --base-ref')
  expect(release).toContain(
    'bun scripts/check-test-count-floors.ts --release-ref',
  )
  expect(release).toContain('--release-version "$VERSION"')
  expect(release).toContain(
    'description: "Release tag to publish from, such as v1.24.0"\n        required: true',
  )
  expect(release).not.toContain('--base-ref HEAD^')
  const releaseScript = await readFile(join(root, 'scripts/release.sh'), 'utf8')
  const packedSmoke =
    'TUI_SMOKE_SKIP_BUILD=1 bun run --cwd packages/opencode smoke:tui'
  expect(releaseScript).toContain(packedSmoke)
  expect(releaseScript.indexOf(packedSmoke)).toBeLessThan(
    releaseScript.indexOf('git tag -a'),
  )
  expect(ci).toContain('fetch-depth: 0')
  expect(release).toContain('fetch-depth: 0')
})

function runReleaseGate(cwd: string, counts: Floors, version = '1.24.0') {
  const result = Bun.spawnSync(
    [
      'bun',
      script,
      '--release-ref',
      `v${version}`,
      '--release-version',
      version,
      '--counts',
      JSON.stringify(counts),
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    exitCode: result.exitCode,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
  }
}

async function makeReleaseHistory(
  priorFloors: Floors | null,
  currentFloors: Floors,
  marker?: LoweringMarker,
) {
  const cwd = await mkdtemp(join(tmpdir(), 'test-count-release-'))
  workspaces.push(cwd)
  runGit(cwd, ['init', '--initial-branch=main'])
  runGit(cwd, ['commit', '--allow-empty', '-m', 'seed measurement subject'])
  const head = runGit(cwd, ['rev-parse', 'HEAD'])
  if (priorFloors) {
    await writeFloors(cwd, priorFloors, { head, dirtyPaths: 0 })
    runGit(cwd, ['add', '.ci/test-count-floors.json'])
    runGit(cwd, ['commit', '-m', 'publish old floors'])
  }
  runGit(cwd, ['tag', '-a', 'v1.23.0', '-m', 'previous release'])
  await writeFloors(cwd, currentFloors, { head, dirtyPaths: 0 })
  runGit(cwd, ['add', '.ci/test-count-floors.json'])
  runGit(cwd, [
    'commit',
    '--allow-empty',
    '-m',
    'change floor before the release commit',
  ])
  if (marker) {
    await writeFile(
      join(cwd, '.ci', 'allow-test-count-floor-lowering.json'),
      `${JSON.stringify(marker, null, 2)}\n`,
    )
    runGit(cwd, ['add', '.ci/allow-test-count-floor-lowering.json'])
    runGit(cwd, ['commit', '-m', 'explain deliberate floor reduction'])
  }
  runGit(cwd, ['commit', '--allow-empty', '-m', 'release version bump'])
  runGit(cwd, ['tag', '-a', 'v1.24.0', '-m', 'new release'])
  return cwd
}

test('release compares with the last tag, not HEAD^, when floor lowered earlier', async () => {
  const current = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeReleaseHistory({ ...current, core: 11 }, current)
  // The old release gate was green because HEAD^ already carried the lower floor.
  expect(runGate(cwd, current, 'HEAD^').exitCode).toBe(0)
  const result = runReleaseGate(cwd, current)
  expect(result.exitCode, result.output).toBe(1)
  expect(result.output).toContain(
    'core branch floor 10 < release baseline floor 11',
  )
})

test('release permits only an explicitly reasoned reduction from its previous tag', async () => {
  const current = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeReleaseHistory({ ...current, core: 11 }, current, {
    reason: 'Obsolete tests removed after replacing the old custody transport.',
    lowering: { core: { from: 11, to: 10 } },
  })
  const result = runReleaseGate(cwd, current)
  expect(result.exitCode).toBe(0)
  expect(result.output).toContain('deliberate lowering authorized')
})

test('first floor-bearing release uses the verified cutover baseline, not zero', async () => {
  const baseline = { core: 290, opencode: 1672, pi: 140 }
  const cwd = await makeReleaseHistory(null, baseline)
  const result = runReleaseGate(cwd, baseline)
  expect(result.exitCode).toBe(0)
  expect(result.output).toContain('verified initial release baseline')
})

test('first floor-bearing release refuses a reduction below the verified cutover baseline', async () => {
  const baseline = { core: 290, opencode: 1672, pi: 140 }
  const current = { ...baseline, opencode: 1600 }
  const cwd = await makeReleaseHistory(null, current)
  const result = runReleaseGate(cwd, current)
  expect(result.exitCode, result.output).toBe(1)
  expect(result.output).toContain(
    'opencode branch floor 1600 < release baseline floor 1672',
  )
})

test('release refuses a floorless tag after the first floor-bearing release', async () => {
  const baseline = { core: 290, opencode: 1672, pi: 140 }
  const cwd = await makeReleaseHistory(null, baseline)
  runGit(cwd, ['commit', '--allow-empty', '-m', 'later release'])
  runGit(cwd, ['tag', '-a', 'v1.25.0', '-m', 'later release'])
  // A post-bootstrap tag with no recorded floor cannot silently reset the
  // provenance chain. Model this by tagging the floorless seed and retagging
  // v1.24.0 there in the isolated fixture only.
  runGit(cwd, [
    'tag',
    '-f',
    '-a',
    'v1.24.0',
    runGit(cwd, ['rev-parse', 'v1.23.0^{commit}']),
    '-m',
    'bad floorless release',
  ])
  const result = runReleaseGate(cwd, baseline, '1.25.0')
  expect(result.exitCode).toBe(2)
  expect(result.output).toContain('VERDICT: UNCHECKED packages=none')
})

test('release refuses a stale branch whose previous release tag is not its ancestor', async () => {
  const floors = { core: 290, opencode: 1672, pi: 140 }
  const cwd = await makeReleaseHistory(floors, floors)
  runGit(cwd, ['branch', 'stale', 'v1.23.0^'])
  runGit(cwd, ['checkout', 'stale'])
  await writeFloors(cwd, floors, {
    head: runGit(cwd, ['rev-parse', 'HEAD']),
    dirtyPaths: 0,
  })
  runGit(cwd, ['add', '.ci/test-count-floors.json'])
  runGit(cwd, ['commit', '-m', 'replay old branch'])
  runGit(cwd, ['tag', '-a', 'v1.25.0', '-m', 'stale release'])
  const result = runReleaseGate(cwd, floors, '1.25.0')
  expect(result.exitCode).toBe(2)
  expect(result.output).toContain('not an ancestor')
})

test('release refuses a branch checkout, mismatched dispatch version, and older tag', async () => {
  const floors = { core: 290, opencode: 1672, pi: 140 }
  const cwd = await makeReleaseHistory(floors, floors)
  runGit(cwd, ['commit', '--allow-empty', '-m', 'unreleased head'])
  const branch = runReleaseGate(cwd, floors)
  expect(branch.exitCode).toBe(2)
  expect(branch.output).toContain('release tag does not identify checkout HEAD')
  runGit(cwd, ['reset', '--hard', 'v1.24.0'])
  const mismatched = Bun.spawnSync(
    [
      'bun',
      script,
      '--release-ref',
      'v1.24.0',
      '--release-version',
      '1.24.1',
      '--counts',
      JSON.stringify(floors),
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  expect(mismatched.exitCode).toBe(2)
  expect(new TextDecoder().decode(mismatched.stderr)).toContain(
    'release version does not match checked-out tag',
  )
  runGit(cwd, ['reset', '--hard', 'v1.23.0'])
  const older = runReleaseGate(cwd, floors, '1.23.0')
  expect(older.exitCode).toBe(2)
  expect(older.output).toContain('not the latest release tag')
})

test('a stable release supersedes an earlier prerelease tag without losing the floor baseline', async () => {
  const floors = { core: 290, opencode: 1672, pi: 140 }
  const cwd = await makeReleaseHistory(floors, floors)
  runGit(cwd, [
    'tag',
    '-a',
    'v1.24.0-rc.1',
    'v1.23.0',
    '-m',
    'earlier prerelease',
  ])
  const result = runReleaseGate(cwd, floors)
  expect(result.exitCode).toBe(0)
  expect(result.output).toContain('VERDICT: PASS packages=core,opencode,pi')
})

test.each([
  { from: 291, code: 1, detail: 'core marker must declare from 290 to 289' },
  { from: 290, code: 0, detail: 'deliberate lowering authorized' },
])(
  'first release with floor lowering from $from requires exact baseline values',
  async ({ from, code, detail }) => {
    const lowered = { core: 289, opencode: 1672, pi: 140 }
    const cwd = await makeReleaseHistory(null, lowered, {
      reason: 'Retired obsolete custody tests.',
      lowering: { core: { from, to: 289 } },
    })
    const result = runReleaseGate(cwd, lowered)
    expect(result.exitCode).toBe(code)
    expect(result.output).toContain(detail)
  },
)

test('release refuses a repository with no previous version tag', async () => {
  const floors = { core: 290, opencode: 1672, pi: 140 }
  const cwd = await makeReleaseHistory(null, floors)
  runGit(cwd, ['tag', '-d', 'v1.23.0'])
  const result = runReleaseGate(cwd, floors)
  expect(result.exitCode).toBe(2)
  expect(result.output).toContain('no previous release tag to compare')
})

async function capturedCiFloorStep() {
  const ci = await readFile(
    resolve(import.meta.dir, '../.github/workflows/ci.yml'),
    'utf8',
  )
  expect(ci).toContain('push:\n    branches: [main]')
  const block = ci
    .split('      - name: Verify unit-count floors\n')[1]
    ?.split('\n      - ')[0]
  if (!block) throw new Error('Missing CI floor step')
  expect(block).toContain(
    `FLOOR_BASE_SHA: \${{ github.event.pull_request.base.sha || github.event.before }}`,
  )
  const run = block.split('        run: |\n')[1]
  if (!run) throw new Error('Missing CI floor shell')
  return run
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
}

test('CI floor shell refuses a zero, absent or malformed event base before measuring', async () => {
  const shell = await capturedCiFloorStep()
  for (const base of ['0'.repeat(40), '', 'not-a-commit']) {
    const result = Bun.spawnSync(
      ['bash', '-c', `bun() { echo FLOOR_CALLED; };\n${shell}`],
      {
        env: { ...process.env, FLOOR_BASE_SHA: base },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const text = new TextDecoder().decode(result.stdout)
    expect(result.exitCode).toBe(1)
    expect(text).toContain(
      'Unit-count floor verification requires a nonzero event base SHA.',
    )
    expect(text).not.toContain('FLOOR_CALLED')
  }
})

test('CI floor shell measures against the PR base or previous main tip', async () => {
  const shell = await capturedCiFloorStep()
  const prBase = 'a'.repeat(40)
  const previousMain = 'b'.repeat(40)
  for (const base of [prBase, previousMain]) {
    const result = Bun.spawnSync(
      ['bash', '-c', `bun() { printf '%s\\n' "$*"; };\n${shell}`],
      {
        env: { ...process.env, FLOOR_BASE_SHA: base },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout).trim()).toBe(
      `scripts/check-test-count-floors.ts --base-ref ${base}`,
    )
  }
})
