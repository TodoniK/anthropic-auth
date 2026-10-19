import type * as PrivateFiles from '@cortexkit/private-files'

/** Per-operation injection keeps simulated Windows policy out of process globals. */
export interface OwnerOnlyOptions {
  platform?: NodeJS.Platform
  privateFiles?: Pick<
    typeof PrivateFiles,
    'verifyOwnerOnly' | 'readPrivateFile'
  > &
    Partial<Pick<typeof PrivateFiles, 'verifySafeParent' | 'createPrivateFile'>>
}

async function windowsBackend(options: OwnerOnlyOptions) {
  if ((options.platform ?? process.platform) !== 'win32') return undefined
  return options.privateFiles ?? import('@cortexkit/private-files')
}

/** POSIX callers retain their exact mode/uid policy; Windows must prove its DACL. */
export async function isOwnerOnly(
  path: string,
  posix: () => boolean,
  options: OwnerOnlyOptions = {},
): Promise<boolean> {
  const api = await windowsBackend(options)
  return api ? (await api.verifyOwnerOnly(path)).ok : posix()
}

/** Windows reads through the ACL-verified native handle, not a pathname reopen. */
export async function readWindowsOwnerOnly(
  path: string,
  options: OwnerOnlyOptions = {},
): Promise<Buffer | undefined> {
  const api = await windowsBackend(options)
  if (!api) return undefined
  const verdict = await api.verifyOwnerOnly(path)
  if (!verdict.ok && verdict.refusal.reason !== 'io-error')
    throw new Error('Owner-only storage refused')
  try {
    return await api.readPrivateFile(path)
  } catch (error) {
    // Only native file/path-not-found codes prove absence, not a refused ACL.
    const detail = error as { reason?: string; win32Code?: number }
    if (detail.reason === 'io-error' && [2, 3].includes(detail.win32Code ?? 0))
      throw Object.assign(new Error('Private file absent'), { code: 'ENOENT' })
    throw error
  }
}

/** Ancestors protect directory entries; they need not themselves be private. */
export async function isSafeWindowsParent(
  path: string,
  options: OwnerOnlyOptions = {},
): Promise<boolean | undefined> {
  const api = await windowsBackend(options)
  if (!api) return undefined
  if (!api.verifySafeParent) throw new Error('Safe-parent verifier unavailable')
  return (await api.verifySafeParent(path)).ok
}

/** Native creation establishes a protected DACL before any bytes are written. */
export async function createWindowsOwnerOnly(
  path: string,
  bytes: string,
  options: OwnerOnlyOptions = {},
): Promise<boolean> {
  const api = await windowsBackend(options)
  if (!api) return false
  if (!api.createPrivateFile)
    throw new Error('Private-file creation unavailable')
  await api.createPrivateFile(path, bytes)
  return true
}
