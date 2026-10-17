const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

function errorField(error: unknown, field: 'code' | 'message') {
  if (!error || typeof error !== 'object') return undefined
  const value = (error as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

export function transientNetworkErrorCode(error: unknown) {
  const code = errorField(error, 'code')
  if (code && TRANSIENT_NETWORK_ERROR_CODES.has(code)) return code

  const message =
    error instanceof Error
      ? error.message
      : (errorField(error, 'message') ?? String(error))
  if (message.includes('fetch failed')) return 'ECONNRESET'
  return [...TRANSIENT_NETWORK_ERROR_CODES].find((candidate) =>
    message.includes(candidate),
  )
}

export function isTransientNetworkError(error: unknown) {
  return transientNetworkErrorCode(error) !== undefined
}
