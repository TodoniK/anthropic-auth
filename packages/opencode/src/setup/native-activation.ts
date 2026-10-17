import { readFile } from 'node:fs/promises'
import {
  assertHostsStopped,
  createNativeAccountRuntime,
  discoverNativeVaultInventory,
  inspectNativeHostAuthEntry,
  type NativeCustodyActivationHooks,
  type NativeCustodyInventory,
  NativePiAuthSlotError,
  nativePiAuthSlotPaths,
  openNativePiAuthSlot,
  readNativeEnrollmentMode,
  requireNoSupervisedAuthContentSnapshot,
} from '@cortexkit/anthropic-auth-core'
import {
  enrollNativeVaultForHost,
  grantNativeVaultForHost,
  type NativeVaultEnrollmentOptions,
} from './native-enrollment.ts'
import { nativeSetupFileFingerprint } from './native-local.ts'
import {
  type NativeSetupPaths,
  resolveNativeSetupPaths,
} from './native-paths.ts'
import {
  type CommandRunner,
  type HarnessKind,
  type ProcessFence,
  SetupRefusal,
  setupProcessInspectionMessage,
} from './types.ts'

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
  /** Set false for OpenCode 2, whose setup must not read the OpenCode 1 auth file. */
  inspectOpenCodeAuth?: boolean
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

export interface NativeVaultPreflight {
  priorMode: 'local' | 'claustrum'
  fingerprint: string
  separateOpenCodeLogin?: boolean
}

export async function fingerprintNativeVaultInputs(
  host: HarnessKind,
  options: NativeVaultActivationOptions,
): Promise<string> {
  if (host === 'opencode') return 'opencode'
  const plan =
    options.paths ?? (await resolveNativeSetupPaths(host, options.env))
  const entry = inspectNativeHostAuthEntry(
    host,
    await readHostAuth(plan.hostAuthPath),
  )
  const slot = openNativePiAuthSlot({
    env: options.env,
    authPath: plan.hostAuthPath,
  })
  const { stashPath } = nativePiAuthSlotPaths({
    env: options.env,
    authPath: plan.hostAuthPath,
  })
  return JSON.stringify([
    entry.digest,
    await slot.inspect(),
    await nativeSetupFileFingerprint(stashPath),
  ])
}

async function vaultProcessFence(
  options: NativeVaultActivationOptions,
): Promise<void> {
  try {
    requireNoSupervisedAuthContentSnapshot(options.env)
  } catch {
    throw new NativeVaultActivationError('auth-content-refused')
  }
  try {
    await assertHostsStopped(options.fence, options.env)
  } catch (error) {
    const message = setupProcessInspectionMessage(error)
    if (message) throw new SetupRefusal(message)
    throw error
  }
}

/** Validate vault inputs before the runner enrolls any selected host. */
export async function preflightNativeVaultForHost(
  host: HarnessKind,
  options: NativeVaultActivationOptions,
): Promise<NativeVaultPreflight> {
  const env = { ...options.env }
  const processFence = () => vaultProcessFence({ ...options, env })
  await processFence()
  const plan = options.paths ?? (await resolveNativeSetupPaths(host, env))
  const separateOpenCodeLogin =
    host === 'opencode' &&
    options.inspectOpenCodeAuth !== false &&
    inspectNativeHostAuthEntry(
      'opencode',
      await readHostAuth(plan.hostAuthPath),
    ).kind === 'oauth'
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
  return {
    priorMode: await readNativeEnrollmentMode(host, env),
    fingerprint: await fingerprintNativeVaultInputs(host, { ...options, env }),
    separateOpenCodeLogin,
  }
}

/** Grant native-account read access and require a vault-backed default Claude account with an account identity before moving Pi's login aside. */
export async function completeNativeVaultActivation(
  host: HarnessKind,
  options: NativeVaultActivationOptions,
  preflight: NativeVaultPreflight,
): Promise<'committed' | 'already-vault'> {
  const env = { ...options.env }
  const processFence = () => vaultProcessFence({ ...options, env })
  await processFence()
  const plan = options.paths ?? (await resolveNativeSetupPaths(host, env))
  if (
    (await fingerprintNativeVaultInputs(host, options)) !==
    preflight.fingerprint
  )
    throw new NativeVaultActivationError('host-auth-invalid')
  await grantNativeVaultForHost(host, {
    env,
    runner: options.runner,
    processFence,
    ckBinary: options.enrollment?.ckBinary,
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
    return preflight.priorMode === 'claustrum' ? 'already-vault' : 'committed'
  } finally {
    runtime.close()
  }
}

/** Outside runSetup, check inputs, enroll the host, then grant and activate vault access. runSetup owns enrollment and calls preflight and completion separately. */
export async function activateNativeVaultForHost(
  host: HarnessKind,
  options: NativeVaultActivationOptions,
): Promise<'committed' | 'already-vault'> {
  const operation = { ...options, env: { ...options.env } }
  const preflight = await preflightNativeVaultForHost(host, operation)
  await enrollNativeVaultForHost(host, {
    env: operation.env,
    runner: operation.runner,
    processFence: () => vaultProcessFence(operation),
    ...operation.enrollment,
    grantPermissions: false,
  })
  return completeNativeVaultActivation(host, operation, preflight)
}
