import {
  type OpenPoolStoreOptions,
  openPoolStore,
} from '@cortexkit/common-auth/store'

import {
  type NativeLockEvent,
  nativeLockObserver,
} from './native-lock-observer.ts'
import type { NativePoolPaths } from './pool-paths.ts'

export type { NativeLockEvent } from './native-lock-observer.ts'

interface NativeQuotaCodec {
  validate(value: unknown): boolean
  merge(stored: unknown | undefined, observation: unknown): unknown
}

export type NativePoolStorePaths = Pick<NativePoolPaths, 'config' | 'state'>

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
  return openPoolStore({
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
}
