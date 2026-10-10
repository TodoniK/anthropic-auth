import { enrollmentAuthority } from '@cortexkit/common-auth/claustrum'

import { getHostClaustrumEnrollmentPaths } from './claustrum-enrollment.ts'
import { NativeCustodyError } from './native-custody.ts'

/** Enrollment files, not account settings, choose the host's credential source. */
export async function readNativeEnrollmentMode(
  host: 'opencode' | 'pi',
  env: NodeJS.ProcessEnv = process.env,
): Promise<'local' | 'claustrum'> {
  const authority = await enrollmentAuthority(
    getHostClaustrumEnrollmentPaths(host, env),
    `anthropic-auth-${host}`,
  )
  if (authority === 'unreadable') throw new NativeCustodyError('invalid-token')
  return authority === 'vault' ? 'claustrum' : 'local'
}
