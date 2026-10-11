import { expect, test } from 'bun:test'
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import {
  createTestLifetimeSuite,
  TestLifetime,
} from '../../packages/core/src/tests/test-lifetime.ts'
import {
  createMutationSandbox,
  type ExecutionEvent,
  exactPattern,
  executedCount,
  normalizeReport,
  type OwnedChild,
  packageSelection,
  parseExecution,
  runPackage,
  runTest,
  selectionFor,
  type Transcript,
  testEnvironment,
} from '../run-mutation-bun'

const file = 'packages/core/src/tests/fast.test.ts'
const name = 'fast mode eligibility for claude-opus-4-7[1m] is false'
const apiFile = 'packages/pi/src/tests/convert.test.ts'
const apiName =
  'buildAnthropicRequest — Fable/Mythos thinking > does not add Fable 5.1 binding controls to an API-key request'
const header = 'bun test v1.3.14 (0d9b296a)\n'

test('sandboxes import-time defaults and refuses inherited host path overrides', () => {
  const inherited = {
    PATH: '/toolchain',
    HOME: '/real-home',
    TMPDIR: '/real-tmp',
    OPENCODE_ANTHROPIC_AUTH_FILE: '/real-auth',
    OPENCODE_ANTHROPIC_AUTH_DUMP: '1',
    PI_ANTHROPIC_AUTH_FILE: '/real-pi-auth',
    PI_ANTHROPIC_AUTH_UNKNOWN_FILE: '/real-extra',
  }
  const env = testEnvironment('/sandbox', inherited)
  expect(env.HOME).toBe('/sandbox')
  expect(env.OPENCODE_ANTHROPIC_AUTH_FILE).toBe(
    '/sandbox/OPENCODE_ANTHROPIC_AUTH_FILE',
  )
  expect(env.PI_ANTHROPIC_AUTH_FILE).toBe('/sandbox/PI_ANTHROPIC_AUTH_FILE')
  expect(env.OPENCODE_ANTHROPIC_AUTH_DUMP).toBeUndefined()
  expect(env.PI_ANTHROPIC_AUTH_UNKNOWN_FILE).toBeUndefined()
  expect(env.PATH).toBe('/toolchain')
  expect(inherited.HOME).toBe('/real-home')
})
function green(selectedName = name): Transcript {
  return {
    stdout: header,
    stderr: `\nsrc/tests/fast.test.ts:\n(pass) ${selectedName} [4.73ms]\n\n 1 pass\n 8 filtered out\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [87.00ms]\n`,
    exitCode: 0,
    signal: null,
  }
}
function red(): Transcript {
  return {
    stdout: header,
    stderr: `\nsrc/tests/fast.test.ts:\n16 | expect(isFastModeSupportedModel(model)).toBe(expected)\n                                              ^\nerror: expect(received).toBe(expected)\n\nExpected: false\nReceived: true\n\n      at <anonymous> (/checkout/packages/core/src/tests/fast.test.ts:16:43)\n(fail) ${name} [2.11ms]\n\n 0 pass\n 1 fail\n 1 expect() calls\nRan 1 test across 1 file. [110.00ms]\n`,
    exitCode: 1,
    signal: null,
  }
}

test('accepts the real pinned baseline and assertion-failure summary shapes', () => {
  expect(executedCount(name, green())).toBe(1)
  expect(executedCount(name, red())).toBe(1)
})

test('package snapshot summaries still require a verified assertion count', () => {
  const fixture = green()
  fixture.stderr = fixture.stderr.replace(
    ' 1 expect() calls',
    ' 8 snapshots, 1 expect() calls',
  )
  expect(parseExecution(undefined, fixture).count).toBe(1)
  for (const summary of [
    ' 8 snapshots',
    ' 8 snapshots, 0 expect() calls',
    ' 8 snapshots, expect() calls',
  ]) {
    expect(() =>
      parseExecution(undefined, {
        ...fixture,
        stderr: fixture.stderr.replace(
          ' 8 snapshots, 1 expect() calls',
          summary,
        ),
      }),
    ).toThrow()
  }
})

test('anchors literal punctuation and keeps Bun filter/display names distinct', () => {
  const regex = new RegExp(exactPattern(name))
  expect(regex.test(name)).toBe(true)
  expect(regex.test(name.replace('[1m]', '1m'))).toBe(false)
  expect(regex.test(`prefix ${name}`)).toBe(false)
  expect(regex.test(`${name} suffix`)).toBe(false)
  const api = selectionFor(apiFile, apiName)
  expect(api.name).toBe(
    'buildAnthropicRequest — Fable/Mythos thinking > does not add Fable 5.1 binding controls to an API-key request',
  )
  expect(api.filterName).toBe(
    'buildAnthropicRequest — Fable/Mythos thinking does not add Fable 5.1 binding controls to an API-key request',
  )
  const punctuation = 'scope (a+b)? [x] {2} ^$ . | \\ /'
  expect(new RegExp(exactPattern(punctuation)).test(punctuation)).toBe(true)
})

test('accepts the header and summary on either pipe, including CRLF', () => {
  const fixture = red()
  expect(
    executedCount(name, {
      ...fixture,
      stdout: fixture.stderr.replaceAll('\n', '\r\n'),
      stderr: header,
    }),
  ).toBe(1)
})

const invalid: { label: string; transcript: Transcript }[] = [
  {
    label: 'zero tests',
    transcript: {
      ...green(),
      stderr: ' 0 pass\n 0 fail\nRan 0 tests across 1 file. [2.00ms]\n',
    },
  },
  {
    label: 'ambiguous total',
    transcript: {
      ...green(),
      stderr: `${green().stderr}Ran 1 test across 1 file. [2.00ms]\n`,
    },
  },
  {
    label: 'mismatched total',
    transcript: {
      ...green(),
      stderr: green().stderr.replace('Ran 1 test', 'Ran 2 tests'),
    },
  },
  {
    label: 'mismatched pass count',
    transcript: {
      ...green(),
      stderr: green().stderr.replace(' 1 pass', ' 2 pass'),
    },
  },
  {
    label: 'ambiguous pass count',
    transcript: { ...green(), stderr: `${green().stderr} 1 pass\n` },
  },
  {
    label: 'multiple files',
    transcript: {
      ...green(),
      stderr: green().stderr.replace('1 file.', '2 files.'),
    },
  },
  {
    label: 'unrelated failing test',
    transcript: {
      ...red(),
      stderr: red().stderr.replace(`(fail) ${name}`, '(fail) unrelated guard'),
    },
  },
  {
    label: 'extra failing test',
    transcript: {
      ...red(),
      stderr: `${red().stderr}(fail) unrelated guard [1.00ms]\n`,
    },
  },
  { label: 'wrong child status', transcript: { ...red(), exitCode: 0 } },
  {
    label: 'compilation failure with assertion-looking source',
    transcript: {
      ...red(),
      stderr: `${red().stderr}error: Unexpected token\n`,
    },
  },
  {
    label: 'import failure with assertion-looking source',
    transcript: {
      ...red(),
      stderr: `${red().stderr}error: Cannot find module missing.ts\n`,
    },
  },
  {
    label: 'runtime failure',
    transcript: {
      ...red(),
      stderr: red().stderr.replace(
        'error: expect(received).toBe(expected)',
        'TypeError: not a function',
      ),
    },
  },
  {
    label: 'hook error after assertion',
    transcript: {
      ...red(),
      stderr: `${red().stderr}error: afterEach failed\n`,
    },
  },
  {
    label: 'hook error summary',
    transcript: { ...red(), stderr: `${red().stderr} 1 error\n` },
  },
  {
    label: 'test timeout',
    transcript: {
      ...red(),
      stderr: `${red().stderr}Test timed out after 5000ms\n`,
    },
  },
  {
    label: 'hook timeout',
    transcript: {
      ...red(),
      stderr: `${red().stderr}beforeEach hook timed out\n`,
    },
  },
  {
    label: 'unhandled error',
    transcript: { ...red(), stderr: `${red().stderr}Unhandled rejection\n` },
  },
  { label: 'signal death', transcript: { ...red(), signal: 'SIGSEGV' } },
  { label: 'crash status', transcript: { ...red(), exitCode: 139 } },
  {
    label: 'refused child invocation',
    transcript: { ...red(), exitCode: 126 },
  },
  {
    label: 'missing executable status',
    transcript: { ...red(), exitCode: 127 },
  },
  {
    label: 'absent assertion',
    transcript: {
      ...red(),
      stderr: red().stderr.replace(
        'error: expect(received).toBe(expected)',
        '',
      ),
    },
  },
  {
    label: 'zero assertions',
    transcript: {
      ...green(),
      stderr: green().stderr.replace('1 expect()', '0 expect()'),
    },
  },
  {
    label: 'skipped result',
    transcript: {
      ...green(),
      stderr: green().stderr.replace('(pass)', '(skip)'),
    },
  },
  {
    label: 'skipped count',
    transcript: { ...green(), stderr: `${green().stderr} 1 skip\n` },
  },
  { label: 'missing version', transcript: { ...green(), stdout: '' } },
  {
    label: 'unpinned version',
    transcript: { ...green(), stdout: header.replace('1.3.14', '1.3.13') },
  },
  {
    label: 'ambiguous version',
    transcript: { ...green(), stdout: `${header}${header}` },
  },
  {
    label: 'spoofed wrapper count',
    transcript: { ...green(), stdout: `${header}CKDEV executed 1 tests\n` },
  },
]
for (const { label, transcript } of invalid) {
  test(`refuses ${label} instead of counting an assertion-looking transcript`, () => {
    expect(() => executedCount(name, transcript)).toThrow()
  })
}

function bytes(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const buffer = Buffer.from(text)
      // Split within UTF-8 as well as line boundaries, retaining original bytes.
      for (const byte of buffer) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
}
function childFor(transcript: Transcript): OwnedChild {
  return {
    stdout: bytes(transcript.stdout),
    stderr: bytes(transcript.stderr),
    exited: Promise.resolve(transcript.exitCode),
    signalCode: transcript.signal,
    kill: () => {
      throw new Error('Completed fixture must not be killed')
    },
  }
}
function sinks() {
  const stdout: Uint8Array[] = []
  const stderr: Uint8Array[] = []
  return {
    out: () => Buffer.concat(stdout).toString('utf8'),
    err: () => Buffer.concat(stderr).toString('utf8'),
    stdout: (chunk: Uint8Array) => {
      stdout.push(chunk)
    },
    stderr: (chunk: Uint8Array) => {
      stderr.push(chunk)
    },
  }
}

test('preserves raw bytes on their original pipes and the genuine child status', async () => {
  for (const transcript of [green(), red()]) {
    const output = sinks()
    let argv: string[] = []
    let cwd = ''
    const status = await runTest(
      file,
      name,
      {
        ...output,
        spawn: (args, directory) => {
          argv = args
          cwd = directory
          return childFor(transcript)
        },
      },
      new AbortController().signal,
    )
    expect(status).toBe(transcript.exitCode)
    expect(output.out()).toBe(`${transcript.stdout}CKDEV executed 1 tests\n`)
    expect(output.err()).toBe(transcript.stderr)
    expect(argv).toEqual([
      process.execPath,
      'test',
      '--no-orphans',
      '--config',
      './bunfig.toml',
      './src/tests/fast.test.ts',
      '--test-name-pattern',
      exactPattern(name),
    ])
    expect(cwd).toBe(
      `${import.meta.dir.replace('/scripts/tests', '')}/packages/core`,
    )
  }
  const api = selectionFor(apiFile, apiName)
  const output = sinks()
  const transcript = green(api.name)
  expect(
    await runTest(
      apiFile,
      apiName,
      { ...output, spawn: () => childFor(transcript) },
      new AbortController().signal,
    ),
  ).toBe(0)
  expect(output.err()).toBe(transcript.stderr)
})

test('invalid names and unsafe paths refuse before spawning', async () => {
  const inputs = [
    { file, name: '' },
    { file, name: ' name' },
    { file, name: 'name ' },
    { file, name: 'name\n' },
    { file, name: 'name\u0000' },
    { file, name: 'name\u0085' },
    { file: '../fast.test.ts', name },
    { file: '/tmp/fast.test.ts', name },
    { file: 'C:\\tmp\\fast.test.ts', name },
    { file: 'packages/core/../pi/src/tests/convert.test.ts', name },
    { file: 'packages/core/src/tests/../fast.test.ts', name },
    { file: 'packages/core/src/tests/nested/fast.test.ts', name },
    { file: 'packages/other/src/tests/fast.test.ts', name },
    { file: 'packages/core/src/tests/setup.ts', name },
    { file: 'constructor', name },
  ]
  for (const input of inputs) {
    const output = sinks()
    expect(
      await runTest(
        input.file,
        input.name,
        {
          ...output,
          spawn: () => {
            throw new Error('Must not spawn')
          },
        },
        new AbortController().signal,
      ),
    ).toBe(126)
    expect(output.err()).not.toContain('Must not spawn')
    expect(output.out()).toBe('')
  }
})

test('spawn failure is refused without a count record', async () => {
  const output = sinks()
  expect(
    await runTest(
      file,
      name,
      {
        ...output,
        spawn: () => {
          throw new Error('ENOENT')
        },
      },
      new AbortController().signal,
    ),
  ).toBe(126)
  expect(output.err()).toContain('ENOENT')
  expect(output.out()).toBe('')
})

test('all malformed transcript fixtures return 126 and preserve raw output', async () => {
  for (const { transcript } of invalid) {
    const output = sinks()
    expect(
      await runTest(
        file,
        name,
        { ...output, spawn: () => childFor(transcript) },
        new AbortController().signal,
      ),
    ).toBe(126)
    expect(output.out()).toBe(transcript.stdout)
    expect(output.err().startsWith(transcript.stderr)).toBe(true)
    expect(output.err()).toContain('CKDEV ERROR:')
  }
})

test('cancellation kills owned work before joining pending pipes and body', async () => {
  const output = sinks()
  const abort = new AbortController()
  const events: string[] = []
  let stopOut = () => {}
  let stopErr = () => {}
  let stopBody = () => {}
  const child: OwnedChild = {
    stdout: new ReadableStream({
      start(controller) {
        stopOut = () => {
          events.push('stdout done')
          controller.close()
        }
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        stopErr = () => {
          events.push('stderr done')
          controller.close()
        }
      },
    }),
    exited: new Promise((resolve) => {
      stopBody = () => {
        events.push('body done')
        resolve(137)
      }
    }),
    signalCode: 'SIGKILL',
    kill: () => {
      events.push('kill')
      stopOut()
      stopErr()
      stopBody()
    },
  }
  const running = runTest(
    file,
    name,
    { ...output, spawn: () => child },
    abort.signal,
  )
  abort.abort()
  expect(await running).toBe(126)
  expect(events).toEqual(['kill', 'stdout done', 'stderr done', 'body done'])
  expect(output.err()).toContain('Invocation cancelled')
  expect(output.out()).toBe('')
})

test('pipe failure kills owned work and all-settled joins the other pipe and exit', async () => {
  const output = sinks()
  let killed = false
  let closeOther = () => {}
  let finish = () => {}
  const child: OwnedChild = {
    stdout: new ReadableStream({
      start(controller) {
        controller.error(new Error('pipe broken'))
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        closeOther = () => {
          controller.enqueue(Buffer.from('raw tail\n'))
          controller.close()
        }
      },
    }),
    exited: new Promise((resolve) => {
      finish = () => resolve(137)
    }),
    signalCode: 'SIGKILL',
    kill: () => {
      killed = true
      closeOther()
      finish()
    },
  }
  expect(
    await runTest(
      file,
      name,
      { ...output, spawn: () => child },
      new AbortController().signal,
    ),
  ).toBe(126)
  expect(killed).toBe(true)
  expect(output.err()).toBe('raw tail\nCKDEV ERROR: Error: pipe broken\n')
})

test('exit-promise rejection terminates pending pipes before joining them', async () => {
  const output = sinks()
  let closed = false
  let closeOut = () => {}
  let closeErr = () => {}
  const child: OwnedChild = {
    stdout: new ReadableStream({
      start(controller) {
        closeOut = () => controller.close()
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        closeErr = () => controller.close()
      },
    }),
    exited: Promise.reject(new Error('wait failed')),
    signalCode: null,
    kill: () => {
      closed = true
      closeOut()
      closeErr()
    },
  }
  expect(
    await runTest(
      file,
      name,
      { ...output, spawn: () => child },
      new AbortController().signal,
    ),
  ).toBe(126)
  expect(closed).toBe(true)
  expect(output.err()).toContain('wait failed')
})

const junitStart =
  '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="2" failures="0" skipped="0">\n  <testsuite name="src/tests/fixture.test.ts">\n'
function junit(caseLines: string[]) {
  return `${junitStart}${caseLines.join('\n')}\n  </testsuite>\n</testsuites>\n`
}
function testcase(leaf: string, classname = '', suffix = ' />') {
  return `    <testcase name="${leaf}" classname="${classname}" time="0.001" file="src/tests/fixture.test.ts" line="12" assertions="1"${suffix}`
}
function event(
  name: string,
  status: 'pass' | 'fail' = 'pass',
  occurrence = 1,
  file = 'src/tests/fixture.test.ts',
): ExecutionEvent {
  return { name, status, occurrence, file }
}
function packageGreen(): Transcript {
  return {
    stdout: header,
    stderr:
      '\nsrc/tests/fixture.test.ts:\n(pass) handles timeout [1.00ms]\n(pass) scope > second [2.00ms]\n\n 2 pass\n 0 fail\n 2 expect() calls\nRan 2 tests across 1 file. [10.00ms]\n',
    exitCode: 0,
    signal: null,
  }
}

test('package events count only executed results, not a passing timeout title', () => {
  expect(executedCount(undefined, packageGreen())).toBe(2)
  expect(() => executedCount('handles timeout', packageGreen())).toThrow()
  expect(() =>
    executedCount(undefined, {
      ...packageGreen(),
      stderr: packageGreen().stderr.replace(' 2 pass', ' 3 pass'),
    }),
  ).toThrow()
  expect(() =>
    executedCount(undefined, {
      ...packageGreen(),
      stderr: packageGreen().stderr.replace('Ran 2 tests', 'Ran 3 tests'),
    }),
  ).toThrow()
})

test('normalizes only JUnit name attributes and preserves native named row identities', () => {
  const fullName =
    'buildAnthropicRequest — Fable/Mythos thinking > does not add Fable 5.1 binding controls to an API-key request'
  const caseLines = [
    testcase(
      'refuses unknown or meaningful content 0 without mutating history',
    ),
    testcase(
      'does not add Fable 5.1 binding controls to an API-key request',
      'buildAnthropicRequest — Fable/Mythos thinking',
    ),
  ]
  const raw = junit(caseLines)
  const events = [
    event('refuses unknown or meaningful content 0 without mutating history'),
    event(fullName),
  ]
  const normalized = normalizeReport(raw, events)
  expect(normalized.ids).toEqual([
    'refuses unknown or meaningful content 0 without mutating history',
    fullName,
  ])
  expect(normalized.xml).toBe(
    raw.replace(
      'name="does not add Fable 5.1 binding controls to an API-key request"',
      'name="buildAnthropicRequest — Fable/Mythos thinking &gt; does not add Fable 5.1 binding controls to an API-key request"',
    ),
  )
  expect(normalizeReport(raw, events)).toEqual(normalized)
  expect(
    normalizeReport(
      junit([
        testcase('fast mode eligibility for claude-opus-4-7[1m] is false'),
      ]),
      [event('fast mode eligibility for claude-opus-4-7[1m] is false')],
    ).ids,
  ).toEqual(['fast mode eligibility for claude-opus-4-7[1m] is false'])
})

test('XML entity and dollar punctuation normalization cannot rewrite result data', () => {
  const raw = junit([
    testcase(
      'a &amp; &quot;b&quot; &apos;c&apos; &#36;&amp; &#x41;',
      'scope &lt;x&gt;',
      '>',
    ),
    '      <failure message="expect(received).toBe(expected)"><![CDATA[Expected: false\nReceived: true]]></failure>',
    '    </testcase>',
  ])
  const normalized = normalizeReport(raw, [
    event('scope <x> > a & "b" \'c\' $& A', 'fail'),
  ])
  expect(normalized.ids).toEqual(['scope <x> > a & "b" \'c\' $& A'])
  expect(normalized.xml).toContain('classname="scope &lt;x&gt;"')
  expect(normalized.xml.slice(normalized.xml.indexOf('      <failure'))).toBe(
    raw.slice(raw.indexOf('      <failure')),
  )
})

test('repeated Bun table cases retain every result with deterministic occurrence IDs', () => {
  const raw = junit([
    testcase('Pi history empty user=%s'),
    testcase('Pi history empty user=%s', '', '>'),
    '      <failure message="original failure">original body</failure>',
    '    </testcase>',
  ])
  const events = [
    event('Pi history empty user=%s'),
    event('Pi history empty user=%s', 'fail', 2),
  ]
  const normalized = normalizeReport(raw, events)
  expect(normalized.ids).toEqual([
    'Pi history empty user=%s [case 1 at src/tests/fixture.test.ts:12]',
    'Pi history empty user=%s [case 2 at src/tests/fixture.test.ts:12]',
  ])
  expect(normalized.xml).toContain(
    '<failure message="original failure">original body</failure>',
  )
  expect(normalized.xml.match(/<testcase /g)?.length).toBe(2)
  expect(normalizeReport(raw, events)).toEqual(normalized)
  // Neither suffixed report ID equals "Pi history empty user=%s". An
  // expected-name list containing that name matches neither occurrence.
  expect(normalized.ids.includes('Pi history empty user=%s')).toBe(false)
})

test('normalization refuses final ID collisions instead of renaming around them', () => {
  const raw = junit([
    testcase('dup'),
    testcase('dup'),
    testcase('dup [case 1 at src/tests/fixture.test.ts:12]'),
  ])
  expect(() =>
    normalizeReport(raw, [
      event('dup'),
      event('dup', 'pass', 2),
      event('dup [case 1 at src/tests/fixture.test.ts:12]'),
    ]),
  ).toThrow('Colliding normalized JUnit IDs')
})

test('missing, empty, garbage and mismatched report identities refuse', () => {
  for (const raw of [
    '',
    'garbage',
    junit([]),
    junit([testcase('one')]).replace('</testsuites>', ''),
    junit([testcase('one')]).replace('classname=""', ''),
    junit([testcase('one')]).replace('name="one"', 'name="one" name="two"'),
    junit([testcase('bad &unknown;')]),
  ]) {
    expect(() => normalizeReport(raw, [event('one')])).toThrow()
  }
  expect(() =>
    normalizeReport(junit([testcase('one')]), [event('one'), event('two')]),
  ).toThrow()
})

test('every mutation catalogue command selects its package-local test under the owning config', async () => {
  const parsed: unknown = Bun.TOML.parse(
    await readFile(resolve(import.meta.dir, '../../mutations.toml'), 'utf8'),
  )
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('control' in parsed) ||
    !Array.isArray(parsed.control) ||
    parsed.control.length === 0
  )
    throw new Error('Expected mutation catalogue controls')

  for (const control of parsed.control) {
    if (!control || typeof control !== 'object' || !('command' in control))
      throw new Error('Expected a mutation catalogue command')
    const command = control.command
    if (
      !Array.isArray(command) ||
      command[0] !== 'bun' ||
      command[1] !== 'scripts/run-mutation-bun.ts' ||
      command.length !== 4 ||
      typeof command[2] !== 'string' ||
      command[3] !== '{test}'
    )
      throw new Error('Unexpected mutation catalogue test command')

    const file = command[2]
    const packageRoot = (
      ['packages/core', 'packages/opencode', 'packages/pi'] as const
    ).find((root) => file.startsWith(`${root}/`))
    if (!packageRoot)
      throw new Error(`Unowned mutation catalogue test file: ${file}`)
    const selected = selectionFor(file, 'catalogue selection probe')
    expect(selected.cwd).toBe(packageRoot)
    expect(selected.file).toBe(file.slice(packageRoot.length + 1))
  }
})

test('native guard selection uses the actual owning package and reviewed preload config', () => {
  for (const [file, cwd, relative] of [
    [
      'packages/core/src/tests/native-runtime.test.ts',
      'packages/core',
      'src/tests/native-runtime.test.ts',
    ],
    [
      'packages/core/src/tests/native-display-profile.test.ts',
      'packages/core',
      'src/tests/native-display-profile.test.ts',
    ],
    [
      'packages/core/src/tests/native-account-runtime.test.ts',
      'packages/core',
      'src/tests/native-account-runtime.test.ts',
    ],
    [
      'packages/opencode/src/tests/index.test.ts',
      'packages/opencode',
      'src/tests/index.test.ts',
    ],
  ] as const) {
    if (!file || !cwd || !relative)
      throw new Error('Expected complete test selection')
    const name =
      'auth.loader > quota header harvest > pending quota routes without waiting for header publication'
    expect(selectionFor(file, name)).toEqual({
      cwd,
      file: relative,
      name,
      filterName: name.replaceAll(' > ', ' '),
    })
  }
  expect(() =>
    selectionFor('packages/opencode/src/tests/preload-sandbox.ts', 'unsafe'),
  ).toThrow('Unsafe or unsupported test file')
  expect(
    packageSelection('packages/opencode', 'tmp/mutations/opencode.xml'),
  ).toEqual({
    cwd: 'packages/opencode',
    file: 'src/tests',
    report: 'tmp/mutations/opencode.xml',
  })
})

test('package/report selection cannot escape reviewed unit configs or report paths', () => {
  expect(packageSelection('packages/core', 'tmp/mutations/core.xml')).toEqual({
    cwd: 'packages/core',
    file: 'src/tests',
    report: 'tmp/mutations/core.xml',
  })
  for (const [pkg, report] of [
    ['packages/opencode', 'tmp/mutations/core.xml'],
    ['packages/core', '../core.xml'],
    ['packages/pi', '/tmp/pi.xml'],
    ['packages/pi', 'tmp/mutations/core.xml'],
  ]) {
    expect(() => packageSelection(pkg ?? '', report ?? '')).toThrow()
  }
})

test('broad dispatch uses full package argv and writes only verified nonempty reports', async () => {
  const output = sinks()
  let actualArgv: string[] = []
  let actualIds: string[] = []
  const raw = junit([testcase('handles timeout'), testcase('second', 'scope')])
  expect(
    await runPackage(
      'packages/core',
      'tmp/mutations/core.xml',
      {
        ...output,
        spawn: (argv) => {
          actualArgv = argv
          return childFor(packageGreen())
        },
        report: {
          read: async () => raw,
          write: async (_path, normalized) => {
            actualIds = normalized.ids
          },
        },
      },
      new AbortController().signal,
    ),
  ).toBe(0)
  expect(actualArgv.slice(0, 6)).toEqual([
    process.execPath,
    'test',
    '--no-orphans',
    '--config',
    './bunfig.toml',
    './src/tests',
  ])
  expect(actualArgv).toContain('--reporter=junit')
  expect(actualArgv.some((arg) => arg.includes('test-name-pattern'))).toBe(
    false,
  )
  expect(actualIds).toEqual(['handles timeout', 'scope > second'])
  expect(output.out()).toBe(`${header}CKDEV executed 2 tests\n`)
})

test('missing and empty broad reports return 126 without a count or report write', async () => {
  for (const raw of ['', junit([]), 'not XML']) {
    const output = sinks()
    let written = false
    expect(
      await runPackage(
        'packages/core',
        'tmp/mutations/core.xml',
        {
          ...output,
          spawn: () => childFor(packageGreen()),
          report: {
            read: async () => raw,
            write: async () => {
              written = true
            },
          },
        },
        new AbortController().signal,
      ),
    ).toBe(126)
    expect(written).toBe(false)
    expect(output.out()).toBe(header)
    expect(output.err()).toContain('CKDEV ERROR:')
  }
  const output = sinks()
  expect(
    await runPackage(
      'packages/core',
      'tmp/mutations/core.xml',
      {
        ...output,
        spawn: () => childFor(packageGreen()),
        report: {
          read: async () => {
            throw new Error('ENOENT report')
          },
          write: async () => {
            throw new Error('Must not write')
          },
        },
      },
      new AbortController().signal,
    ),
  ).toBe(126)
  expect(output.err()).toContain('ENOENT report')
})

function multiRed(): Transcript {
  return {
    ...red(),
    stderr: red()
      .stderr.replace(
        'src/tests/fast.test.ts:\n',
        'src/tests/fast.test.ts:\n(pass) healthy companion [1.00ms]\n',
      )
      .replace(
        ' 0 pass\n',
        `1 tests failed:\n(fail) ${name} [2.11ms]\n\n 1 pass\n`,
      )
      .replace('Ran 1 test across', 'Ran 2 tests across'),
  }
}

test('real multi-test failure recap is verified but never counted twice', () => {
  expect(executedCount(undefined, multiRed())).toBe(2)
  expect(() => executedCount(name, multiRed())).toThrow()
  expect(() =>
    executedCount(undefined, {
      ...multiRed(),
      stderr: multiRed().stderr.replace('1 tests failed:', '2 tests failed:'),
    }),
  ).toThrow()
  expect(() =>
    executedCount(undefined, {
      ...multiRed(),
      stderr: `${multiRed().stderr}(fail) unrelated recap [2.11ms]\n`,
    }),
  ).toThrow()
  expect(() =>
    executedCount(undefined, {
      ...multiRed(),
      stderr: multiRed().stderr.replace(
        '1 tests failed:',
        '1 tests failed:\n1 tests failed:',
      ),
    }),
  ).toThrow()
})

test('package assertion failures retain a red case and a healthy companion in JUnit', async () => {
  const output = sinks()
  const raw = junit([
    testcase('healthy companion'),
    testcase(name, '', '>'),
    '      <failure message="expect(received).toBe(expected)">Expected: false; Received: true</failure>',
    '    </testcase>',
  ]).replaceAll(
    'file="src/tests/fixture.test.ts"',
    'file="src/tests/fast.test.ts"',
  )
  let written = ''
  expect(
    await runPackage(
      'packages/core',
      'tmp/mutations/core.xml',
      {
        ...output,
        spawn: () => childFor(multiRed()),
        report: {
          read: async () => raw,
          write: async (_path, normalized) => {
            written = normalized.xml
          },
        },
      },
      new AbortController().signal,
    ),
  ).toBe(1)
  expect(written).toContain(
    '<failure message="expect(received).toBe(expected)">Expected: false; Received: true</failure>',
  )
  expect(written).toContain('name="healthy companion"')
  expect(output.out()).toBe(`${header}CKDEV executed 2 tests\n`)
})

function consistencyTranscript(): Transcript {
  return {
    stdout: header,
    stderr:
      '\nsrc/tests/synthetic.test.ts:\nerror: expect(received).toBe(expected)\n(fail) selected mutation assertion [1.00ms]\n(pass) healthy companion [1.00ms]\n\n 1 pass\n 1 fail\n 2 expect() calls\nRan 2 tests across 1 file. [2.00ms]\n',
    exitCode: 1,
    signal: null,
  }
}
function consistencyXml(
  selectedFails: boolean,
  companionFails: boolean,
  selectedName = 'selected mutation assertion',
) {
  const selected = `<testcase name="${selectedName}" classname="" file="src/tests/synthetic.test.ts" line="1"${selectedFails ? '>\n<failure message="assertion" />\n</testcase>' : ' />'}`
  const companion = `<testcase name="healthy companion" classname="" file="src/tests/synthetic.test.ts" line="2"${companionFails ? '>\n<failure message="assertion" />\n</testcase>' : ' />'}`
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="2" failures="${Number(selectedFails) + Number(companionFails)}">\n<testsuite name="synthetic">\n${selected}\n${companion}\n</testsuite>\n</testsuites>\n`
}
async function runConsistencyFixture(raw: string) {
  const output = sinks()
  let written = false
  let retained = ''
  const transcript = consistencyTranscript()
  const status = await runPackage(
    'packages/core',
    'tmp/mutations/core.xml',
    {
      ...output,
      spawn: () => childFor(transcript),
      report: {
        read: async () => {
          retained = raw
          return raw
        },
        write: async () => {
          written = true
        },
      },
    },
    new AbortController().signal,
  )
  return {
    status,
    written,
    retained,
    stdout: output.out(),
    stderr: output.err(),
    transcript,
  }
}

test('accepts matching console and JUnit failure attribution with a healthy companion', async () => {
  const result = await runConsistencyFixture(consistencyXml(true, false))
  expect(result.status).toBe(1)
  expect(result.written).toBe(true)
  expect(result.stdout).toBe(`${header}CKDEV executed 2 tests\n`)
})

test('refuses JUnit erased failure despite matching aggregate test count', async () => {
  const raw = consistencyXml(false, false)
  const result = await runConsistencyFixture(raw)
  expect(result.status).toBe(126)
  expect(result.written).toBe(false)
  expect(result.stdout).toBe(header)
  expect(result.stderr.startsWith(result.transcript.stderr)).toBe(true)
  expect(result.retained).toBe(raw)
})

test('refuses JUnit failure moved to the healthy companion despite matching aggregate counts', async () => {
  const raw = consistencyXml(false, true)
  const result = await runConsistencyFixture(raw)
  expect(result.status).toBe(126)
  expect(result.written).toBe(false)
  expect(result.stdout).toBe(header)
  expect(result.stderr.startsWith(result.transcript.stderr)).toBe(true)
  expect(result.retained).toBe(raw)
})

test('refuses changed JUnit identities despite matching aggregate counts and outcomes', async () => {
  const raw = consistencyXml(true, false, 'unrelated assertion')
  const result = await runConsistencyFixture(raw)
  expect(result.status).toBe(126)
  expect(result.written).toBe(false)
  expect(result.stdout).toBe(header)
  expect(result.stderr.startsWith(result.transcript.stderr)).toBe(true)
  expect(result.retained).toBe(raw)
})

test('console events retain source file, exact name, outcome and occurrence before the recap', () => {
  expect(parseExecution(undefined, multiRed()).events).toEqual([
    {
      file: 'src/tests/fast.test.ts',
      name: 'healthy companion',
      status: 'pass',
      occurrence: 1,
    },
    { file: 'src/tests/fast.test.ts', name, status: 'fail', occurrence: 1 },
  ])
})

test('refuses changed JUnit source files with unchanged names counts and outcomes', async () => {
  const raw = consistencyXml(true, false).replaceAll(
    'file="src/tests/synthetic.test.ts"',
    'file="src/tests/other.test.ts"',
  )
  const result = await runConsistencyFixture(raw)
  expect(result.status).toBe(126)
  expect(result.written).toBe(false)
  expect(result.stdout).toBe(header)
  expect(result.retained).toBe(raw)
})

test('refuses a failure shifted between repeated Bun cases at the same source location', async () => {
  const duplicateName =
    'Pi refuses meaningful assistant history locally (fixture-api-key, empty user=%s)'
  const sourceFile = 'src/tests/request-history-stream.test.ts'
  const transcript: Transcript = {
    stdout: header,
    stderr: `\n${sourceFile}:\n(pass) ${duplicateName} [1.00ms]\nerror: expect(received).toBe(expected)\n(fail) ${duplicateName} [1.00ms]\n\n1 tests failed:\n(fail) ${duplicateName} [1.00ms]\n\n 1 pass\n 1 fail\n 2 expect() calls\nRan 2 tests across 1 file. [2.00ms]\n`,
    exitCode: 1,
    signal: null,
  }
  const cases = [
    testcase(duplicateName),
    testcase(duplicateName, '', '>'),
    '      <failure type="AssertionError" />',
    '    </testcase>',
  ]
  const matching = junit(cases)
    .replaceAll('src/tests/fixture.test.ts', sourceFile)
    .replaceAll('line="12"', 'line="62"')
  const observed = parseExecution(undefined, transcript)
  expect(observed.events).toEqual([
    { name: duplicateName, file: sourceFile, status: 'pass', occurrence: 1 },
    { name: duplicateName, file: sourceFile, status: 'fail', occurrence: 2 },
  ])
  expect(normalizeReport(matching, observed.events).ids).toEqual([
    `${duplicateName} [case 1 at ${sourceFile}:62]`,
    `${duplicateName} [case 2 at ${sourceFile}:62]`,
  ])
  const moved = junit([
    testcase(duplicateName, '', '>'),
    '      <failure type="AssertionError" />',
    '    </testcase>',
    testcase(duplicateName),
  ])
    .replaceAll('src/tests/fixture.test.ts', sourceFile)
    .replaceAll('line="12"', 'line="62"')
  const output = sinks()
  let written = false
  let retained = ''
  expect(
    await runPackage(
      'packages/pi',
      'tmp/mutations/pi.xml',
      {
        ...output,
        spawn: () => childFor(transcript),
        report: {
          read: async () => {
            retained = moved
            return moved
          },
          write: async () => {
            written = true
          },
        },
      },
      new AbortController().signal,
    ),
  ).toBe(126)
  expect(written).toBe(false)
  expect(retained).toBe(moved)
  expect(output.out()).toBe(header)
  expect(output.err().startsWith(transcript.stderr)).toBe(true)
})

const filesystemTests = createTestLifetimeSuite()
filesystemTests.test(
  'credential sandbox has a private directory under system temporary storage',
  async () => {
    const sandbox = await createMutationSandbox()
    filesystemTests.deferCleanup(() =>
      rm(sandbox, { recursive: true, force: true }),
    )
    expect(await realpath(dirname(sandbox))).toBe(await realpath(tmpdir()))
    expect((await stat(sandbox)).mode & 0o777).toBe(0o700)
  },
)

test('native GitHub group headers preserve exact file identity and outcome checks', () => {
  const transcript = green()
  const grouped = {
    ...transcript,
    stderr: transcript.stderr
      .replace('src/tests/fast.test.ts:', '::group::src/tests/fast.test.ts:')
      .replace(' 1 pass', '::endgroup::\n\n 1 pass'),
  }
  expect(parseExecution(name, grouped)).toEqual(
    parseExecution(name, transcript),
  )
  expect(executedCount(name, grouped)).toBe(1)
})

test('closed GitHub groups cannot attribute unrelated result lines to an earlier file', () => {
  const transcript = green()
  const grouped = {
    ...transcript,
    stderr: transcript.stderr.replace(
      'src/tests/fast.test.ts:',
      '::group::src/tests/fast.test.ts:\n::endgroup::',
    ),
  }
  expect(() => parseExecution(name, grouped)).toThrow(
    'missing test file header',
  )
})

test('genuine negated assertion failures retain the normal selected-test contract', () => {
  const transcript = red()
  const negated = {
    ...transcript,
    stderr: transcript.stderr.replace(
      'error: expect(received).toBe(expected)',
      'error: expect(received).not.toHaveProperty(path)',
    ),
  }
  expect(executedCount(name, negated)).toBe(1)
  expect(parseExecution(name, negated).events[0]?.status).toBe('fail')
  expect(() =>
    executedCount(name, {
      ...negated,
      stderr: negated.stderr.replace(
        'not.toHaveProperty',
        'not.not.toHaveProperty',
      ),
    }),
  ).toThrow('genuine selected expect assertion')
})

// Byte-exact stderr from the pinned Bun 1.3.14 mutation CI child that selected
// this native-host-auth-read test after the mutation made its expected
// rejection resolve; that child's stdout held only the version header.
const promiseOutcomeName =
  'group-readable authentication refuses even when the process can physically read it'
const promiseOutcomeStack =
  '      at <anonymous> (/home/runner/work/anthropic-auth/anthropic-auth/packages/core/src/tests/native-host-auth-read.test.ts:100:13)'
function promiseOutcomeEvidence(): Transcript {
  return {
    stdout: header,
    stderr: [
      '',
      '::group::src/tests/native-host-auth-read.test.ts:',
      ' 95 |   const f = await fixture()',
      " 96 |   await writeFile(f.path, '{}', { mode: 0o600 })",
      ' 97 |   await chmod(f.path, 0o640)',
      ' 98 |   await expect(',
      " 99 |     readNativeHostAuthKind('opencode', f.path),",
      "100 |   ).rejects.toMatchObject({ code: 'invalid-source' })",
      '                  ^',
      'error: ',
      '',
      'Expected promise that rejects',
      'Received promise that resolved: Promise { <resolved> }',
      '',
      promiseOutcomeStack,
      '',
      `::error file=packages/core/src/tests/native-host-auth-read.test.ts,line=100,col=13,title=error: ::Expected promise that rejects%0AReceived promise that resolved: Promise { <resolved> }%0A%0A${promiseOutcomeStack}`,
      `(fail) ${promiseOutcomeName} [6.23ms]`,
      '',
      '::endgroup::',
      '',
      ' 0 pass',
      ' 11 filtered out',
      ' 1 fail',
      ' 1 expect() calls',
      'Ran 1 test across 1 file. [41.00ms]',
      '',
    ].join('\n'),
    exitCode: 1,
    signal: null,
  }
}
// The same failure as Bun prints it outside GitHub Actions: no group markers,
// and the (fail) line follows the stack frame directly without an annotation.
function plainPromiseOutcomeEvidence(): Transcript {
  const evidence = promiseOutcomeEvidence()
  return {
    ...evidence,
    stderr: evidence.stderr
      .replace('::group::', '')
      .replace(/\n\n::error [^\n]+\n/, '\n')
      .replace('\n::endgroup::\n', ''),
  }
}
function edited(transcript: Transcript, from: string | RegExp, to: string) {
  const stderr = transcript.stderr.replace(from, to)
  if (stderr === transcript.stderr)
    throw new Error(`Fixture edit did not apply: ${String(from)}`)
  return { ...transcript, stderr }
}

test('accepts the pinned Bun promise-outcome failure bound to its matcher, stack and owning result', async () => {
  for (const transcript of [
    promiseOutcomeEvidence(),
    plainPromiseOutcomeEvidence(),
  ]) {
    expect(parseExecution(promiseOutcomeName, transcript)).toEqual({
      count: 1,
      events: [
        {
          name: promiseOutcomeName,
          file: 'src/tests/native-host-auth-read.test.ts',
          status: 'fail',
          occurrence: 1,
        },
      ],
    })
    const output = sinks()
    expect(
      await runTest(
        'packages/core/src/tests/native-host-auth-read.test.ts',
        promiseOutcomeName,
        { ...output, spawn: () => childFor(transcript) },
        new AbortController().signal,
      ),
    ).toBe(1)
    expect(output.err()).toBe(transcript.stderr)
    expect(output.out()).toBe(`${header}CKDEV executed 1 tests\n`)
  }
})

test('refuses promise-outcome text without its exact labels, source matcher, stack or owning result', () => {
  const grouped = promiseOutcomeEvidence()
  const plain = plainPromiseOutcomeEvidence()
  const variants: [string, Transcript][] = [
    [
      'arbitrary blank error and prose without a source excerpt',
      edited(plain, /\n 95 \|[\s\S]*?\n {18}\^\n/, '\n'),
    ],
    ['missing stack frame', edited(plain, `${promiseOutcomeStack}\n`, '')],
    [
      'promise outcome matched by an expected-label substring only',
      edited(
        plain,
        'Expected promise that rejects',
        'Expected promise that rejects or resolves',
      ),
    ],
    [
      'expected label naming the other matcher',
      edited(
        edited(
          plain,
          'Expected promise that rejects',
          'Expected promise that resolves',
        ),
        'Received promise that resolved: Promise { <resolved> }',
        'Received promise that rejected: Promise { <rejected> }',
      ),
    ],
    [
      'received outcome matching the expected outcome',
      edited(
        plain,
        'Received promise that resolved: Promise { <resolved> }',
        'Received promise that rejected: Promise { <rejected> }',
      ),
    ],
    [
      'received promise state contradicting its label',
      edited(plain, 'Promise { <resolved> }', 'Promise { <rejected> }'),
    ],
    [
      'stack frame in another test file',
      edited(plain, '/native-host-auth-read.test.ts:100', '/other.test.ts:100'),
    ],
    ['stack frame on another line', edited(plain, ':100:13)', ':99:13)')],
    [
      'caret at another column',
      edited(plain, '\n                  ^\n', '\n                   ^\n'),
    ],
    [
      'matcher not chained after .rejects',
      edited(plain, ').rejects.toMatchObject', ').catches.toMatchObject'),
    ],
    [
      'expected text displaced after its owning result',
      edited(
        plain,
        /(error: \n\nExpected[\s\S]*?\.test\.ts:100:13\)\n)(\(fail\) [^\n]+\n)/,
        '$2$1',
      ),
    ],
    [
      'unrelated output between the stack and the owning result',
      edited(
        plain,
        `${promiseOutcomeStack}\n`,
        `${promiseOutcomeStack}\nnoise\n`,
      ),
    ],
    [
      'annotation at another column',
      edited(grouped, 'line=100,col=13', 'line=100,col=14'),
    ],
    [
      'annotation repeating a different message',
      edited(
        grouped,
        '::Expected promise that rejects%0A',
        '::Expected promise%0A',
      ),
    ],
    [
      'annotation missing after its blank separator',
      edited(grouped, /\n::error [^\n]+\n/, '\n'),
    ],
    [
      'runtime error title instead of the blank assertion title',
      edited(plain, '\nerror: \n', '\nError: \n'),
    ],
    [
      'timeout reported in the owning block',
      edited(
        plain,
        `${promiseOutcomeStack}\n`,
        `${promiseOutcomeStack.replace('<anonymous>', 'timeout')}\n`,
      ),
    ],
  ]
  const refusal = (transcript: Transcript) => {
    try {
      parseExecution(promiseOutcomeName, transcript)
      return 'accepted'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const genuine = 'Not a genuine selected expect assertion failure'
  expect(
    variants.map(([label, transcript]) => [label, refusal(transcript)]),
  ).toEqual(
    variants.map(([label]) => [
      label,
      label.startsWith('timeout')
        ? 'Timeout, hook or unhandled error'
        : genuine,
    ]),
  )
})

// Real pinned Bun children print the promise-outcome format end to end. Each
// test body owns a private sandbox holding its fixture test files, and joins
// both pipes and the exit status of every child before the sandbox is removed.
const promiseOutcomeFixture = `import { expect, test } from 'bun:test'

const resolved = async () => ({ code: 'fine' })
const rejected = async () => {
  throw Object.assign(new Error('refused'), { code: 'invalid-source' })
}

test('rejects receives a resolved promise', async () => {
  await expect(
    resolved(),
  ).rejects.toMatchObject({ code: 'invalid-source' })
})

test('resolves receives a rejected promise', async () => {
  await expect(rejected())
    .resolves
    .toEqual({ code: 'fine' })
})

test('negated rejects receives a resolved promise after a counted assertion', async () => {
  expect(await resolved()).toEqual({ code: 'fine' })
  await expect(resolved()).rejects.not.toBeNull()
})

test('rejects companion receives a rejected promise', async () => {
  await expect(rejected()).rejects.toMatchObject({ code: 'invalid-source' })
})

test('resolves companion receives a resolved promise', async () => {
  await expect(resolved()).resolves.toEqual({ code: 'fine' })
})
`
const promiseRefusalFixture = `import { beforeEach, describe, expect, test } from 'bun:test'

const resolved = async () => ({ code: 'fine' })

describe('hooked', () => {
  beforeEach(async () => {
    await expect(resolved()).rejects.toThrow()
  })
  test('inner companion', () => {
    expect(1).toBe(1)
  })
})

test('runtime error repeating promise outcome prose', async () => {
  expect(await resolved()).toEqual({ code: 'fine' })
  const error = new Error(
    '\\n\\nExpected promise that rejects\\nReceived promise that resolved: Promise { <resolved> }\\n',
  )
  error.name = 'error'
  throw error
})

test('negated rejects receives a resolved promise without a counted assertion', async () => {
  await expect(resolved()).rejects.not.toBeNull()
})
`
async function promiseFixtureSandbox() {
  const sandbox = await createMutationSandbox()
  filesystemTests.deferCleanup(() =>
    rm(sandbox, { recursive: true, force: true }),
  )
  await mkdir(resolve(sandbox, 'src/tests'), { recursive: true })
  await writeFile(
    resolve(sandbox, 'src/tests/promise-outcome.test.ts'),
    promiseOutcomeFixture,
  )
  await writeFile(
    resolve(sandbox, 'src/tests/promise-refusal.test.ts'),
    promiseRefusalFixture,
  )
  return sandbox
}
async function pinnedChild(
  sandbox: string,
  file: string,
  selected: string | undefined,
  github: boolean,
  lifetime: Pick<TestLifetime, 'gate' | 'trackDetached'> = filesystemTests,
): Promise<Transcript> {
  const env = testEnvironment(sandbox, process.env)
  delete env.GITHUB_ACTIONS
  if (github) env.GITHUB_ACTIONS = 'true'
  const child = Bun.spawn(
    [
      process.execPath,
      'test',
      '--no-orphans',
      `./src/tests/${file}`,
      ...(selected === undefined
        ? []
        : [
            '--test-name-pattern',
            exactPattern(selected.replaceAll(' > ', ' ')),
          ]),
    ],
    { cwd: sandbox, env, stdout: 'pipe', stderr: 'pipe' },
  )
  // Register cancellation before waiting: when Bun tears down a timed-out
  // body, the lifetime opens this gate and kills the child if it is still
  // running, so the pipe and exit joins below finish before sandbox cleanup.
  const cancel = lifetime.gate()
  const cancellation = cancel.wait.then(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  })
  lifetime.trackDetached(cancellation)
  const [stdout, stderr, exited] = await Promise.allSettled([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  cancel.open()
  await cancellation
  if (stdout.status === 'rejected') throw stdout.reason
  if (stderr.status === 'rejected') throw stderr.reason
  if (exited.status === 'rejected') throw exited.reason
  return {
    stdout: stdout.value,
    stderr: stderr.value,
    exitCode: exited.value,
    signal: child.signalCode,
  }
}

filesystemTests.test(
  'real pinned Bun promise-outcome failures count beside healthy companions',
  async () => {
    const sandbox = await promiseFixtureSandbox()
    const file = 'src/tests/promise-outcome.test.ts'
    for (const github of [false, true]) {
      for (const [selected, status] of [
        ['rejects receives a resolved promise', 'fail'],
        ['resolves receives a rejected promise', 'fail'],
        [
          'negated rejects receives a resolved promise after a counted assertion',
          'fail',
        ],
        ['rejects companion receives a rejected promise', 'pass'],
        ['resolves companion receives a resolved promise', 'pass'],
      ] as const) {
        const transcript = await pinnedChild(
          sandbox,
          'promise-outcome.test.ts',
          selected,
          github,
        )
        expect(transcript.exitCode).toBe(status === 'fail' ? 1 : 0)
        expect(transcript.stderr).toContain(
          status === 'fail' ? '\nerror: \n\nExpected promise that ' : '(pass) ',
        )
        expect(parseExecution(selected, transcript)).toEqual({
          count: 1,
          events: [{ name: selected, file, status, occurrence: 1 }],
        })
      }
      const whole = await pinnedChild(
        sandbox,
        'promise-outcome.test.ts',
        undefined,
        github,
      )
      expect(whole.exitCode).toBe(1)
      expect(parseExecution(undefined, whole).events).toEqual([
        {
          name: 'rejects receives a resolved promise',
          file,
          status: 'fail',
          occurrence: 1,
        },
        {
          name: 'resolves receives a rejected promise',
          file,
          status: 'fail',
          occurrence: 1,
        },
        {
          name: 'negated rejects receives a resolved promise after a counted assertion',
          file,
          status: 'fail',
          occurrence: 1,
        },
        {
          name: 'rejects companion receives a rejected promise',
          file,
          status: 'pass',
          occurrence: 1,
        },
        {
          name: 'resolves companion receives a resolved promise',
          file,
          status: 'pass',
          occurrence: 1,
        },
      ])
    }
  },
)

filesystemTests.test(
  'real pinned Bun hook and runtime errors with promise-outcome text still refuse',
  async () => {
    const sandbox = await promiseFixtureSandbox()
    for (const github of [false, true]) {
      for (const [selected, reason] of [
        ['hooked > inner companion', 'Timeout, hook or unhandled error'],
        [
          'runtime error repeating promise outcome prose',
          'Not a genuine selected expect assertion failure',
        ],
        // Bun 1.3.14 does not count a negated promise matcher whose promise
        // settled the other way, so the positive expect-count guard refuses.
        [
          'negated rejects receives a resolved promise without a counted assertion',
          'No verified assertion executed',
        ],
      ] as const) {
        const transcript = await pinnedChild(
          sandbox,
          'promise-refusal.test.ts',
          selected,
          github,
        )
        expect(transcript.exitCode).toBe(1)
        expect(transcript.stderr).toContain(
          '\nerror: \n\nExpected promise that rejects\nReceived promise that resolved: Promise { <resolved> }\n\n      at <anonymous> (/',
        )
        expect(() => parseExecution(selected, transcript)).toThrow(reason)
      }
    }
  },
)

// A fixture that never finishes on its own, so only cancellation ends its child.
const heldFixture = `import { test } from 'bun:test'

test('held until cancelled', async () => {
  await new Promise(() => setInterval(() => {}, 1_000))
}, 600_000)
`

filesystemTests.test(
  'a held pinned Bun child is killed by its cancelled test lifetime before cleanup',
  async () => {
    const sandbox = await promiseFixtureSandbox()
    await writeFile(
      resolve(sandbox, 'src/tests/promise-held.test.ts'),
      heldFixture,
    )
    // finish() opens cancellation gates before it joins the body and cleans up.
    // The child's gate kills it so its body and pipe joins can finish. Calling
    // finish() after registration reproduces timeout teardown without a timer.
    const lifetime = new TestLifetime()
    const events: string[] = []
    lifetime.deferCleanup(() => {
      events.push('cleanup')
    })
    let registered!: () => void
    const cancellationRegistered = new Promise<void>((resolve) => {
      registered = resolve
    })
    const body = lifetime.runBody(async () => {
      const transcript = await pinnedChild(
        sandbox,
        'promise-held.test.ts',
        'held until cancelled',
        false,
        {
          gate: () => {
            const gate = lifetime.gate()
            registered()
            return gate
          },
          trackDetached: (work) => lifetime.trackDetached(work),
        },
      )
      events.push('joined')
      return transcript
    })
    await cancellationRegistered
    events.push('cancel')
    await lifetime.finish()
    const transcript = await body
    expect(events).toEqual(['cancel', 'joined', 'cleanup'])
    expect(transcript.signal).toBe('SIGTERM')
    expect(transcript.stderr).not.toContain('(pass) held until cancelled')
  },
)
