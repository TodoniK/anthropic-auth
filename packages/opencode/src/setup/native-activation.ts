import { readFile } from 'node:fs/promises'
import {
  createNativeAccountRuntime,
  discoverNativeVaultInventory,
  inspectNativeHostAuthEntry,
  type NativeCustodyActivationHooks,
  type NativeCustodyInventory,
  NativePiAuthSlotError,
  openNativePiAuthSlot,
  readNativeEnrollmentMode,
  requireNoSupervisedAuthContentSnapshot,
} from '@cortexkit/anthropic-auth-core'

import {
  enrollNativeVaultForHost,
  type NativeVaultEnrollmentOptions,
} from './native-enrollment.ts'
import {
  type NativeSetupPaths,
  resolveNativeSetupPaths,
} from './native-paths.ts'
import { assertHostsStopped } from './process-fence.ts'
import type { CommandRunner, HarnessKind, ProcessFence } from './types.ts'

export class NativeVaultActivationError extends Error {
  constructor(
    public readonly code:
      | 'auth-content-refused'
      | 'host-auth-invalid'
      | 'primary-conflict'
      | 'consent-required'
      | 'primary-unverified',
  ) {
    super(
      {
        'auth-content-refused':
          'Run setup without OPENCODE_AUTH_CONTENT in the environment.',
        'host-auth-invalid': 'The host auth file could not be read safely.',
        'primary-conflict':
          'Pi has a stored Anthropic API key, which would take precedence over the vault account. Remove it in Pi, then rerun setup.',
        'consent-required':
          'Pi has stored Anthropic authentication. Explicit consent is required to move it aside for vault use.',
        'primary-unverified':
          'The vault has no verified default Claude account. Sign in through the vault and rerun setup.',
      }[code],
    )
    this.name = 'NativeVaultActivationError'
  }
}

export interface NativeVaultActivationOptions {
  env: NodeJS.ProcessEnv
  runner: CommandRunner
  fence: ProcessFence
  /** Consent to move Pi's stored authentication aside; never consent to delete it. */
  removePiAnthropicAuth: boolean
  /**
   * Tests override the host paths, enrollment client and vault listing;
   * production resolves them from the host's environment.
   */
  paths?: NativeSetupPaths
  enrollment?: Pick<
    NativeVaultEnrollmentOptions,
    'paths' | 'client' | 'ckBinary' | 'connectionFile'
  >
  discover?: () => Promise<NativeCustodyInventory>
  hooks?: NativeCustodyActivationHooks
}

async function readHostAuth(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return undefined
    throw new NativeVaultActivationError('host-auth-invalid')
  }
}

/**
 * Enroll this stopped host, discover its verified default vault account and
 * leave the host auth slot untouched. Local credentials, migration journal,
 * account metadata and routing assignments are not inputs to this operation.
 */
export async function activateNativeVaultForHost(
  host: HarnessKind,
  options: NativeVaultActivationOptions,
): Promise<'committed' | 'already-vault'> {
  const env = { ...options.env }
  // Checked before every write below: OPENCODE_AUTH_CONTENT (an auth snapshot
  // a supervising OpenCode passes down) must be unset, and no host may run.
  const processFence = async () => {
    try {
      requireNoSupervisedAuthContentSnapshot(env)
    } catch {
      throw new NativeVaultActivationError('auth-content-refused')
    }
    await assertHostsStopped(options.fence)
  }
  await processFence()
  const plan = options.paths ?? (await resolveNativeSetupPaths(host, env))
  if (host === 'pi') {
    const entry = inspectNativeHostAuthEntry(
      'pi',
      await readHostAuth(plan.hostAuthPath),
    )
    const slot = await openNativePiAuthSlot({
      env,
      authPath: plan.hostAuthPath,
    }).inspect()
    if (slot.slot === 'placeholder' && slot.stash === 'missing')
      throw new NativePiAuthSlotError('missing-stash')
    if (
      entry.kind !== 'absent' &&
      slot.slot !== 'placeholder' &&
      !options.removePiAnthropicAuth
    )
      throw new NativeVaultActivationError('consent-required')
  }
  const priorMode = await readNativeEnrollmentMode(host, env)
  await enrollNativeVaultForHost(host, {
    env,
    runner: options.runner,
    processFence,
    ...options.enrollment,
  })
  const discover =
    options.discover ??
    (() =>
      discoverNativeVaultInventory({
        paths: plan.paths,
        host,
        env:
          host === 'pi'
            ? {
                ...env,
                OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE:
                  env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE,
              }
            : env,
      }))
  const runtime = createNativeAccountRuntime({
    paths: plan.paths,
    host,
    vault: { env, discover },
  })
  try {
    await processFence()
    await runtime.vault.refresh()
    const snapshot = await runtime.read()
    const main = snapshot.accounts.find((row) => row.id === 'main')
    if (
      snapshot.mode !== 'claustrum' ||
      !main?.accountIdentity ||
      main.source !== 'vault'
    )
      throw new NativeVaultActivationError('primary-unverified')
    await processFence()
    if (host === 'pi')
      await openNativePiAuthSlot({
        env,
        authPath: plan.hostAuthPath,
      }).enterVault()
    return priorMode === 'claustrum' ? 'already-vault' : 'committed'
  } finally {
    runtime.close()
  }
}
