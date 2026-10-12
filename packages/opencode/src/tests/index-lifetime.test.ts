import { expect } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTestLifetimeSuite,
  TestLifetime,
} from '../../../core/src/tests/test-lifetime.ts'

const suite = createTestLifetimeSuite()

/** Capture the owning suite's cleanup hook without importing its tests or plugins. */
async function outerCleanupHook(): Promise<
  (cleanup: () => Promise<void>, lifetime: TestLifetime) => Promise<unknown>
> {
  const source = await readFile(
    new URL('./index.test.ts', import.meta.url),
    'utf8',
  )
  const marker = 'afterEach(async () => {\n  const lifetime = testLifetime\n'
  const start = source.indexOf(marker)
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0)
    throw new Error('Expected one outer fixture cleanup hook')
  const bodyStart = start + 'afterEach(async () => {'.length
  const end = source.indexOf('\n})', bodyStart)
  if (end < 0) throw new Error('Missing outer fixture cleanup hook terminator')
  const body = source.slice(bodyStart, end)
  const captured = new Function(
    'cleanupTempConfigDirs',
    'testLifetime',
    `return (async () => {${body}\n})()`,
  )
  return (cleanup, lifetime) =>
    Promise.resolve(Reflect.apply(captured, undefined, [cleanup, lifetime]))
}

suite.test(
  'index fixture cleanup drains held body writes before removing their directories',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'index-lifetime-order-'))
    suite.deferCleanup(() => rm(directory, { recursive: true, force: true }))
    const lifetime = new TestLifetime()
    const closing = suite.gate()
    // Cancellation must reach the private lifetime before the outer test joins
    // its writer. This also releases the writer if this test is interrupted.
    suite.trackDetached(closing.wait.then(() => lifetime.finish()))
    const release = lifetime.gate()
    const events: string[] = []
    const writer = lifetime.runBody(async () => {
      await release.wait
      await writeFile(join(directory, 'finished.txt'), 'body completed')
      events.push('body-write')
    })
    const hook = await outerCleanupHook()
    const cleanup = async () => {
      events.push('remove-directory')
      await rm(directory, { recursive: true, force: true })
    }
    const completion = hook(cleanup, lifetime)
    try {
      const outcomes = await Promise.allSettled([writer, completion])
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ])
      expect(events).toEqual(['body-write', 'remove-directory'])
    } finally {
      closing.open()
      await Promise.allSettled([writer, completion, lifetime.finish()])
    }
  },
)
