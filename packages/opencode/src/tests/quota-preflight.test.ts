import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  NativeCustodyError,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'

import { logFallbackQuotaPreflightWarning } from '../quota-preflight.ts'

const records: LogTestRecord[] = []
let previousLevel: ReturnType<typeof getLogLevel>

beforeEach(() => {
  previousLevel = getLogLevel()
  setLogLevel('info')
})

afterEach(() => {
  records.length = 0
  __setLogTestSink(null)
  setLogLevel(previousLevel)
})

test('fallback quota warning records allowlisted classifications without exception text', () => {
  __setLogTestSink((record) => records.push(record))
  const secret = 'sk-ant-oat-secret-canary'
  const errors = [
    {
      error: Object.assign(new TypeError(`socket failed: ${secret}`), {
        code: 'ETIMEDOUT',
      }),
      expected: { name: 'TypeError', code: 'ETIMEDOUT' },
    },
    {
      error: Object.assign(new Error(`provider refused: ${secret}`), {
        status: 503,
      }),
      expected: { name: 'Error', code: 'HTTP_503' },
    },
    {
      error: new NativeCustodyError('route-unavailable'),
      expected: { name: 'NativeCustodyError', code: 'route-unavailable' },
    },
    {
      error: Object.assign(new Error(`unclassified: ${secret}`), {
        name: '/private/path',
        code: 'secret-code',
      }),
      expected: { name: 'unknown', code: 'unknown' },
    },
  ]

  for (const [index, item] of errors.entries())
    logFallbackQuotaPreflightWarning(`fallback-${index}`, false, item.error)

  expect(records).toHaveLength(errors.length)
  for (const [index, item] of errors.entries()) {
    expect(records[index]).toMatchObject({
      level: 'warn',
      channel: 'quota',
      message: 'fallback quota preflight could not obtain a reading',
      payload: {
        accountId: `fallback-${index}`,
        requiredByPolicy: false,
        ...item.expected,
      },
    })
  }
  expect(JSON.stringify(records)).not.toContain(secret)
  expect(JSON.stringify(records)).not.toContain('provider refused')
})
