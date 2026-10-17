import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const MUTATION_RUNNER_VERSION = 'ckdev-mutate 0.12.5'
export const MUTATION_RUNNER_REVISION =
  'bd31bef35db3bd7b1c3f91b11409f927dd95283d'

const forceAllPaths = new Set([
  'scripts/run-mutation-bun.ts',
  'scripts/tests/run-mutation-bun.test.ts',
  'scripts/run-mutation-ci.ts',
  'scripts/tests/run-mutation-ci.test.ts',
  '.github/workflows/mutations.yml',
  'package.json',
  'bun.lock',
  'mise.toml',
  'tsconfig.scripts.json',
  'packages/core/package.json',
  'packages/core/bunfig.toml',
  'packages/core/src/tests/setup.ts',
  'packages/core/src/tests/test-lifetime.ts',
  'bunfig.toml',
  'packages/pi/package.json',
  'packages/pi/bunfig.toml',
  'packages/pi/src/tests/setup.ts',
])

export function mutationSelection(
  event: string,
  base: string | undefined,
  changedPaths: readonly string[],
): string[] {
  switch (event) {
    case 'pull_request':
      if (!base || !/^[a-f0-9]{40}$/.test(base))
        throw new Error('Pull-request base must be a full commit SHA')
      // The runner follows row targets, not helper dependencies. Changes to
      // the wrapper, its tests or shared test configuration need all rows.
      return changedPaths.some((path) => forceAllPaths.has(path))
        ? ['--all']
        : ['--diff', base]
    case 'push':
      return ['--all']
    case 'schedule':
    case 'workflow_dispatch':
      return ['--all', '--broad']
    default:
      throw new Error('Unsupported mutation workflow event')
  }
}

/**
 * Most rows one broad-audit shard replays. Each broad row reruns its whole
 * package suite, and OpenCode's takes about 4 to 6 minutes on a 4-vCPU Linux
 * runner, so three OpenCode rows plus that package's clean baseline stay under
 * about 25 minutes even in the worst grouping. The shard count grows with the
 * catalogue to keep this bound.
 */
export const BROAD_ROWS_PER_SHARD = 3

export function broadShardCount(rows: number) {
  if (!Number.isSafeInteger(rows) || rows < 1)
    throw new Error('The broad mutation audit needs catalogue rows')
  return Math.ceil(rows / BROAD_ROWS_PER_SHARD)
}

/**
 * One 1-based slice `index/count` of the job matrix that runs the scheduled
 * and manual `--broad` mutation audit.
 */
export interface MutationShard {
  index: number
  count: number
}

export function parseMutationShard(
  value: string | undefined,
): MutationShard | undefined {
  if (value === undefined || value === '') return undefined
  const match = /^([1-9][0-9]{0,2})\/([1-9][0-9]{0,2})$/.exec(value)
  const index = Number(match?.[1])
  const count = Number(match?.[2])
  if (!match || index > count)
    throw new Error('Mutation shard must be i/n with 1 <= i <= n')
  return { index, count }
}

/**
 * Runner arguments for the shard. Only the broad audit is split into jobs, and
 * it must be: run whole, it outlasts the job time limit. Pull-request and push
 * selections keep running unsharded in one job.
 */
export function shardArguments(
  selection: readonly string[],
  shard: MutationShard | undefined,
): string[] {
  if (!selection.includes('--broad')) {
    if (shard) throw new Error('Only the broad mutation audit is sharded')
    return []
  }
  if (!shard)
    throw new Error('The broad mutation audit must run as one matrix shard')
  return ['--shard', `${shard.index}/${shard.count}`]
}

// Rust's String ordering compares UTF-8 bytes; JavaScript's default sort
// compares UTF-16 code units, which differs for some non-ASCII text.
function compareUtf8(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/**
 * The catalogue IDs that ckdev-mutate 0.12.5 assigns to `run --all --shard i/n`
 * when no `--shard-weights` report is given: it sorts rows by ID and takes
 * every n-th row starting at position i - 1. Any row added to the catalogue
 * therefore lands in exactly one shard. The workflow never passes
 * `--shard-weights`, whose cost-based assignment this function cannot predict.
 */
export function shardRowIds(
  ids: readonly string[],
  shard: MutationShard,
): string[] {
  return [...ids]
    .sort(compareUtf8)
    .filter((_, position) => position % shard.count === shard.index - 1)
}

export function verifyMutationReport(
  value: unknown,
  selection: readonly string[],
  expectedIds: readonly string[],
) {
  if (!Array.isArray(value)) throw new Error('Mutation report must be an array')
  if (!value.length && !selection.includes('--diff'))
    throw new Error('Full mutation replay produced no rows')
  const expected = new Set(expectedIds)
  if (!expected.size || expected.size !== expectedIds.length)
    throw new Error('Invalid catalogue row IDs')
  const ids = new Set<string>()
  for (const entry of value) {
    const row: unknown = entry
    if (
      !row ||
      typeof row !== 'object' ||
      !('id' in row) ||
      !('outcome' in row) ||
      !('breadth_observed' in row) ||
      typeof row.id !== 'string' ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.outcome !== 'string' ||
      !row.outcome ||
      typeof row.breadth_observed !== 'boolean'
    )
      throw new Error('Malformed or duplicate mutation report row')
    if (
      !expected.has(row.id) ||
      !['CAUGHT', 'CAUGHT_BROADLY', 'HUB'].includes(row.outcome)
    )
      throw new Error('Unexpected or uncaught mutation row')
    if (row.outcome === 'CAUGHT_BROADLY' && !row.breadth_observed)
      throw new Error('Broad catch is missing breadth evidence')
    if (selection.includes('--broad') && !row.breadth_observed)
      throw new Error('Requested mutation breadth was not observed')
    ids.add(row.id)
  }
  if (selection.includes('--all') && ids.size !== expected.size)
    throw new Error('Full replay omitted catalogue rows')
  return value.length
}

/**
 * Checks the whole broad audit from its shard reports. Every shard must have
 * reported exactly its own rows, all caught with breadth observed, and the
 * shards together must cover every catalogue row once. Returns one line per
 * shard plus the problems found; no problems means the audit passed.
 */
export function verifyShardedAudit(
  reports: ReadonlyMap<number, unknown>,
  count: number,
  expectedIds: readonly string[],
): { lines: string[]; problems: string[] } {
  const selection = ['--all', '--broad']
  const lines: string[] = []
  const problems: string[] = []
  const rows: unknown[] = []
  for (const index of reports.keys())
    if (!Number.isInteger(index) || index < 1 || index > count)
      problems.push(`Unexpected report for mutation shard ${index}/${count}`)
  for (let index = 1; index <= count; index++) {
    const label = `shard ${index}/${count}`
    const expected = shardRowIds(expectedIds, { index, count })
    if (!reports.has(index)) {
      problems.push(`${label}: no report`)
      continue
    }
    const value = reports.get(index)
    const outcomes = new Map<string, number>()
    if (Array.isArray(value)) {
      rows.push(...value)
      for (const row of value) {
        const outcome =
          row && typeof row === 'object' && 'outcome' in row
            ? String(row.outcome)
            : 'MALFORMED'
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1)
      }
    }
    const tally = [...outcomes]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([outcome, total]) => `${total} ${outcome}`)
      .join(', ')
    lines.push(
      `${label}: ${expected.length} expected rows; reported ${tally || 'none'}`,
    )
    try {
      verifyMutationReport(value, selection, expected)
    } catch (error) {
      problems.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  try {
    verifyMutationReport(rows, selection, expectedIds)
  } catch (error) {
    problems.push(
      `all shards: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { lines, problems }
}

async function catalogueIds(): Promise<string[]> {
  const catalogue = Bun.TOML.parse(await readFile('mutations.toml', 'utf8'))
  if (!('control' in catalogue) || !Array.isArray(catalogue.control))
    throw new Error('Missing catalogue controls')
  return catalogue.control.map((entry: unknown) => {
    const control = entry
    if (
      !control ||
      typeof control !== 'object' ||
      !('id' in control) ||
      typeof control.id !== 'string'
    )
      throw new Error('Malformed catalogue control')
    return control.id
  })
}

/**
 * Reads the shard reports that the summary job downloaded into `directory`.
 * Each shard's run folder, which `replay` creates as `ci-*`, holds
 * `invocation.json` naming its shard and the runner's `rows.json`; a shard
 * that stopped before its report has no entry and is reported missing by
 * `verifyShardedAudit`. The uploaded artifact also holds the Bun wrapper's
 * `audits/named-*` and `audits/package-*` folders, whose own
 * `invocation.json` records one test command, not a shard, so only `ci-*`
 * folders are read.
 */
async function readShardReports(directory: string, count: number) {
  const reports = new Map<number, unknown>()
  const problems: string[] = []
  const glob = new Bun.Glob('**/ci-*/invocation.json')
  for await (const path of glob.scan({ cwd: directory, onlyFiles: true })) {
    const folder = dirname(resolve(directory, path))
    let shard: MutationShard | undefined
    try {
      const invocation: unknown = JSON.parse(
        await readFile(resolve(folder, 'invocation.json'), 'utf8'),
      )
      shard =
        invocation &&
        typeof invocation === 'object' &&
        'shard' in invocation &&
        typeof invocation.shard === 'string'
          ? parseMutationShard(invocation.shard)
          : undefined
    } catch {
      shard = undefined
    }
    if (!shard || shard.count !== count) {
      problems.push(`${path}: not a shard of a ${count}-shard audit`)
      continue
    }
    if (reports.has(shard.index)) {
      problems.push(`shard ${shard.index}/${count}: more than one report`)
      continue
    }
    try {
      reports.set(
        shard.index,
        JSON.parse(await readFile(resolve(folder, 'rows.json'), 'utf8')),
      )
    } catch {
      problems.push(
        `shard ${shard.index}/${count}: missing or invalid rows.json`,
      )
    }
  }
  return { reports, problems }
}

/**
 * Prints the broad audit's shard matrix and, in GitHub Actions, writes it as
 * the `count` and `shards` step outputs that the audit and summary jobs read.
 */
async function plan() {
  const count = broadShardCount((await catalogueIds()).length)
  const shards = JSON.stringify(
    Array.from({ length: count }, (_, index) => index + 1),
  )
  console.log(`Broad mutation audit: ${count} shards`)
  const output = process.env.GITHUB_OUTPUT
  if (output) await appendFile(output, `count=${count}\nshards=${shards}\n`)
}

async function summarize(directory: string | undefined) {
  const count = Number(process.env.MUTATION_SHARD_COUNT)
  if (!directory || !Number.isInteger(count) || count < 1 || count > 999)
    throw new Error(
      'Usage: MUTATION_SHARD_COUNT=<n> run-mutation-ci.ts --summarize <reports>',
    )
  const ids = await catalogueIds()
  if (count !== broadShardCount(ids.length))
    throw new Error('Shard count does not match the planned broad audit')
  const read = await readShardReports(resolve(directory), count)
  const audit = verifyShardedAudit(read.reports, count, ids)
  for (const line of audit.lines) console.log(line)
  const problems = [...read.problems, ...audit.problems]
  for (const problem of problems) console.error(problem)
  if (problems.length)
    throw new Error('Sharded mutation audit failed; see the shard reports')
  console.log(
    `Mutation audit passed: ${count} shards; every catalogue row caught with breadth observed`,
  )
}

function git(args: string[]): string {
  const child = Bun.spawnSync(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (child.exitCode !== 0 || child.signalCode)
    throw new Error('Cannot verify committed mutation input')
  return child.stdout.toString()
}

async function replay() {
  if (process.env.GITHUB_ACTIONS !== 'true')
    throw new Error(
      'Mutation CI must run in an isolated GitHub Actions checkout',
    )
  const event = process.env.MUTATION_EVENT ?? ''
  const base = process.env.MUTATION_BASE
  git(['diff', '--exit-code', 'HEAD', '--'])
  const changed =
    event === 'pull_request'
      ? git([
          'diff',
          '--name-only',
          '-z',
          base && /^[a-f0-9]{40}$/.test(base) ? base : 'INVALID_BASE',
          'HEAD',
          '--',
        ])
          .split('\0')
          .filter(Boolean)
      : []
  const selection = mutationSelection(event, base, changed)
  const shard = parseMutationShard(process.env.MUTATION_SHARD)
  const sharding = shardArguments(selection, shard)
  const version = Bun.spawnSync(['ckdev-mutate', '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (
    version.exitCode !== 0 ||
    version.signalCode ||
    version.stdout.toString().trim() !== MUTATION_RUNNER_VERSION
  )
    throw new Error(
      'Installed mutation runner does not match the pinned version',
    )
  const directory = resolve('tmp/mutations')
  await mkdir(directory, { recursive: true })
  const artifact = await mkdtemp(resolve(directory, 'ci-'))
  const report = resolve(artifact, 'rows.json')
  const argv = [
    'ckdev-mutate',
    'run',
    ...selection,
    ...sharding,
    '--report',
    report,
  ]
  await writeFile(
    resolve(artifact, 'invocation.json'),
    JSON.stringify(
      {
        event,
        base,
        changed,
        argv,
        runnerRevision: MUTATION_RUNNER_REVISION,
        // Read by the summary job to match this report to its shard.
        shard: shard ? `${shard.index}/${shard.count}` : undefined,
      },
      null,
      2,
    ),
  )
  const child = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit' })
  const status = await child.exited
  await writeFile(
    resolve(artifact, 'status.json'),
    JSON.stringify({ exitCode: status, signal: child.signalCode }),
  )
  if (status !== 0 || child.signalCode)
    throw new Error('Mutation runner failed; inspect retained logs and report')
  let value: unknown
  try {
    value = JSON.parse(await readFile(report, 'utf8'))
  } catch {
    throw new Error('Missing or invalid mutation JSON report')
  }
  const catalogue = await catalogueIds()
  const expectedIds = shard ? shardRowIds(catalogue, shard) : catalogue
  const rows = verifyMutationReport(value, selection, expectedIds)
  console.log(
    `Mutation CI passed: ${rows} selected rows${shard ? ` in shard ${shard.index}/${shard.count}` : ''}; breadth ${selection.includes('--broad') ? 'observed' : 'not requested'}`,
  )
}

if (import.meta.main) {
  try {
    if (Bun.version !== '1.3.14')
      throw new Error('Mutation CI requires Bun 1.3.14')
    if (process.argv[2] === '--summarize') await summarize(process.argv[3])
    else if (process.argv[2] === '--plan' && process.argv.length === 3)
      await plan()
    else if (process.argv.length > 2)
      throw new Error('Unexpected mutation CI arguments')
    else await replay()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Mutation CI failed')
    process.exitCode = 1
  }
}
