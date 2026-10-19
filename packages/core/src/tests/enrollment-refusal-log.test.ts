import { expect, test } from 'bun:test'
import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import { readNativeEnrollmentMode } from '../native-enrollment-authority.ts'

test('enrollment refusal logs allowlisted stage and reason without token bytes or paths', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  try {
    await expect(
      readNativeEnrollmentMode(
        'opencode',
        {},
        {
          enrollmentAuthority: async () => 'unreadable',
          readClaustrumEnrollmentStatus: async () => {
            throw Object.assign(new Error('C:/private/synthetic-token-bytes'), {
              path: 'C:/private/synthetic-token-bytes',
              stage: 'safe-parent',
              reason: 'unsupported-filesystem',
            })
          },
        },
      ),
    ).rejects.toThrow('Native custody refused: invalid-token')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      level: 'warn',
      channel: 'enrollment',
      payload: {
        host: 'opencode',
        stage: 'safe-parent',
        reason: 'unsupported-filesystem',
      },
    })
    expect(JSON.stringify(records)).not.toContain('private')
    expect(JSON.stringify(records)).not.toContain('synthetic-token-bytes')
  } finally {
    __setLogTestSink(null)
  }
})

test('enrollment refusal does not log unrecognized error properties', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  try {
    await expect(
      readNativeEnrollmentMode(
        'pi',
        {},
        {
          enrollmentAuthority: async () => 'unreadable',
          readClaustrumEnrollmentStatus: async () => {
            throw {
              stage: 'C:/secret',
              code: 'token-bytes',
              reason: 'token-bytes',
            }
          },
        },
      ),
    ).rejects.toThrow('Native custody refused: invalid-token')
    expect(records[0]).toMatchObject({
      payload: { stage: 'enrollment', reason: 'unreadable' },
    })
    expect(JSON.stringify(records)).not.toContain('token-bytes')
  } finally {
    __setLogTestSink(null)
  }
})
