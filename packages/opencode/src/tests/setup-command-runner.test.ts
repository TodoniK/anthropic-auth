import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultCommandRunner } from '../setup/command-runner.ts'

test('setup runner preserves a nonzero exit and captured output', async () => {
  const result = await defaultCommandRunner.run(process.execPath, [
    '-e',
    'console.log("install stdout"); console.error("install stderr"); process.exit(7)',
  ])
  expect(result.exitCode).toBe(7)
  expect(result.signal).toBeNull()
  expect(result.spawnError).toBeUndefined()
  expect(result.stdout).toBe('install stdout\n')
  expect(result.stderr).toBe('install stderr\n')
})

test('setup runner preserves the terminating signal without calling it a spawn failure', async () => {
  const result = await defaultCommandRunner.run(process.execPath, [
    '-e',
    'process.kill(process.pid, "SIGTERM")',
  ])
  expect(result.exitCode).toBe(1)
  expect(result.signal).toBe('SIGTERM')
  expect(result.spawnError).toBeUndefined()
})

test('setup runner marks a missing executable as a spawn failure', async () => {
  const result = await defaultCommandRunner.run(
    join(tmpdir(), `missing-setup-command-${randomUUID()}`),
    [],
  )
  expect(result.exitCode).toBe(1)
  expect(result.signal).toBeNull()
  expect(result.spawnError).toBe(true)
})
