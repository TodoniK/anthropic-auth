import { classifySafeErrorForLog, logger } from '@cortexkit/anthropic-auth-core'

export function logFallbackQuotaPreflightWarning(
  accountId: string,
  requiredByPolicy: boolean,
  error: unknown,
) {
  logger.warn('quota', 'fallback quota preflight could not obtain a reading', {
    accountId,
    requiredByPolicy,
    ...classifySafeErrorForLog(error),
  })
}
