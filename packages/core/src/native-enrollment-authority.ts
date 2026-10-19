import {
  enrollmentAuthority,
  readClaustrumEnrollmentStatus,
} from '@cortexkit/common-auth/claustrum'

import { getHostClaustrumEnrollmentPaths } from './claustrum-enrollment.ts'
import { logger } from './logger.ts'
import { NativeCustodyError } from './native-custody.ts'
import { closeNativeVaultAuthority } from './native-vault-invalidation.ts'

const stages = new Set([
  'safe-parent',
  'directory',
  'verify',
  'read',
  'open',
  'decode',
])
const reasons = new Set([
  'unsupported-filesystem',
  'wrong-owner',
  'extra-ace',
  'not-protected',
  'null-dacl',
  'empty-dacl',
  'reparse-point',
  'unsafe-ancestor',
  'wrong-kind',
  'io-error',
  'mode',
  'invalid-state',
  'invalid-token',
  'unsafe-file',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ETIMEDOUT',
  'ERR_PRIVATE_FILES_SECURITY',
])

async function logRefusal(
  host: 'opencode' | 'pi',
  paths: ReturnType<typeof getHostClaustrumEnrollmentPaths>,
  readStatus: typeof readClaustrumEnrollmentStatus,
) {
  let stage = 'enrollment'
  let reason = 'unreadable'
  try {
    // The shared authority intentionally closes errors. A failure-only probe
    // recovers diagnostic codes without changing the authority decision.
    await readStatus(paths, `anthropic-auth-${host}`)
  } catch (error) {
    let current: unknown = error
    for (
      let depth = 0;
      depth < 4 && current && typeof current === 'object';
      depth++
    ) {
      const detail = current as {
        stage?: string
        reason?: string
        code?: string
        kind?: string
        cause?: unknown
      }
      if (detail.stage && stages.has(detail.stage)) stage = detail.stage
      for (const value of [detail.kind, detail.code, detail.reason])
        if (value && reasons.has(value)) reason = value
      current = detail.cause
    }
  }
  logger.warn('enrollment', 'Native enrollment authority refused', {
    host,
    stage,
    reason,
  })
}

/** Enrollment files, not account settings, choose the host's credential source. */
export async function readNativeEnrollmentMode(
  host: 'opencode' | 'pi',
  env: NodeJS.ProcessEnv = process.env,
  dependencies = { enrollmentAuthority, readClaustrumEnrollmentStatus },
): Promise<'local' | 'claustrum'> {
  const paths = getHostClaustrumEnrollmentPaths(host, env)
  const authority = await dependencies.enrollmentAuthority(
    paths,
    `anthropic-auth-${host}`,
  )
  if (authority !== 'vault')
    closeNativeVaultAuthority(
      getHostClaustrumEnrollmentPaths(host, env).tokenPath,
    )
  if (authority === 'unreadable') {
    await logRefusal(host, paths, dependencies.readClaustrumEnrollmentStatus)
    throw new NativeCustodyError('invalid-token')
  }
  return authority === 'vault' ? 'claustrum' : 'local'
}
