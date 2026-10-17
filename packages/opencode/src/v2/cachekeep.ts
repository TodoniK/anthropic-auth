import {
  CacheKeepManager,
  type CacheKeepPrewarmAttempt,
  CacheKeepSessionRegistry,
  type CacheKeepTarget,
  getDefaultCacheKeepRegistryDirectory,
  isCacheKeepActiveNow,
  isCacheKeepHybridActive,
  isCacheKeepSubagentsEnabled,
  logger,
  type NativeAccountRuntime,
  type NativeAccountView,
} from '@cortexkit/anthropic-auth-core'
import type { Attempt, RequestScope } from '@cortexkit/common-auth/opencode2'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAttemptData,
} from './adapter'
import type { NativeSource, NativeSourceProvenance } from './source'

export interface NativeCacheKeepOptions {
  readonly now?: () => number
  readonly setIntervalImpl?: typeof globalThis.setInterval
  readonly clearIntervalImpl?: typeof globalThis.clearInterval
  readonly registryDirectory?: string
}

// Token refreshes preserve this identity; replacing a local row or a vault
// credential does not. Never warm a previous login's prefix on its replacement.
function accountKey(account: NativeAccountView) {
  return JSON.stringify([
    account.source,
    account.accountIdentity,
    account.credentialId,
    account.binding?.storageId,
    account.binding?.rowId,
    account.binding?.credentialEpoch,
  ])
}

/** Keep admitted hybrid-cache prefixes warm using fresh native authorization for each send. */
export function createNativeCacheKeep(
  options: NativeCacheKeepOptions & {
    runtime: NativeAccountRuntime
    source: NativeSource
    fetch?: typeof fetch
    isSubagent?: (sessionID: string) => Promise<boolean>
  },
) {
  const { runtime, source } = options
  const abort = new AbortController()
  let stopped = false
  const registry = new CacheKeepSessionRegistry({
    directory:
      options.registryDirectory ||
      process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR ||
      getDefaultCacheKeepRegistryDirectory('opencode'),
    now: options.now,
  })
  const prepared = new Map<
    number,
    { target: CacheKeepTarget; attempt: CacheKeepPrewarmAttempt }
  >()
  const send = async (
    target: CacheKeepTarget,
    warm: Request,
    deadline?: AbortSignal,
  ) => {
    const signal = deadline
      ? AbortSignal.any([abort.signal, deadline])
      : abort.signal
    signal.throwIfAborted()
    const body = JSON.parse(await warm.text()) as { model: string }
    const scope: RequestScope = {
      providerID: 'anthropic',
      modelID: body.model,
      sessionID: `oc2-cachekeep:${target.id}`,
      agent: 'cachekeep',
      kind: 'generate',
    }
    const native = createNativeAnthropicAdapter({
      source: {
        ...source,
        // Background sends must not extend a user turn's billing or diagnostics
        // chain, nor register themselves as fresh live-session activity.
        onRequestPrepared: undefined,
        responseOptions: undefined,
        async requestOptions(input) {
          const policy = await source.requestOptions?.(input)
          return {
            ...policy,
            laneStart: false,
            billingLineage: undefined,
            cacheDiagnosticsPreviousMessageId: undefined,
          }
        },
        async authorizeAccount(input, accountId) {
          const snapshot = await runtime.read()
          signal.throwIfAborted()
          const account = snapshot.accounts.find((row) => row.id === accountId)
          if (
            account?.type !== 'oauth' ||
            accountKey(account) !== target.oauthAccountIdentity ||
            (target.isSubagent &&
              !isCacheKeepSubagentsEnabled(snapshot.policyStorage)) ||
            !isCacheKeepHybridActive(snapshot.policyStorage) ||
            !isCacheKeepActiveNow(
              snapshot.policyStorage,
              new Date(options.now?.() ?? Date.now()),
            )
          )
            return undefined
          const authorized = await source.authorizeAccount(input, accountId)
          if (
            authorized?.provenance.kind === 'local' &&
            accountKey({
              ...account,
              binding: authorized.provenance.subject.binding,
              accountIdentity: authorized.provenance.subject.binding.identity,
            }) !== target.oauthAccountIdentity
          )
            return undefined
          if (
            authorized?.provenance.kind === 'vault' &&
            authorized.provenance.credentialId !== account.credentialId
          )
            return undefined
          return authorized
        },
        async admitRequest(input) {
          await source.admitRequest?.(input)
          const snapshot = await runtime.read()
          const account = snapshot.accounts.find(
            (row) => row.id === input.accountId,
          )
          signal.throwIfAborted()
          if (
            !account ||
            accountKey(account) !== target.oauthAccountIdentity ||
            (target.isSubagent &&
              !isCacheKeepSubagentsEnabled(snapshot.policyStorage)) ||
            !isCacheKeepHybridActive(snapshot.policyStorage) ||
            !isCacheKeepActiveNow(
              snapshot.policyStorage,
              new Date(options.now?.() ?? Date.now()),
            )
          )
            throw new Error('CacheKeep policy changed before dispatch')
        },
      },
    })
    let attempt:
      | Attempt<NativeAnthropicAttemptData<NativeSourceProvenance>>
      | undefined
    let status: number | undefined
    let complete = false
    const cancel = () => native.forgetSession(scope.sessionID)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const accountId = (await runtime.read()).accounts.find(
        (account) => accountKey(account) === target.oauthAccountIdentity,
      )?.id
      if (!accountId) throw new Error('CacheKeep account is unavailable')
      const authorized = await native.adapter.accountHeaders({
        ...scope,
        accountId,
      })
      if (
        !('headers' in authorized) ||
        typeof authorized.headers !== 'object' ||
        authorized.headers === null ||
        typeof authorized.attempt !== 'object' ||
        authorized.attempt === null ||
        authorized.attempt.route !== 'oauth'
      )
        throw new Error('CacheKeep authorization refused')
      attempt = {
        ...scope,
        accountId,
        attemptId: crypto.randomUUID(),
        transport: 'http',
        data: authorized.attempt,
      }
      const request = await native.adapter.rewriteRequest?.({
        ...scope,
        accountId,
        attempt,
        request: new Request(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        }),
      })
      if (!request) throw new Error('CacheKeep rewrite refused')
      signal.throwIfAborted()
      const physical = await (options.fetch ?? fetch)(request)
      const response = await native.adapter.rewriteResponse?.({
        ...scope,
        accountId,
        attempt,
        request,
        response: physical,
      })
      if (!response) throw new Error('CacheKeep response rewrite refused')
      status = response.status
      native.adapter.quotaFromHeaders?.(
        response.headers,
        response.status,
        attempt,
      )
      if (!response.ok)
        await native.adapter.limitFromResponse?.({
          status,
          headers: response.headers,
          body: () => response.clone().text(),
          attempt,
        })
      const bytes = await response.arrayBuffer()
      complete = true
      return new Response(bytes, { status, headers: response.headers })
    } catch {
      // The manager's transport headers contain only a correlation ID, so its
      // generic error scrubber cannot know the native send's credentials.
      throw new Error('Native CacheKeep was not completed')
    } finally {
      signal.removeEventListener('abort', cancel)
      try {
        if (attempt)
          await native.adapter.onAttemptEnd?.(attempt, {
            status,
            outputStarted: false,
            ...(complete ? {} : { error: { reason: 'cancelled' as const } }),
          })
      } finally {
        native.dispose()
        source.forgetSession?.(scope.sessionID)
      }
    }
  }
  const schedule = options.setIntervalImpl ?? globalThis.setInterval
  const manager = new CacheKeepManager({
    loadStorage: async () =>
      stopped ? null : (await runtime.read()).policyStorage,
    now: options.now,
    // Return the scheduler pass to timer drivers, so they can join the same
    // work as disposal rather than observe a detached callback.
    setIntervalImpl: ((_callback: unknown, ms: number | undefined) =>
      schedule(
        () =>
          manager.tick().catch(() => {
            logger.warn('cachekeep', 'tick failed')
          }),
        ms,
      )) as typeof globalThis.setInterval,
    clearIntervalImpl: options.clearIntervalImpl,
    onTrackedSessionsChanged: (sessions) =>
      registry.publish(stopped ? [] : sessions),
    prepareHeaders(_headers, target, attempt) {
      if (stopped) return undefined
      prepared.set(attempt.id, { target, attempt })
      return new Headers({ 'x-native-cachekeep-attempt': String(attempt.id) })
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input as Request, init)
      const id = Number(request.headers.get('x-native-cachekeep-attempt'))
      const entry = prepared.get(id)
      prepared.delete(id)
      if (!entry) throw new Error('CacheKeep attempt is unavailable')
      return send(entry.target, request as Request, entry.attempt.signal)
    }) as typeof fetch,
    onComplete: ({ attempt }) => {
      prepared.delete(attempt.id)
    },
  })
  let cleanup: Promise<void> | undefined
  return {
    async track(
      input: Parameters<NonNullable<NativeSource['onRequestPrepared']>>[0],
    ) {
      if (
        stopped ||
        input.route !== 'oauth' ||
        input.agent === 'cachekeep' ||
        input.agent === 'prime' ||
        input.kind !== 'primary'
      )
        return
      const snapshot = await runtime.read()
      if (stopped || !isCacheKeepHybridActive(snapshot.policyStorage)) return
      let isSubagent = false
      try {
        isSubagent = (await options.isSubagent?.(input.sessionID)) ?? false
      } catch {
        // A missing host session record cannot justify background spending.
        return
      }
      if (
        stopped ||
        (isSubagent && !isCacheKeepSubagentsEnabled(snapshot.policyStorage))
      )
        return
      const account = snapshot.accounts.find(
        (row) => row.id === input.accountId,
      )
      if (!account?.accountIdentity) return
      if (
        input.provenance.kind === 'local' &&
        JSON.stringify(account.binding) !==
          JSON.stringify(input.provenance.subject.binding)
      )
        return
      if (
        input.provenance.kind === 'vault' &&
        account.credentialId !== input.provenance.credentialId
      )
        return
      manager.track({
        sessionId: input.sessionID,
        url: input.url,
        headers: new Headers(),
        bodyText: input.bodyText,
        storage: snapshot.policyStorage,
        cacheMode: 'hybrid',
        oauthAccountId: input.accountId,
        oauthAccountIdentity: accountKey(account),
        isSubagent,
      })
      await registry.publish(manager.trackedSessions())
    },
    registry,
    dispose() {
      if (cleanup) return cleanup
      stopped = true
      manager.stop()
      abort.abort()
      cleanup = (async () => {
        // tick() joins an active scheduler pass; stopped storage prevents a new
        // pass from sending if disposal happens between timer callbacks.
        try {
          await manager.tick()
        } finally {
          prepared.clear()
          await registry.dispose()
        }
      })()
      return cleanup
    },
  }
}
