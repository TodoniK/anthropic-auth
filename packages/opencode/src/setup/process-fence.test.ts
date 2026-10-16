import { expect, test } from 'bun:test'
import { ProcessFenceViolationError } from './process-fence.ts'

test('active process diagnostics never serialize command arguments', () => {
  const error = new ProcessFenceViolationError([
    { pid: 123, command: '/synthetic/opencode --key synthetic-command-secret' },
  ])
  expect(error.message).toContain('PID 123: opencode')
  expect(error.message).not.toContain('synthetic-command-secret')
  expect(JSON.stringify(error)).not.toContain('synthetic-command-secret')
})
