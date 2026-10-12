import { logger } from './logger.ts'

/**
 * Custody, ownership and integrity refusals need an ERROR diagnostic; ordinary
 * storage failures need a WARN. Neither may revoke an already-served reply.
 * The error classes are not public runtime exports, so match name and code.
 */
export function usagePublicationRefusalIsFatal(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'NativeCustodyError') return true
  if (error.name !== 'NativeRuntimeError') return false
  const code: unknown = Reflect.get(error, 'code')
  return (
    code === 'publication-refused' ||
    code === 'unsafe-runtime' ||
    code === 'invalid-runtime'
  )
}

const names = new Set([
  'Error',
  'NativeCustodyError',
  'NativeRuntimeError',
  'LockContentionError',
])
const codes = new Set([
  'closed',
  'not-enrolled',
  'invalid-token',
  'unavailable',
  'identity-changed',
  'identity-unasserted',
  'insufficient-validity',
  'invalid-material',
  'not-active',
  'route-unavailable',
  'route-declined',
  'no-receipt',
  'unsafe-file',
  'invalid-state',
  'wrong-consumer',
  'roster-busy',
  'host-slot-login',
  'host-slot-placeholder',
  'placeholder-refresh',
  'publication-refused',
  'unsafe-runtime',
  'invalid-runtime',
  'runtime-io',
  'runtime-conflict',
  'EIO',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
])

function logPublicationFailure(channel: string, error: unknown): void {
  let level: 'error' | 'warn' = 'warn'
  let name = 'unknown'
  let code = 'unknown'
  try {
    if (usagePublicationRefusalIsFatal(error)) level = 'error'
    if (error instanceof Error) {
      if (names.has(error.name)) name = error.name
      const value: unknown = Reflect.get(error, 'code')
      if (typeof value === 'string' && codes.has(value)) code = value
    }
  } catch {
    // An arbitrary thrown object may have getters that throw. Do not inspect
    // it further or let diagnostic extraction reject the detached task.
  }
  logger[level](channel, 'Account usage publication unavailable', {
    name,
    code,
  })
}

/** Own advisory writes for one host instance and join them before runtime close. */
export function createNativeUsagePublisher(channel: string) {
  const pending = new Set<Promise<void>>()
  return {
    publish(write: () => Promise<unknown>): void {
      // A new event-loop turn gives the host its response before bookkeeping
      // starts, including when the writer does synchronous work before await.
      const work = new Promise<void>((resolve) => setTimeout(resolve, 0))
        .then(write)
        .then(
          () => {},
          (error: unknown) => logPublicationFailure(channel, error),
        )
      pending.add(work)
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      )
    },
    async drain(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending])
    },
  }
}
