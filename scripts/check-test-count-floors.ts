import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const packageNames = ['core', 'opencode', 'pi'] as const
// The first release with test floors follows v1.23.0, whose tag had no floor
// document. These counts were independently verified on the clean CI runner
// (run 35908244749, commit 379fb64f). Never treat a missing earlier floor as
// zero, or a future floorless release tag as a new bootstrap opportunity.
const FIRST_FLOORLESS_RELEASE_TAG = 'v1.23.0'
const VERIFIED_INITIAL_RELEASE_FLOORS = {
  core: 290,
  opencode: 1672,
  pi: 140,
} as const
type PackageName = (typeof packageNames)[number]
type Floors = Record<PackageName, number>

type LoweringMarker = {
  reason: string
  lowering: Partial<Record<PackageName, { from: number; to: number }>>
}

type FloorDocument = {
  floors: Floors
  measurement: {
    head: string
    dirtyPaths: number
  }
}

type Options = {
  baseRef?: string
  releaseRef?: string
  releaseVersion?: string
  counts?: Floors
  floorFile: string
}

const decoder = new TextDecoder()

function packageScope(value: object | undefined): string {
  const packages = value ? Object.keys(value).sort() : []
  return packages.length > 0 ? packages.join(',') : 'none'
}

function verdict(status: string, scope: string, detail: string): string {
  return `VERDICT: ${status} packages=${scope} (${detail})`
}

function fail(message: string): never {
  throw new Error(message)
}

function parseFloors(raw: string, source: string, allowZero = false): Floors {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`${source} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${source} must be an object`)
  }

  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(',') !== [...packageNames].sort().join(',')) {
    fail(`${source} must contain exactly: ${packageNames.join(', ')}`)
  }

  const floors = {} as Floors
  for (const packageName of packageNames) {
    const value = record[packageName]
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < (allowZero ? 0 : 1)
    ) {
      fail(
        `${source}.${packageName} must be a ${allowZero ? 'non-negative' : 'positive'} integer`,
      )
    }
    floors[packageName] = value
  }
  return floors
}

function parseFloorDocument(raw: string, source: string): FloorDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`${source} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${source} must be an object`)
  }

  const document = parsed as { floors?: unknown; measurement?: unknown }
  if (!document.floors || typeof document.floors !== 'object') {
    fail(`${source}.floors must be an object`)
  }
  if (!document.measurement || typeof document.measurement !== 'object') {
    fail(`${source}.measurement must be an object`)
  }
  const measurement = document.measurement as {
    head?: unknown
    dirtyPaths?: unknown
  }
  if (
    typeof measurement.head !== 'string' ||
    !/^[0-9a-f]{40}$/.test(measurement.head)
  ) {
    fail(`${source}.measurement.head must be a 40-hex SHA`)
  }
  const dirtyPaths = measurement.dirtyPaths
  if (
    typeof dirtyPaths !== 'number' ||
    !Number.isSafeInteger(dirtyPaths) ||
    dirtyPaths < 0
  ) {
    fail(`${source}.measurement.dirtyPaths must be a non-negative integer`)
  }
  return {
    floors: parseFloors(JSON.stringify(document.floors), `${source}.floors`),
    measurement: {
      head: measurement.head,
      dirtyPaths,
    },
  }
}

function parseOptions(args: string[]): Options {
  const options: Options = { floorFile: '.ci/test-count-floors.json' }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      fail(`missing value for ${flag}`)
    }

    if (flag === '--base-ref') options.baseRef = value
    else if (flag === '--release-ref') options.releaseRef = value
    else if (flag === '--release-version') options.releaseVersion = value
    else if (flag === '--counts')
      options.counts = parseFloors(value, '--counts', true)
    else if (flag === '--floor-file') options.floorFile = value
    else fail(`unknown argument: ${flag}`)
    index += 1
  }
  if (isAbsolute(options.floorFile))
    fail('--floor-file must be relative to the repository root')
  if (options.baseRef !== undefined && options.releaseRef !== undefined) {
    fail('choose either --base-ref (PR) or --release-ref (release), not both')
  }
  if (
    options.releaseVersion !== undefined &&
    options.releaseRef === undefined
  ) {
    fail('--release-version requires --release-ref')
  }
  return options
}

async function readFloorDocument(floorFile: string): Promise<FloorDocument> {
  return parseFloorDocument(await readFile(floorFile, 'utf8'), floorFile)
}

function readMergeTargetFloors(
  baseRef: string,
  floorFile: string,
): FloorDocument | undefined {
  const result = Bun.spawnSync(['git', 'show', `${baseRef}:${floorFile}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return undefined
  return parseFloorDocument(
    decoder.decode(result.stdout),
    `${baseRef}:${floorFile}`,
  )
}

type ReleaseBaseline = {
  baseRef: string
  floors: Floors
  document?: FloorDocument
  initial: boolean
}

function gitOutput(args: string[]): string | undefined {
  const result = Bun.spawnSync(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return result.exitCode === 0
    ? decoder.decode(result.stdout).trim()
    : undefined
}

function compareReleaseTags(left: string, right: string): number {
  const parts = (tag: string) => {
    const match =
      /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        tag,
      )
    if (!match) throw new Error('Invalid release tag')
    return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') }
  }
  const a = parts(left)
  const b = parts(right)
  for (let i = 0; i < 3; i++) {
    const x = a.core[i]
    const y = b.core[i]
    if (x === undefined || y === undefined)
      throw new Error('Invalid release tag')
    if (x !== y) return x > y ? 1 : -1
  }
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xNumeric = /^(0|[1-9]\d*)$/.test(x)
    const yNumeric = /^(0|[1-9]\d*)$/.test(y)
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

function releaseTags(mergedRef?: string): string[] | undefined {
  const args = ['tag', '--list', 'v*']
  if (mergedRef) args.push('--merged', mergedRef)
  const listed = gitOutput(args)
  if (listed === undefined) return undefined
  // Git's version sort puts `v1.24.0-rc.1` after `v1.24.0` in descending
  // order. SemVer precedence does the opposite; preserve that distinction so
  // a prerelease cannot accidentally become the comparison baseline.
  return listed
    .split('\n')
    .filter((tag) =>
      /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag),
    )
    .sort((a, b) => compareReleaseTags(b, a))
}

function stableReleaseTags(tags: string[]): string[] {
  return tags.filter((tag) => /^v\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(tag))
}

function readReleaseBaseline(
  previousTag: string,
  floorFile: string,
): ReleaseBaseline | string {
  let document: FloorDocument | undefined
  try {
    document = readMergeTargetFloors(previousTag, floorFile)
  } catch {
    return `could not validate release baseline ${previousTag}:${floorFile}`
  }
  if (document)
    return {
      baseRef: previousTag,
      floors: document.floors,
      document,
      initial: false,
    }
  if (previousTag !== FIRST_FLOORLESS_RELEASE_TAG) {
    return `previous release tag ${previousTag} has no floor document`
  }
  return {
    baseRef: previousTag,
    floors: { ...VERIFIED_INITIAL_RELEASE_FLOORS },
    initial: true,
  }
}

function resolveMergeTargetReleaseBaseline(
  baseRef: string,
  floorFile: string,
): ReleaseBaseline | string | undefined {
  const listed = releaseTags(baseRef)
  if (!listed) return 'could not inspect release tags'
  const tags = stableReleaseTags(listed)
  const latestTag = tags[0]
  // Before the first stable release, use the merge target's test-count floors
  // as the baseline.
  if (!latestTag) return undefined
  if (tags.slice(1).some((tag) => compareReleaseTags(tag, latestTag) === 0)) {
    return 'ambiguous release tags have equal version precedence'
  }
  return readReleaseBaseline(latestTag, floorFile)
}

function resolveReleaseBaseline(
  releaseRef: string,
  releaseVersion: string | undefined,
  floorFile: string,
): ReleaseBaseline | string {
  if (
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      releaseRef,
    )
  ) {
    return 'release ref must be a version tag'
  }
  if (releaseVersion !== releaseRef.slice(1)) {
    return 'release version does not match checked-out tag'
  }
  const tags = releaseTags()
  if (!tags) return 'could not inspect release tags'
  if (tags[0] !== releaseRef) return 'release ref is not the latest release tag'
  if (tags.slice(1).some((tag) => compareReleaseTags(tag, releaseRef) === 0)) {
    return 'ambiguous release tags have equal version precedence'
  }
  const tagCommit = gitOutput([
    'rev-parse',
    '--verify',
    `${releaseRef}^{commit}`,
  ])
  const head = gitOutput(['rev-parse', '--verify', 'HEAD'])
  if (!head || !tagCommit || head !== tagCommit) {
    return 'release tag does not identify checkout HEAD'
  }
  const previousTag = stableReleaseTags(tags.slice(1))[0]
  if (!previousTag) return 'no previous release tag to compare'
  const ancestry = Bun.spawnSync(
    ['git', 'merge-base', '--is-ancestor', previousTag, 'HEAD'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if (ancestry.exitCode !== 0) {
    return `previous release tag ${previousTag} is not an ancestor of ${releaseRef}`
  }
  return readReleaseBaseline(previousTag, floorFile)
}

function stampError(
  document: FloorDocument,
  subject: string,
  label: string,
): string | undefined {
  if (document.measurement.dirtyPaths !== 0) {
    return `${label} floor was measured with ${document.measurement.dirtyPaths} dirty paths`
  }
  const result = Bun.spawnSync(
    ['git', 'merge-base', '--is-ancestor', document.measurement.head, subject],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if (result.exitCode === 0) return undefined
  if (result.exitCode === 1) {
    return `${label} measurement head ${document.measurement.head} is not an ancestor of ${subject}`
  }
  return `could not validate ${label} measurement head ${document.measurement.head} against ${subject}`
}

async function readLoweringMarker(): Promise<LoweringMarker | undefined> {
  const markerFile = '.ci/allow-test-count-floor-lowering.json'
  if (!existsSync(markerFile)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(markerFile, 'utf8'))
  } catch {
    fail(`${markerFile} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${markerFile} must be an object`)
  }

  const marker = parsed as {
    reason?: unknown
    lowering?: unknown
  }
  if (typeof marker.reason !== 'string' || marker.reason.trim().length === 0) {
    fail(`${markerFile}.reason must be a non-empty string`)
  }
  if (
    !marker.lowering ||
    typeof marker.lowering !== 'object' ||
    Array.isArray(marker.lowering)
  ) {
    fail(`${markerFile}.lowering must be an object`)
  }

  const lowering = marker.lowering as Record<string, unknown>
  const parsedLowering: LoweringMarker['lowering'] = {}
  for (const [packageName, values] of Object.entries(lowering)) {
    if (!packageNames.includes(packageName as PackageName)) {
      fail(`${markerFile}.lowering has an unknown package: ${packageName}`)
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      fail(`${markerFile}.lowering.${packageName} must be an object`)
    }
    const { from, to } = values as { from?: unknown; to?: unknown }
    if (
      typeof from !== 'number' ||
      typeof to !== 'number' ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to)
    ) {
      fail(
        `${markerFile}.lowering.${packageName} requires integer from and to values`,
      )
    }
    parsedLowering[packageName as PackageName] = { from, to }
  }
  return { reason: marker.reason, lowering: parsedLowering }
}

function markerError(
  marker: LoweringMarker | undefined,
  lowered: PackageName[],
  branchFloors: Floors,
  targetFloors: Floors,
): string | undefined {
  if (!marker) return 'no deliberate-lowering marker'

  const marked = Object.keys(marker.lowering).sort()
  if (marked.join(',') !== [...lowered].sort().join(',')) {
    return `marker must name exactly: ${lowered.join(', ')}`
  }
  for (const packageName of lowered) {
    const entry = marker.lowering[packageName]
    if (
      !entry ||
      entry.from !== targetFloors[packageName] ||
      entry.to !== branchFloors[packageName]
    ) {
      return `${packageName} marker must declare from ${targetFloors[packageName]} to ${branchFloors[packageName]}`
    }
  }
  return undefined
}

function measureTests(): Floors {
  const commands: Record<PackageName, string[]> = {
    core: ['bun', 'test', 'src/tests'],
    opencode: ['bun', 'test', 'src/tests'],
    pi: ['bun', 'test', 'src/tests'],
  }
  const floors = {} as Floors

  for (const packageName of packageNames) {
    console.log(`MEASURE: ${packageName}`)
    const result = Bun.spawnSync(commands[packageName], {
      cwd: join('packages', packageName),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`
    if (result.exitCode !== 0) {
      process.stdout.write(output)
      fail(`${packageName} test command exited ${result.exitCode}`)
    }
    const match = output.match(/^\s*(\d+) pass\s*$/m)
    if (!match) fail(`could not parse ${packageName} test count`)
    floors[packageName] = Number(match[1])
    console.log(`MEASURED: ${packageName} ${floors[packageName]}`)
  }
  return floors
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  let branchDocument: FloorDocument
  try {
    branchDocument = await readFloorDocument(options.floorFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(
        verdict(
          'FAIL',
          'none',
          `NONCOMPLIANT SOURCE: branch floor file is missing: ${options.floorFile}`,
        ),
      )
      process.exitCode = 1
      return
    }
    throw error
  }
  if (!options.baseRef && !options.releaseRef) {
    console.error(
      verdict('UNCHECKED', 'none', 'comparison ref was not provided'),
    )
    process.exitCode = 2
    return
  }

  let targetFloors: Floors
  let targetDocument: FloorDocument | undefined
  let targetRef: string
  let targetLabel: string
  let releaseBaseline: ReleaseBaseline | undefined
  if (options.releaseRef) {
    const release = resolveReleaseBaseline(
      options.releaseRef,
      options.releaseVersion,
      options.floorFile,
    )
    if (typeof release === 'string') {
      console.error(verdict('UNCHECKED', 'none', release))
      process.exitCode = 2
      return
    }
    targetFloors = release.floors
    targetDocument = release.document
    targetRef = release.baseRef
    targetLabel = 'release baseline'
    releaseBaseline = release
  } else {
    targetRef = options.baseRef as string
    targetDocument = readMergeTargetFloors(targetRef, options.floorFile)
    if (!targetDocument) {
      console.error(
        verdict(
          'UNCHECKED',
          'none',
          `could not resolve merge target floor ${targetRef}:${options.floorFile}`,
        ),
      )
      process.exitCode = 2
      return
    }
    targetFloors = targetDocument.floors
    targetLabel = 'merge target'
    const release = resolveMergeTargetReleaseBaseline(
      targetRef,
      options.floorFile,
    )
    if (typeof release === 'string') {
      console.error(verdict('UNCHECKED', 'none', release))
      process.exitCode = 2
      return
    }
    releaseBaseline = release
  }

  const branchStampError = stampError(branchDocument, 'HEAD', 'branch')
  if (branchStampError) {
    console.error(verdict('UNCHECKED', 'none', branchStampError))
    process.exitCode = 2
    return
  }
  if (targetDocument) {
    const targetStampError = stampError(targetDocument, targetRef, targetLabel)
    if (targetStampError) {
      console.error(verdict('UNCHECKED', 'none', targetStampError))
      process.exitCode = 2
      return
    }
  }
  if (releaseBaseline?.document && releaseBaseline.baseRef !== targetRef) {
    const releaseStampError = stampError(
      releaseBaseline.document,
      releaseBaseline.baseRef,
      'release baseline',
    )
    if (releaseStampError) {
      console.error(verdict('UNCHECKED', 'none', releaseStampError))
      process.exitCode = 2
      return
    }
  }
  if (releaseBaseline?.initial) {
    console.log(
      `BASELINE: verified initial release baseline after ${releaseBaseline.baseRef}`,
    )
  }

  const counts = options.counts ?? measureTests()
  const scope = packageScope(counts)
  const branchFloors = branchDocument.floors
  const failures: string[] = []
  for (const packageName of packageNames) {
    if (counts[packageName] < branchFloors[packageName]) {
      failures.push(
        `COUNT: ${packageName} measured ${counts[packageName]} < branch floor ${branchFloors[packageName]}`,
      )
    } else {
      console.log(
        `COUNT: ${packageName} measured ${counts[packageName]} >= branch floor ${branchFloors[packageName]}`,
      )
    }
  }

  // A lowering survives merges until a stable release ships it. The moving
  // merge target still forbids dropping unshipped additions to the floors.
  const baselineFloors = releaseBaseline?.floors ?? targetFloors
  const baselineLabel = releaseBaseline ? 'release baseline' : targetLabel
  const lowered = packageNames.filter(
    (packageName) => branchFloors[packageName] < baselineFloors[packageName],
  )
  const marker = await readLoweringMarker()
  const invalidMarker = markerError(
    marker,
    lowered,
    branchFloors,
    baselineFloors,
  )
  if (marker && lowered.length === 0) {
    failures.push('RATCHET: stale deliberate-lowering marker must be removed')
  }
  for (const packageName of packageNames) {
    if (branchFloors[packageName] >= targetFloors[packageName]) {
      console.log(
        `RATCHET: ${packageName} branch floor ${branchFloors[packageName]} >= ${targetLabel} floor ${targetFloors[packageName]}`,
      )
    } else if (!lowered.includes(packageName)) {
      failures.push(
        `RATCHET: ${packageName} branch floor ${branchFloors[packageName]} < ${targetLabel} floor ${targetFloors[packageName]} (not below ${baselineLabel} floor ${baselineFloors[packageName]})`,
      )
    }
  }
  if (lowered.length > 0 && invalidMarker) {
    for (const packageName of lowered) {
      failures.push(
        `RATCHET: ${packageName} branch floor ${branchFloors[packageName]} < ${baselineLabel} floor ${baselineFloors[packageName]} (${invalidMarker})`,
      )
    }
  } else if (lowered.length > 0 && marker) {
    for (const packageName of lowered) {
      console.log(
        `RATCHET: ${packageName} branch floor ${branchFloors[packageName]} < ${baselineLabel} floor ${baselineFloors[packageName]}; deliberate lowering authorized: ${marker.reason}`,
      )
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure)
    console.error(verdict('FAIL', scope, 'test-count floor check failed'))
    process.exitCode = 1
    return
  }
  console.log(verdict('PASS', scope, 'test counts and floor ratchet satisfied'))
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  console.error(
    verdict('FAIL', 'none', 'test-count floor check rejected invalid input'),
  )
  process.exitCode = 1
}
