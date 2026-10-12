import {
  type OpenPoolStoreOptions,
  openPoolStore,
} from '@cortexkit/common-auth/store'

import {
  type NativeLockEvent,
  nativeLockObserver,
} from './native-lock-observer.ts'
import {
  nativeVaultFileAbsent,
  readNativeVaultLegacySettings,
} from './native-vault-seed.ts'
import type { NativePoolPaths } from './pool-paths.ts'

export type { NativeLockEvent } from './native-lock-observer.ts'

interface NativeQuotaCodec {
  validate(value: unknown): boolean
  merge(stored: unknown | undefined, observation: unknown): unknown
}

export type NativePoolStorePaths = Pick<NativePoolPaths, 'config' | 'state'> & {
  legacySeedConfig?: string
}

export interface NativePoolStoreOptions
  extends Pick<
    OpenPoolStoreOptions,
    'now' | 'onStep' | 'hold' | 'logger' | 'onLockStep'
  > {
  paths: NativePoolStorePaths
  quota: NativeQuotaCodec
  onLockEvent?: (event: NativeLockEvent) => void
}

/**
 * These config/state locks also fence local account metadata against concurrent
 * credential changes. Legacy sidecar writers use different files and locks.
 */
export function nativePoolStoreLocks(paths: NativePoolStorePaths) {
  return [
    { path: paths.config, name: 'pool-config' },
    { path: paths.state, name: 'pool-state' },
  ] as const
}

/**
 * Storage machinery only. Callers must separately establish local migration
 * authority or vault enrollment authority before using these files.
 */
export function createNativePoolStore(options: NativePoolStoreOptions) {
  const store = openPoolStore({
    provider: 'anthropic',
    configPath: options.paths.config,
    statePath: options.paths.state,
    storeLocks: nativePoolStoreLocks(options.paths),
    requireCredentialStamps: true,
    quota: options.quota,
    now: options.now,
    onStep: options.onStep,
    hold: options.hold,
    logger: options.logger,
    onLockEvent: nativeLockObserver(options.onLockEvent),
    onLockStep: options.onLockStep,
  })
  const legacyConfig = options.paths.legacySeedConfig
  if (!legacyConfig) return store
  return {
    ...store,
    updateSettings: ((mutator, callOptions) =>
      store.updateSettings(async (draft) => {
        // The config/state file locks are held while creating vault settings.
        // Write legacy preferences together with the discovered default account's
        // route and UUID; any existing settings file prevents later imports.
        if (await nativeVaultFileAbsent(options.paths.config))
          Object.assign(
            draft,
            await readNativeVaultLegacySettings(legacyConfig),
          )
        return mutator(draft)
      }, callOptions)) satisfies typeof store.updateSettings,
  }
}
