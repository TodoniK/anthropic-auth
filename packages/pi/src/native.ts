import { resolve } from 'node:path'
import {
  acquireNativeAccountRuntime,
  createNativeUsagePublisher,
  getAccountStatePath,
  getHostClaustrumEnrollmentPaths,
  isKillswitchEnabled,
  killswitchPassesPolicy,
  logger,
  type NativeAccountRuntime,
  type NativeAccountSnapshot,
  type NativeCustodyClient,
  type NativeCustodyReceipt,
  type NativeCustodyReporterSource,
  type NativeLocalExternalPolicy,
  type NativePoolPaths,
  type NativeRefreshResult,
  type NativeVaultWatch,
  nativeMigrationAuthorityPhase,
  nativeRuntimeOptionIdentity,
  quotaSnapshotHasStandardWindows,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  readNativeAccountsForRequest,
  readNativeMigrationJournal,
  resolveClaustrumConnectionPath,
  resolveNativePoolPaths,
} from '@cortexkit/anthropic-auth-core'
import {
  getPiAccountStoragePath,
  getPiClaustrumConnectionOptions,
  getPiConfigDir,
  requirePiNativeHostAuth,
} from './paths.ts'

export type PiNativeAttempt =
  | {
      source: 'local'
      accountIdentity: string
      admission: Extract<NativeRefreshResult, { status: 'usable' }>
    }
  | {
      source: 'vault'
      accountIdentity: string
      receipt: NativeCustodyReceipt
    }

export function piAttemptAccessToken(attempt: PiNativeAttempt): string {
  return attempt.source === 'vault'
    ? attempt.receipt.accessToken
    : attempt.admission.access
}

function requestPolicy(routeId: string, modelId?: string) {
  return (
    account: NativeAccountSnapshot['accounts'][number],
    current: NativeAccountSnapshot,
  ): NativeLocalExternalPolicy => {
    if (!account.enabled)
      return { status: 'blocked', reason: 'account-disabled' }
    if (account.source === 'local' && current.mode !== 'local')
      return { status: 'blocked', reason: 'local-mode-unavailable' }
    const storage = current.policyStorage
    const needsQuotaPolicy =
      quotaSnapshotHasStandardWindows(account.quota) &&
      (account.source !== 'vault' ||
        Boolean(storage.quota?.minimumRemaining) ||
        isKillswitchEnabled(storage))
    const blocked =
      (isKillswitchEnabled(storage) &&
        !killswitchPassesPolicy(
          account.quota,
          storage,
          routeId === 'main' ? undefined : routeId,
          modelId,
        )) ||
      (routeId !== 'main' &&
        ((needsQuotaPolicy &&
          !quotaSnapshotPassesPolicy(account.quota, storage)) ||
          !quotaSnapshotPassesModelScope(account.quota, modelId)))
    return blocked
      ? { status: 'blocked', reason: 'quota-ineligible' }
      : { status: 'allowed' }
  }
}

const runtimes = new Map<
  string,
  { contextKey: string; storagePath: string; runtime: PiNativeRuntime }
>()
const RUNTIME_LIMIT = 16

function runtimeCacheKey(storagePath: string) {
  const enrollment = getHostClaustrumEnrollmentPaths('pi')
  return JSON.stringify([
    resolve(storagePath),
    resolve(getAccountStatePath(storagePath)),
    resolve(getPiConfigDir()),
    enrollment.tokenPath,
    enrollment.statePath,
    getPiClaustrumConnectionOptions(storagePath).identity,
    resolve(
      resolveClaustrumConnectionPath(
        process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE,
        {
          ...process.env,
          OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: undefined,
        },
      ),
    ),
  ])
}

/**
 * Core's refusal for an install that offline setup has never migrated, such
 * as a 1.x install upgraded in place. Core does not export the error class,
 * so it is matched by name and code; no other error matches.
 */
export function isNativeMigrationRequired(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === 'NativeAuthorityError' &&
    Reflect.get(error, 'code') === 'migration-required'
  )
}

/** Checks Pi host authentication and enrollment before delegating credential authorization and metadata writes to the shared account runtime. */
/** How often Pi asks the vault for account changes, matching OpenCode's default. Model requests no longer rediscover a healthy roster, so this poll is how Pi notices a re-login or a newly added account. */
export const PI_VAULT_POLL_INTERVAL_MS = 2000

export interface PiVaultPollOptions {
  /** 0 disables the poll. */
  intervalMs: number
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}

export class PiNativeRuntime {
  private readonly paths: Promise<NativePoolPaths>
  private readonly initialization: Promise<NativeAccountRuntime>
  private vaultWatch: NativeVaultWatch | undefined
  private closed = false
  private closing: Promise<void> | undefined
  readonly usagePublications = createNativeUsagePublisher('native-auth')

  constructor(
    storagePath: string,
    options: {
      connect?: () => Promise<NativeCustodyClient>
      vaultPoll?: PiVaultPollOptions
    } = {},
  ) {
    const env = { ...process.env }
    const poll = options.vaultPoll ?? { intervalMs: PI_VAULT_POLL_INTERVAL_MS }
    const identity = getPiClaustrumConnectionOptions(storagePath).identity
    this.paths = resolveNativePoolPaths(storagePath)
    this.initialization = this.paths.then((paths) => {
      const runtime = acquireNativeAccountRuntime({
        paths,
        host: 'pi',
        vault: {
          // Core checks Pi enrollment and reads a fresh scoped receipt on every send.
          // Keep the injected connector's identity rather than wrapping it per instance.
          connect: options.connect,
          env,
          identity,
        },
      })
      if (this.closed) runtime.close()
      // Refresh returns at once while this host uses local accounts, so the
      // poll costs one enrollment read per tick outside vault custody.
      else if (poll.intervalMs > 0) {
        this.vaultWatch = runtime.vault.watch({
          intervalMs: poll.intervalMs,
          setInterval: poll.setInterval,
          clearInterval: poll.clearInterval,
        })
        // A failed first discovery must not surface as an unhandled rejection;
        // the next poll or a request's bounded refresh retries it.
        void this.vaultWatch.ready.catch(() => {})
      }
      return runtime
    })
    // Initialization is lazy from the host's perspective; a path failure is
    // surfaced by service(), not as an unhandled background rejection.
    void this.initialization.catch(() => {})
  }

  async service(): Promise<NativeAccountRuntime> {
    if (this.closed) throw new Error('Pi native authentication is closed')
    await requirePiNativeHostAuth()
    const runtime = await this.initialization
    if (this.closed) throw new Error('Pi native authentication is closed')
    return runtime
  }

  async routingPath(): Promise<string> {
    return (await this.routingStorage()).path
  }

  async routingStorage(): Promise<{
    path: string
    vaultSeed?: NativeAccountSnapshot['routingSeed']
  }> {
    const runtime = await this.service()
    const snapshot = await runtime.read()
    if (snapshot.mode === 'claustrum') {
      if (!snapshot.routingPath)
        throw new Error('Vault routing storage is unavailable')
      return { path: snapshot.routingPath, vaultSeed: snapshot.routingSeed }
    }
    // Keep local session-to-account assignments at the exact file destination
    // recorded by migration; guessing a new path would lose those assignments.
    const journal = await readNativeMigrationJournal(await this.paths)
    if (
      !journal ||
      !nativeMigrationAuthorityPhase(journal) ||
      !journal.routingPaths.destination
    )
      throw new Error('Pi native routing requires committed offline migration')
    return { path: journal.routingPaths.destination }
  }

  /**
   * Return the account runtime's migration-refusal error when local credentials
   * have not been migrated by offline setup, or undefined when no such refusal
   * occurs. Bypass the Pi login check in service() so older installations with
   * a stored Pi login are recognized too. An enrolled vault may initialize its
   * public settings on this read; local storage is never changed.
   */
  async migrationRefusal(): Promise<Error | undefined> {
    if (this.closed) return undefined
    try {
      await (await this.initialization).read()
      return undefined
    } catch (error) {
      return isNativeMigrationRequired(error) ? error : undefined
    }
  }

  /** Read the published inventory even when no account can serve, so /claude can show its sign-in remedy. */
  async view(signal?: AbortSignal): Promise<NativeAccountSnapshot> {
    const runtime = await this.service()
    signal?.throwIfAborted()
    return runtime.read()
  }

  /** Admit a model request without rediscovering a healthy roster. */
  async requestView(signal?: AbortSignal): Promise<NativeAccountSnapshot> {
    const runtime = await this.service()
    return readNativeAccountsForRequest(runtime, signal)
  }

  async authorize(
    routeId: string,
    signal?: AbortSignal,
    modelId?: string,
  ): Promise<PiNativeAttempt> {
    const runtime = await this.service()
    const snapshot = await runtime.read()
    const account = snapshot.accounts.find(
      (candidate) => candidate.id === routeId,
    )
    if (!account?.enabled || account.type !== 'oauth')
      throw new Error('Pi native OAuth route is unavailable')
    const policy = requestPolicy(routeId, modelId)
    if (policy(account, snapshot).status === 'blocked')
      throw new Error('Pi native quota policy refused the OAuth route')
    if (snapshot.mode === 'claustrum') {
      const receipt = await runtime.authorizeVault(routeId, signal)
      if (!receipt.assertedAccountIdentity)
        throw new Error('Pi native OAuth identity is unasserted')
      const current = await runtime.read()
      const admitted = current.accounts.find(
        (candidate) => candidate.id === routeId,
      )
      // After the vault lookup, recheck quota limits for this request’s model.
      // A policy refusal must not report the OAuth token as invalid.
      if (
        !admitted ||
        current.mode !== 'claustrum' ||
        admitted.accountIdentity !== receipt.assertedAccountIdentity ||
        requestPolicy(routeId, modelId)(admitted, current).status === 'blocked'
      )
        throw new Error('Pi native quota policy refused the OAuth route')
      return {
        source: 'vault',
        accountIdentity: receipt.assertedAccountIdentity,
        receipt,
      }
    }
    const admission = await runtime.authorizeLocal(routeId, { signal, policy })
    if (admission.status !== 'usable' || !admission.binding.identity)
      throw new Error('Pi native OAuth admission refused')
    return {
      source: 'local',
      accountIdentity: admission.binding.identity,
      admission,
    }
  }

  async retry(
    routeId: string,
    served: PiNativeAttempt,
    signal?: AbortSignal,
    modelId?: string,
  ): Promise<PiNativeAttempt | undefined> {
    const runtime = await this.service()
    if (served.source === 'vault') {
      const current = await runtime.read()
      const account = current.accounts.find(
        (candidate) => candidate.id === routeId,
      )
      if (
        !account ||
        current.mode !== 'claustrum' ||
        requestPolicy(routeId, modelId)(account, current).status === 'blocked'
      )
        return undefined
      const decision = await runtime.vault.prepareRetry(served.receipt, signal)
      logger.debug('native-auth', 'Pi 401 retry decision', {
        source: 'vault',
        servedVersion: served.receipt.recordVersion,
        currentVersion: decision.retry
          ? decision.receipt.recordVersion
          : undefined,
        retry: decision.retry,
        reason: decision.retry ? 'rotated' : decision.reason,
      })
      if (!decision.retry || !decision.receipt.assertedAccountIdentity)
        return undefined
      const after = await runtime.read()
      const admitted = after.accounts.find(
        (candidate) => candidate.id === routeId,
      )
      if (
        !admitted ||
        after.mode !== 'claustrum' ||
        admitted.accountIdentity !== decision.receipt.assertedAccountIdentity ||
        requestPolicy(routeId, modelId)(admitted, after).status === 'blocked'
      )
        return undefined
      return {
        source: 'vault',
        accountIdentity: decision.receipt.assertedAccountIdentity,
        receipt: decision.receipt,
      }
    }
    const admission = await runtime.authorizeLocal(routeId, {
      intent: 'refresh',
      rejectedAccessToken: served.admission.access,
      signal,
      policy: requestPolicy(routeId, modelId),
    })
    if (
      admission.status !== 'usable' ||
      admission.binding.identity !== served.accountIdentity ||
      admission.access === served.admission.access
    )
      return undefined
    return {
      source: 'local',
      accountIdentity: served.accountIdentity,
      admission,
    }
  }

  async report(
    served: PiNativeAttempt,
    status: number,
    source: NativeCustodyReporterSource,
  ): Promise<void> {
    if (served.source === 'vault' && status === 401)
      await (await this.service()).vault.reportFailure(
        served.receipt,
        status,
        source,
      )
  }

  async markUsed(
    served: PiNativeAttempt,
    servingRuntime?: NativeAccountRuntime,
  ): Promise<void> {
    const runtime = servingRuntime ?? (await this.service())
    const patch = { lastUsed: Date.now() }
    if (served.source === 'vault')
      await runtime.vault.publish(served.receipt, patch)
    else await runtime.publishLocal(served.admission.subject, patch)
  }

  close(): Promise<void> {
    this.closed = true
    this.vaultWatch?.close()
    this.closing ??= (async () => {
      await this.usagePublications.drain()
      await this.initialization.then(
        (runtime) => runtime.close(),
        () => {},
      )
    })()
    return this.closing
  }
}

export function getPiNativeRuntime(
  storagePath = getPiAccountStoragePath(),
  options: {
    connect?: () => Promise<NativeCustodyClient>
    vaultPoll?: PiVaultPollOptions
  } = {},
): PiNativeRuntime {
  const contextKey = runtimeCacheKey(storagePath)
  const key = JSON.stringify([
    contextKey,
    nativeRuntimeOptionIdentity(options.connect),
  ])
  const existing = runtimes.get(key)
  if (existing) return existing.runtime
  if (!options.connect) {
    // A supplied connector installs the context's test transport. Ordinary host
    // lookups reuse it, but an explicitly different connector owns another key.
    const configured = [...runtimes.values()].find(
      (entry) => entry.contextKey === contextKey,
    )
    if (configured) return configured.runtime
  }
  const runtime = new PiNativeRuntime(storagePath, options)
  while (runtimes.size >= RUNTIME_LIMIT) {
    const oldest = runtimes.keys().next().value
    if (oldest === undefined) break
    void runtimes.get(oldest)?.runtime.close()
    runtimes.delete(oldest)
  }
  runtimes.set(key, { contextKey, storagePath: resolve(storagePath), runtime })
  return runtime
}

export function closePiNativeRuntime(
  storagePath = getPiAccountStoragePath(),
): Promise<void> {
  const closing: Promise<void>[] = []
  for (const [key, entry] of runtimes) {
    if (entry.storagePath !== resolve(storagePath)) continue
    runtimes.delete(key)
    closing.push(entry.runtime.close())
  }
  return Promise.all(closing).then(() => {})
}
