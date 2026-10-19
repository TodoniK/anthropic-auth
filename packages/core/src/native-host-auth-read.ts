import { readNativeMigrationSource } from './migration-source.ts'
import {
  inspectNativeHostAuthEntry,
  type NativeHostAuthEntryInspection,
  NativeHostAuthError,
} from './native-host-auth.ts'
import { isOwnerOnly, type OwnerOnlyOptions } from './owner-only.ts'

/** Read only the host's login classification; credentials and source fingerprints never leave this boundary. */
export async function readNativeHostAuthKind(
  host: 'opencode' | 'pi',
  path: string,
  ownership: OwnerOnlyOptions = {},
): Promise<NativeHostAuthEntryInspection['kind']> {
  try {
    if (host !== 'opencode' && host !== 'pi')
      throw new NativeHostAuthError('invalid-source')
    const snapshot = await readNativeMigrationSource('hostAuth', path, {
      ownership,
    })
    if (snapshot.metadata) {
      const uid =
        typeof process.getuid === 'function' ? process.getuid() : undefined
      if (
        !(await isOwnerOnly(
          path,
          () =>
            (uid === undefined || snapshot.metadata?.uid === uid) &&
            ((snapshot.metadata?.mode ?? 0) & 0o077) === 0,
          ownership,
        ))
      )
        throw new NativeHostAuthError('invalid-source')
    }
    return inspectNativeHostAuthEntry(host, snapshot.data).kind
  } catch {
    // A failed read must not look like an empty slot or expose another provider's credentials.
    throw new NativeHostAuthError('invalid-source')
  }
}
