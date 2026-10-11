import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { type TestGate, TestLifetime } from '../../core/src/tests/test-lifetime'
import { checkBundleGlobals } from './check-bundle-globals'

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-bundle-check-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const body = (name = '__anthropicAuthRpcServers') =>
  `export const registry = ${JSON.stringify(name)};\n/*${'padding'.repeat(200)}*/`

test('a small entry is valid when its imported chunk contains the implementation', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, 'index.js'),
      'export { registry } from "./shared.js"',
    )
    await writeFile(join(root, 'shared.js'), body())
    await expect(
      checkBundleGlobals(join(root, 'index.js')),
    ).resolves.toBeUndefined()
  })
})

interface PhaseClock {
  phases: Record<string, { at: string; elapsedMs: number }>
  mark(name: string): void
}
interface StandInRun {
  root: string
  env: Record<string, string>
  result: { stdout: string; stderr: string; exit: number }
}
interface CapturedHostHarness {
  installation: PhaseClock
  secrets: string[]
  command(
    args: string[],
    cwd: string,
    env: Record<string, string>,
    limit: number,
    cancellation: TestGate,
    timing: { clock: PhaseClock; name: string },
  ): Promise<StandInRun['result']>
  withScenario(args: string[], body: (run: StandInRun) => void): Promise<void>
  phaseClock(): PhaseClock
  stopServers(
    upstream: { stop(force: boolean): unknown },
    relay: { stop(force: boolean): unknown },
    clock: PhaseClock,
  ): Promise<void>
}

async function captureHostHarness(bindings: Record<string, unknown>) {
  const source = await readFile(
    resolve(import.meta.dir, '../src/tests/opencode2-e2e.test.ts'),
    'utf8',
  )
  const program = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program
  const names = new Set([
    'TOKEN',
    'PASSWORD',
    'phaseClock',
    'installation',
    'redactFixtureSecrets',
    'hostLogDirectory',
    'command',
    'withScenario',
  ])
  const declarations: string[] = []
  const slice = (node: { start?: number | null; end?: number | null }) => {
    if (node.start == null || node.end == null)
      throw new Error('Missing source range')
    return source.slice(node.start, node.end)
  }
  for (const node of program.body) {
    const name =
      node.type === 'FunctionDeclaration'
        ? node.id?.name
        : node.type === 'VariableDeclaration' &&
            node.declarations[0]?.id.type === 'Identifier'
          ? node.declarations[0].id.name
          : undefined
    if (name && names.delete(name)) declarations.push(slice(node))
  }
  if (names.size)
    throw new Error(`Missing host declarations: ${[...names].join(', ')}`)
  const scenario = program.body.find(
    (node) =>
      node.type === 'FunctionDeclaration' && node.id?.name === 'scenario',
  )
  if (scenario?.type !== 'FunctionDeclaration')
    throw new Error('Missing scenario declaration')
  const cleanup = scenario.body.body.find(
    (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'CallExpression' &&
      node.expression.callee.type === 'Identifier' &&
      node.expression.callee.name === 'deferCleanup',
  )
  if (
    cleanup?.type !== 'ExpressionStatement' ||
    cleanup.expression.type !== 'CallExpression'
  )
    throw new Error('Missing server cleanup registration')
  const callback = cleanup.expression.arguments[0]
  if (callback?.type !== 'ArrowFunctionExpression')
    throw new Error('Missing server cleanup callback')

  // Evaluate the current declarations, not an imported E2E module: importing
  // that module would register real-host installation and execution hooks.
  const captured = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    declarations.join('\n'),
  )
  return new Function(
    'bindings',
    `
    const { Bun, mkdir, readFile, readdir, rm, writeFile, join, children, cli, oc1,
      trackDetached, deferCleanup, scenario, console, setTimeout, clearTimeout } = bindings;
    ${captured}
    return { installation, command, withScenario, phaseClock,
      secrets: [TOKEN, PASSWORD, 'synthetic-refresh', 'relay-disposable-only'],
      stopServers: (upstream, relay, clock) => (${slice(callback)})() };
  `,
  )(bindings) as CapturedHostHarness
}

async function standInHost(
  mode: 'healthy' | 'failed' | 'cancelled' | 'deadline',
) {
  let evidence:
    | {
        output: string[]
        events: string[]
        failed: boolean
        childrenLeft: number
        timerDelays: number[]
        secrets: string[]
      }
    | undefined
  await fixture(async (root) => {
    const lifetime = new TestLifetime()
    const children = new Set<Bun.Subprocess>()
    const output: string[] = []
    const events: string[] = []
    const ready = Promise.withResolvers<void>()
    const timerDelays: number[] = []
    let deadline: (() => void) | undefined
    let stdoutTail = ''
    const observingBun = {
      spawn(
        args: string[],
        options: {
          cwd: string
          env: Record<string, string>
          stdout: 'pipe'
          stderr: 'pipe'
        },
      ) {
        const child = Bun.spawn(args, options)
        const observe = (stream: ReadableStream<Uint8Array>, name: string) =>
          stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                if (name === 'stdout') {
                  stdoutTail = (
                    stdoutTail + new TextDecoder().decode(chunk)
                  ).slice(-100)
                  if (stdoutTail.includes('READY_FOR_CANCELLATION'))
                    ready.resolve()
                }
                controller.enqueue(chunk)
              },
              flush() {
                events.push(`${name}.drained`)
              },
            }),
          )
        const stdout = observe(child.stdout, 'stdout')
        const stderr = observe(child.stderr, 'stderr')
        return new Proxy(child, {
          get(target, key) {
            if (key === 'stdout') return stdout
            if (key === 'stderr') return stderr
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      },
    }
    let harness: CapturedHostHarness
    harness = await captureHostHarness({
      Bun: observingBun,
      mkdir,
      readFile,
      readdir,
      rm,
      writeFile,
      join,
      children,
      cli: process.execPath,
      oc1: '',
      trackDetached: (work: Promise<unknown>) => lifetime.trackDetached(work),
      deferCleanup: (cleanup: () => Promise<void>) =>
        lifetime.deferCleanup(cleanup),
      console: {
        error(message: string) {
          if (children.size) throw new Error('Reported before child drainage')
          events.push('report')
          output.push(message)
        },
      },
      setTimeout:
        mode === 'deadline'
          ? (callback: () => void, delay: number) => {
              deadline = callback
              timerDelays.push(delay)
              return 1
            }
          : globalThis.setTimeout,
      clearTimeout: mode === 'deadline' ? () => {} : globalThis.clearTimeout,
      scenario: async (
        _args: string[],
        clock: PhaseClock,
      ): Promise<StandInRun> => {
        const scenarioRoot = join(root, 'scenario')
        const env = {
          TMPDIR: join(scenarioRoot, 'tmp'),
          PATH: process.env.PATH ?? '',
        }
        await mkdir(env.TMPDIR, { recursive: true })
        clock.mark('fixture.start')
        const hold = mode === 'cancelled' || mode === 'deadline'
        const script = `
          await Bun.write(Bun.stdout, ${JSON.stringify(harness.secrets.join('\n'))} + '\\n' + 'x'.repeat(65536) + '\\nSTDOUT_DRAINED\\n');
          await Bun.write(Bun.stderr, ${JSON.stringify(harness.secrets.join('\n'))} + '\\n' + 'y'.repeat(65536) + '\\nSTDERR_DRAINED\\n');
          ${hold ? "setInterval(() => {}, 1000); console.log('READY_FOR_CANCELLATION');" : `process.exit(${mode === 'failed' ? 7 : 0});`}
        `
        const result = await harness.command(
          [process.execPath, '-e', script],
          root,
          env,
          60_000,
          lifetime.gate(),
          { clock, name: 'host' },
        )
        return { root: scenarioRoot, env, result }
      },
    })
    harness.installation.mark('dependencies.start')
    harness.installation.mark('dependencies.ready')
    const body = lifetime
      .runBody(() =>
        harness.withScenario(['direct'], (run) => {
          if (run.result.exit !== 0) throw new Error('Stand-in child failed')
        }),
      )
      .then(
        () => false,
        () => true,
      )
    if (mode === 'cancelled') {
      await ready.promise
      await lifetime.finish()
    } else if (mode === 'deadline') {
      await ready.promise
      // Fire the callback scheduled for the unchanged 60-second deadline;
      // no earlier watchdog or host process is needed for this branch.
      if (!deadline) throw new Error('Command did not schedule its deadline')
      deadline()
    }
    const failed = await body
    await lifetime.finish()
    evidence = {
      output,
      events,
      failed,
      childrenLeft: children.size,
      timerDelays,
      secrets: harness.secrets,
    }
  })
  if (!evidence) throw new Error('Stand-in evidence missing')
  return evidence
}

test('an unrelated chunk cannot supply the registry positive control', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), body('not-the-registry'))
    await writeFile(join(root, 'unrelated.js'), body())
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'positive-control',
    )
  })
})

test('a stale singleton in an imported chunk is refused', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), 'import "./shared.js"')
    await writeFile(
      join(root, 'shared.js'),
      `${body()}\nexport const stale = "__anthropicAuthRpcServer"`,
    )
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'stale-global',
    )
  })
})

test('a missing imported chunk refuses the artifact', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), 'import "./missing.js"')
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'missing',
    )
  })
})

test('a chunk cycle is checked once without hiding a stale singleton', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), 'import "./shared.js"')
    await writeFile(
      join(root, 'shared.js'),
      `import "./index.js";\n${body()}\nexport const stale = "__anthropicAuthRpcServer"`,
    )
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'stale-global',
    )
  })
})

test('a fresh packed prefix resolves the RPC client alongside server and TUI', async () => {
  await fixture(async (root) => {
    const packageRoot = resolve(import.meta.dir, '..')
    await Bun.$`${process.execPath} pm pack --destination ${root}`
      .cwd(packageRoot)
      .quiet()
    const archives = (await readdir(root)).filter((name) =>
      name.endsWith('.tgz'),
    )
    expect(archives).toHaveLength(1)
    const prefix = join(root, 'prefix')
    const packed = join(
      prefix,
      'node_modules/@cortexkit/opencode-anthropic-auth',
    )
    await mkdir(packed, { recursive: true })
    await Bun.$`tar -xzf ${join(root, archives[0]!)} -C ${packed} --strip-components=1`.quiet()
    const manifest = JSON.parse(
      await readFile(join(packed, 'package.json'), 'utf8'),
    )

    // Resolve from an extracted archive outside the workspace, so a source
    // alias or workspace link cannot conceal a missing packed export.
    const probe = join(prefix, 'resolve.mjs')
    await writeFile(
      probe,
      `for (const subpath of ['rpc', 'server', 'tui']) console.log(import.meta.resolve('@cortexkit/opencode-anthropic-auth/' + subpath));`,
    )
    const result = await Bun.$`${process.execPath} ${probe}`.cwd(prefix).quiet()
    const entries = result
      .text()
      .trim()
      .split('\n')
      .map((entry) => fileURLToPath(entry))
    expect(entries).toEqual([
      join(packed, 'dist/rpc/rpc-client.js'),
      join(packed, 'dist/v2/server.js'),
      join(packed, 'src/tui/entry.mjs'),
    ])
    for (const entry of entries)
      expect((await readFile(entry, 'utf8')).length).toBeGreaterThan(0)
    expect(manifest.exports['./rpc']).toEqual({
      types: './dist/rpc/rpc-client.d.ts',
      import: './dist/rpc/rpc-client.js',
    })
    expect(manifest['oc-plugin']).toEqual(['server', 'tui'])
    expect(await readFile(entries[0]!, 'utf8')).toContain('createRpcClient')
    expect(
      await readFile(join(packed, manifest.exports['./rpc'].types), 'utf8'),
    ).toContain('createRpcClient')
  })
})

function assertFailedStandIn(
  evidence: Awaited<ReturnType<typeof standInHost>>,
) {
  expect(evidence.failed).toBe(true)
  expect(evidence.childrenLeft).toBe(0)
  const report = JSON.parse(evidence.output[0]!) as {
    phaseClocks: {
      installation: PhaseClock['phases']
      scenario: PhaseClock['phases']
    }
  }
  for (const name of ['dependencies.start', 'dependencies.ready'])
    expect(report.phaseClocks.installation[name]?.at).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    )
  for (const name of ['host.start', 'host.exit'])
    expect(report.phaseClocks.scenario[name]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(evidence.events.indexOf('stdout.drained')).toBeLessThan(
    evidence.events.indexOf('report'),
  )
  expect(evidence.events.indexOf('stderr.drained')).toBeLessThan(
    evidence.events.indexOf('report'),
  )
  expect(evidence.events).toContain('stdout.drained')
  expect(evidence.events).toContain('stderr.drained')
  const output = evidence.output.join('\n')
  expect(output).toContain('STDOUT_DRAINED')
  expect(output).toContain('STDERR_DRAINED')
  expect(output).toContain('[redacted]')
  for (const secret of evidence.secrets) expect(output).not.toContain(secret)
  return report.phaseClocks.scenario
}

test('captured host phase reporting stays quiet for a healthy real child', async () => {
  const evidence = await standInHost('healthy')
  expect(evidence.failed).toBe(false)
  expect(evidence.childrenLeft).toBe(0)
  expect(evidence.events).toContain('stdout.drained')
  expect(evidence.events).toContain('stderr.drained')
  expect(evidence.output).toEqual([])
})

test('captured host phase reporting includes failed child clocks and redacts fixture secrets', async () => {
  const phases = assertFailedStandIn(await standInHost('failed'))
  expect(phases['host.cancelled']).toBeUndefined()
  expect(phases['host.deadline']).toBeUndefined()
})

test('captured host cancellation reports only after real child pipes drain', async () => {
  const phases = assertFailedStandIn(await standInHost('cancelled'))
  expect(phases['host.cancelled']).toBeDefined()
  expect(phases['host.deadline']).toBeUndefined()
})

test('captured host scheduled deadline reports only after real child pipes drain', async () => {
  const evidence = await standInHost('deadline')
  const phases = assertFailedStandIn(evidence)
  expect(evidence.timerDelays).toEqual([60_000])
  expect(phases['host.deadline']).toBeDefined()
  expect(phases['host.cancelled']).toBeUndefined()
})

test('captured scenario cleanup drains both server stops before reporting failure', async () => {
  const harness = await captureHostHarness({})
  const relayStarted = Promise.withResolvers<void>()
  const relayStopped = Promise.withResolvers<void>()
  const events: string[] = []
  const clock = harness.phaseClock()
  const stopping = harness
    .stopServers(
      {
        stop(force) {
          expect(force).toBe(true)
          events.push('upstream.stop')
          throw new Error('private transport exception')
        },
      },
      {
        async stop(force) {
          expect(force).toBe(true)
          events.push('relay.stop')
          relayStarted.resolve()
          await relayStopped.promise
          events.push('relay.drained')
        },
      },
      clock,
    )
    .then(
      () => undefined,
      (error: unknown) => {
        events.push('failure.report')
        return error
      },
    )
  await Promise.race([relayStarted.promise, stopping.then(() => {})])
  expect(events).toEqual(['upstream.stop', 'relay.stop'])
  relayStopped.resolve()
  const error = await stopping
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain(
    'Synthetic transport cleanup failed (details redacted)',
  )
  expect(String(error)).not.toContain('private transport exception')
  expect(events).toEqual([
    'upstream.stop',
    'relay.stop',
    'relay.drained',
    'failure.report',
  ])
  expect(clock.phases['fixture.cleanup_failure']).toBeDefined()
})
