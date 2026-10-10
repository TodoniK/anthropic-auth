import { readNativeMigrationSource } from './migration-source.ts'
import {
  inspectNativeHostAuthEntry,
  type NativeHostAuthEntryInspection,
  NativeHostAuthError,
} from './native-host-auth.ts'

/** Read only the host's login classification; credentials and source fingerprints never leave this boundary. */
export async function readNativeHostAuthKind(
  host: 'opencode' | 'pi',
  path: string,
): Promise<NativeHostAuthEntryInspection['kind']> {
  try {
    if (host !== 'opencode' && host !== 'pi')
      throw new NativeHostAuthError('invalid-source')
    const snapshot = await readNativeMigrationSource('hostAuth', path)
    if (snapshot.metadata) {
      const uid =
        typeof process.getuid === 'function' ? process.getuid() : undefined
      if (
        (uid !== undefined && snapshot.metadata.uid !== uid) ||
        (snapshot.metadata.mode & 0o077) !== 0
      )
        throw new NativeHostAuthError('invalid-source')
    }
    return inspectNativeHostAuthEntry(host, snapshot.data).kind
  } catch {
    // A failed read must not look like an empty slot or expose another provider's credentials.
    throw new NativeHostAuthError('invalid-source')
  }
}
