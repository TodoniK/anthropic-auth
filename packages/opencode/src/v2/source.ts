import {
  createNativeUsagePublisher,
  getClaudeCodeIdentityForVerifiedAccount,
  getQuotaCheckIntervalMs,
  getRoutingMode,
  getStickyRoutingStatePath,
  isQuotaBearingHeaderFrame,
  mergeHeaderQuotaForPersistence,
  type NativeAccountRuntime,
  type NativeAccountSnapshot,
  type NativeAccountView,
  type NativeApiSubject,
  type NativeCustodyReceipt,
  type NativeLocalCredentialValidation as NativeKnownCredentialSubject,
  type NativePoolPaths,
  NativeVaultNoAccountError,
  nativeAccountPolicy,
  normalizeQuotaHeaders,
  type OAuthQuotaSnapshot,
  type ProviderAccountUuid,
  quotaSnapshotCheckedAt,
  quotaSnapshotHasStandardWindows,
  readNativeAccountsForRequest,
  remapModelId,
  StickySessionRouter,
  shouldFallbackStatus,
  stickyQuotaSnapshotIsFresh,
  stickyRouteFamilyForModel,
} from '@cortexkit/anthropic-auth-core'
import type {
  ChooseAccountInput,
  HeaderEdits,
  RequestScope,
} from '@cortexkit/common-auth/opencode2'
import { extractAnthropicRequestId } from '../billing-lineage'
import {
  type NativeAnthropicAuthorization,
  type NativeAnthropicBodyOptions,
  type NativeAnthropicRequestContext,
  type NativeAnthropicResponseContext,
  type NativeAnthropicResponseOptions,
  type NativeAnthropicSource,
  NativeAnthropicTransportRefusal,
} from './adapter'

/**
 * Identifies the account and credential version that served a send, so a
 * later 401 or quota reading is recorded against that exact version. It never
 * holds OAuth tokens, API keys or the private vault authorization receipt.
 */
export type NativeSourceProvenance =
  | { readonly kind: 'local'; readonly subject: NativeKnownCredentialSubject }
  | {
      readonly kind: 'vault'
      readonly credentialId: string
      readonly recordVersion: number
    }
  | { readonly kind: 'api'; readonly subject: NativeApiSubject }

type Authorization = NativeAnthropicAuthorization<NativeSourceProvenance>
type State = {
  readonly scope: RequestScope
  readonly active: AbortController
  readonly account: NativeAccountView
  readonly receipt?: NativeCustodyReceipt
  readonly access?: string
  readonly retry: boolean
  readonly relayFallback: boolean
  quota?: OAuthQuotaSnapshot
}
type Retry = {
  readonly sessionID: string
  readonly accountId: string
  readonly direct?: boolean
  readonly auth?: Authorization
  readonly retry: boolean
}

// Only the general OAuth windows can authorize paid API fallback. A model's
// scoped exhaustion alone must not open a paid route.
const quotaSnapshotIsExhausted = (quota: OAuthQuotaSnapshot | undefined) =>
  (['five_hour', 'seven_day'] as const).some(
    (window) => (quota?.[window]?.remainingPercent ?? 1) <= 0,
  )

export interface NativeSourceOptions {
  readonly runtime: NativeAccountRuntime
  readonly paths: NativePoolPaths
  readonly requestOptions: (
    scope: NativeAnthropicRequestContext<NativeSourceProvenance>,
    snapshot: NativeAccountSnapshot,
  ) => NativeAnthropicBodyOptions
  readonly responseOptions?: (
    scope: NativeAnthropicResponseContext<NativeSourceProvenance>,
  ) => NativeAnthropicResponseOptions
  readonly onRequestId?: (
    scope: NativeAnthropicResponseContext<NativeSourceProvenance>,
    requestId: string,
  ) => void
  readonly onForgetSession?: (sessionID: string) => void
  readonly onOwnedRequest?: () => void
  readonly fetch?: typeof fetch
  /** Resolve a host model alias to the upstream ID before request-local policy. */
  readonly resolveModelId?: (scope: RequestScope) => Promise<string>
}

export interface NativeSource
  extends NativeAnthropicSource<OAuthQuotaSnapshot, NativeSourceProvenance> {
  readonly close: () => Promise<void>
  readonly resetRouting: (sessionID: string) => Promise<void>
  readonly recordPrime: (
    provenance: NativeSourceProvenance,
    usage: { inputTokens?: number; outputTokens?: number },
  ) => Promise<boolean>
}

/** The native account service supplies fresh credentials; existing quota and routing rules choose each OpenCode 2 request's route. */
export function createNativeAnthropicSource(
  options: NativeSourceOptions,
): NativeSource {
  const { runtime } = options
  const usagePublications = createNativeUsagePublisher('native-auth')
  // Vault mode keeps session affinity in its own file, named by the snapshot,
  // so vault sessions never read or write the local account's routing state.
  // Local mode leaves routingPath unset and uses the local routing file.
  const routers = new Map<string, StickySessionRouter>()
  const routerFor = (snapshot: NativeAccountSnapshot) => {
    const path =
      snapshot.routingPath ??
      getStickyRoutingStatePath(options.paths.legacyConfig)
    let router = routers.get(path)
    if (!router) {
      router = new StickySessionRouter({
        path,
        vaultSeed: snapshot.routingSeed,
      })
      routers.set(path, router)
    }
    router.setVaultSeed(snapshot.routingSeed)
    return router
  }
  const states = new WeakMap<NativeSourceProvenance, State>()
  const retries = new Map<string, Retry>()
  const choices = new Map<string, Retry[]>()
  const sessions = new Map<string, AbortController>()
  const reported = new WeakSet<NativeCustodyReceipt>()
  let closed = false
  const boundRetries = () => {
    while (retries.size > 512) {
      const first = retries.keys().next()
      if (!first.done) retries.delete(first.value)
    }
  }

  const key = (scope: RequestScope, accountId: string) =>
    JSON.stringify([scope.sessionID, scope.kind, scope.modelID, accountId])
  const controller = (scope: RequestScope) => {
    if (closed) throw new Error('Native Anthropic source is closed')
    let current = sessions.get(scope.sessionID)
    if (!current) {
      current = new AbortController()
      sessions.set(scope.sessionID, current)
      while (sessions.size > 512) {
        const first = sessions.keys().next()
        if (!first.done) source.forgetSession?.(first.value)
      }
    }
    return current
  }
  const eligible = (
    account: NativeAccountView,
    snapshot: NativeAccountSnapshot,
    modelID: string,
  ) =>
    account.enabled &&
    (account.type === 'api' ||
      nativeAccountPolicy(account, snapshot, remapModelId(modelID)).status ===
        'allowed')
  const admitted = async (
    accountId: string,
    modelID: string,
    route: 'oauth' | 'api',
    active: AbortController,
  ) => {
    const current = await runtime.read()
    active.signal.throwIfAborted()
    assertTransport(current)
    const account = current.accounts.find((row) => row.id === accountId)
    if (
      !account ||
      account.type !== route ||
      !eligible(account, current, modelID)
    )
      return false
    if (route === 'api') {
      const main = current.accounts.find(
        (row) => row.id === 'main' && row.type === 'oauth',
      )
      return (
        !!main &&
        stickyQuotaSnapshotIsFresh(main.quota, current.policyStorage) &&
        quotaSnapshotIsExhausted(main.quota)
      )
    }
    return true
  }

  const assertTransport = (snapshot: NativeAccountSnapshot) => {
    const selected = snapshot.policyStorage.relay
    if (selected?.enabled === true && selected.transport !== 'http')
      throw new NativeAnthropicTransportRefusal()
  }
  const dispatchFor = async (
    snapshot: NativeAccountSnapshot,
    direct: boolean,
  ) => {
    assertTransport(snapshot)
    if (direct || snapshot.policyStorage.relay?.enabled !== true)
      return { dispatch: { kind: 'direct' as const }, relayFallback: false }
    // Account and status data exclude the relay secret. Obtain it through the
    // private transport accessor immediately before preparing the send.
    const relay = await runtime.getRelayConfig()
    if (!relay)
      throw new Error(
        'request refused: native HTTP relay configuration is unavailable',
      )
    if (relay.transport !== 'http') throw new NativeAnthropicTransportRefusal()
    return {
      dispatch: {
        kind: 'http-relay' as const,
        url: relay.url,
        token: relay.token,
      },
      relayFallback: relay.fallbackToDirect,
    }
  }

  async function publish(
    provenance: NativeSourceProvenance,
    state: State,
    patch: { quota?: OAuthQuotaSnapshot; lastUsed?: number },
  ) {
    if (provenance.kind === 'local')
      await runtime.publishLocal(provenance.subject, patch)
    else if (provenance.kind === 'vault' && state.receipt)
      await runtime.vault.publish(state.receipt, patch)
    else if (provenance.kind === 'api' && patch.lastUsed !== undefined)
      await runtime.publishApi(provenance.subject, { lastUsed: patch.lastUsed })
  }

  const source: NativeSource = {
    async chooseAccount(input: ChooseAccountInput) {
      const active = controller(input)
      options.onOwnedRequest?.()
      let snapshot = await runtime.read()
      active.signal.throwIfAborted()
      // Account selection rejects a WebSocket relay before any OAuth token
      // refresh or retrieval starts.
      assertTransport(snapshot)
      const modelID = remapModelId(
        (await options.resolveModelId?.(input)) ?? input.modelID,
      )
      active.signal.throwIfAborted()
      if (snapshot.mode === 'claustrum') {
        snapshot = await readNativeAccountsForRequest(runtime, active.signal)
        active.signal.throwIfAborted()
      }
      if (snapshot.policyStorage.quota?.enabled !== false) {
        let refreshed = false
        for (const account of snapshot.accounts) {
          if (!account.enabled || account.type !== 'oauth') continue
          const fresh = quotaSnapshotHasStandardWindows(account.quota)
            ? stickyQuotaSnapshotIsFresh(
                account.quota,
                snapshot.policyStorage,
                Date.now(),
                modelID,
              )
            : Date.now() - quotaSnapshotCheckedAt(account.quota) <
              getQuotaCheckIntervalMs(snapshot.policyStorage)
          if (fresh) continue
          try {
            await runtime.fetchQuota(account.id, options.fetch, active.signal)
            refreshed = true
          } catch {
            active.signal.throwIfAborted()
          }
        }
        if (refreshed) snapshot = await runtime.read()
        active.signal.throwIfAborted()
      }
      const retry = input.rerouteFrom
        ? retries.get(input.rerouteFrom.limit.reason)
        : undefined
      if (
        input.rerouteFrom &&
        /^(vault-newer|local-newer|relay-direct):/.test(
          input.rerouteFrom.limit.reason,
        ) &&
        !retry
      )
        return undefined
      if (retry && input.rerouteFrom) {
        retries.delete(input.rerouteFrom.limit.reason)
        const account = snapshot.accounts.find(
          (row) => row.id === retry.accountId,
        )
        if (!account || !eligible(account, snapshot, modelID)) return undefined
        const queueKey = key(input, retry.accountId)
        const queue = choices.get(queueKey) ?? []
        queue.push(retry)
        choices.set(queueKey, queue)
        return retry.accountId
      }
      const oauth: NativeAccountView[] = []
      for (const account of snapshot.accounts) {
        if (account.type !== 'oauth' || !eligible(account, snapshot, modelID))
          continue
        if (account.source === 'local') {
          // Skip a local account whose token refresh failed, so it is not
          // selected. Check usability without keeping its token; the send
          // obtains a fresh credential itself.
          const admission = await runtime.authorizeLocal(account.id, {
            signal: active.signal,
            policy: (row, view) => nativeAccountPolicy(row, view, modelID),
          })
          active.signal.throwIfAborted()
          if (admission.status !== 'usable') continue
        }
        oauth.push(account)
      }
      const withoutRejected = oauth.filter(
        (account) => account.id !== input.rerouteFrom?.accountId,
      )
      if (getRoutingMode(snapshot.policyStorage) === 'sticky-balanced') {
        const candidates = withoutRejected.map((account, order) => ({
          accountId: account.id,
          order,
          quota: account.quota ?? { kind: 'unknown' as const },
        }))
        const selected = await routerFor(snapshot).resolve({
          sessionId: input.sessionID,
          family: stickyRouteFamilyForModel(modelID),
          modelId: modelID,
          affinityModelId: input.modelID,
          candidates,
          retainAccountIds: new Set(
            withoutRejected.map((account) => account.id),
          ),
          // Vault routes are bound to the verified account UUID they served,
          // so a route whose UUID changed (a replaced vault default) is
          // re-placed instead of keeping another account's session pin. List
          // every vault account with a UUID, even ones quota excludes from
          // `candidates`. Local routes omit the map and keep their old pins.
          ...(snapshot.mode === 'claustrum'
            ? {
                accountIdentities: new Map(
                  snapshot.accounts.flatMap((account) =>
                    account.accountIdentity
                      ? [[account.id, account.accountIdentity] as const]
                      : [],
                  ),
                ),
              }
            : {}),
          storage: snapshot.policyStorage,
          inputBytes: 1,
          preferredAccountId: input.previousAccountId,
        })
        active.signal.throwIfAborted()
        if (selected) return selected.accountId
      } else {
        const mode = getRoutingMode(snapshot.policyStorage)
        const ordered =
          mode === 'fallback-first'
            ? [
                ...withoutRejected.filter((account) => account.id !== 'main'),
                ...withoutRejected.filter((account) => account.id === 'main'),
              ]
            : [
                ...withoutRejected.filter((account) => account.id === 'main'),
                ...withoutRejected.filter((account) => account.id !== 'main'),
              ]
        if (ordered[0]) return ordered[0].id
      }
      if (snapshot.mode === 'claustrum') throw new NativeVaultNoAccountError()
      // Fall back to a pay-per-token API key account only when the primary
      // Claude subscription account ('main') has run out: a recent usage
      // reading for main's current account and credential version must show
      // its five-hour or seven-day subscription limit at zero. A limit on one
      // model only, or a 401, never moves a request onto paid API billing.
      const main = snapshot.accounts.find(
        (account) => account.id === 'main' && account.type === 'oauth',
      )
      if (!main) return undefined
      let quota = main.quota
      if (
        input.rerouteFrom?.limit.status === 429 ||
        !stickyQuotaSnapshotIsFresh(quota, snapshot.policyStorage)
      ) {
        try {
          quota = await runtime.fetchQuota('main', options.fetch, active.signal)
        } catch {
          return undefined
        }
      }
      active.signal.throwIfAborted()
      if (!quotaSnapshotIsExhausted(quota)) return undefined
      return snapshot.accounts.find(
        (account) =>
          account.type === 'api' &&
          account.enabled &&
          account.id !== input.rerouteFrom?.accountId,
      )?.id
    },
    async authorizeAccount(scope, accountId) {
      const active = controller(scope)
      const snapshot = await runtime.read()
      active.signal.throwIfAborted()
      assertTransport(snapshot)
      const modelID = remapModelId(
        (await options.resolveModelId?.(scope)) ?? scope.modelID,
      )
      active.signal.throwIfAborted()
      const account = snapshot.accounts.find((row) => row.id === accountId)
      if (!account || !eligible(account, snapshot, modelID)) return undefined
      const queueKey = key(scope, accountId)
      const queue = choices.get(queueKey)
      const choice = queue?.shift()
      if (queue?.length === 0) choices.delete(queueKey)
      const { dispatch, relayFallback } = await dispatchFor(
        snapshot,
        choice?.direct === true,
      )
      active.signal.throwIfAborted()
      if (choice?.auth) {
        if (!(await admitted(accountId, modelID, choice.auth.route, active)))
          return undefined
        const served = states.get(choice.auth.provenance)
        if (
          served?.receipt?.expiresAtMs !== undefined &&
          served.receipt.expiresAtMs !== null &&
          served.receipt.expiresAtMs < Date.now() + 300_000
        )
          return undefined
        if (served)
          states.set(choice.auth.provenance, {
            ...served,
            scope: { ...scope, modelID },
            account,
            active,
            relayFallback,
          })
        return { ...choice.auth, dispatch }
      }
      const common = {
        scope: { ...scope, modelID },
        active,
        account,
        retry: choice?.retry ?? false,
        relayFallback,
        quota: account.quota,
      }
      if (account.type === 'api') {
        const main = snapshot.accounts.find(
          (row) => row.id === 'main' && row.type === 'oauth',
        )
        if (
          !main ||
          !stickyQuotaSnapshotIsFresh(main.quota, snapshot.policyStorage) ||
          !quotaSnapshotIsExhausted(main.quota)
        )
          return undefined
        const material = await runtime.authorizeApi(accountId, active.signal)
        active.signal.throwIfAborted()
        if (!(await admitted(accountId, modelID, 'api', active)))
          return undefined
        const provenance: NativeSourceProvenance = {
          kind: 'api',
          subject: material.subject,
        }
        states.set(provenance, common)
        const headers: HeaderEdits =
          material.authHeader === 'authorization-bearer'
            ? { authorization: `Bearer ${material.apiKey}` }
            : { 'x-api-key': material.apiKey }
        return {
          route: 'api',
          headers,
          baseURL: material.baseURL,
          provenance,
          dispatch,
        }
      }
      if (account.source === 'vault') {
        const receipt = await runtime.authorizeVault(accountId, active.signal)
        active.signal.throwIfAborted()
        if (!(await admitted(accountId, modelID, 'oauth', active)))
          return undefined
        const provenance: NativeSourceProvenance = {
          kind: 'vault',
          credentialId: receipt.credentialId,
          recordVersion: receipt.recordVersion,
        }
        states.set(provenance, { ...common, receipt })
        const identity = receipt.assertedAccountIdentity
        if (!identity) return undefined
        return {
          route: 'oauth',
          accessToken: receipt.accessToken,
          provenance,
          dispatch,
          identity: getClaudeCodeIdentityForVerifiedAccount(
            identity,
            identity as ProviderAccountUuid,
          ),
        }
      }
      const material = await runtime.authorizeLocal(accountId, {
        signal: active.signal,
        policy: (row, view) => nativeAccountPolicy(row, view, modelID),
      })
      active.signal.throwIfAborted()
      if (material.status !== 'usable') return undefined
      if (!(await admitted(accountId, modelID, 'oauth', active)))
        return undefined
      const provenance: NativeSourceProvenance = {
        kind: 'local',
        subject: material.subject,
      }
      states.set(provenance, { ...common, access: material.access })
      const identity = material.subject.binding.identity
      return {
        route: 'oauth',
        accessToken: material.access,
        provenance,
        dispatch,
        identity: getClaudeCodeIdentityForVerifiedAccount(
          identity,
          identity as ProviderAccountUuid,
        ),
      }
    },
    async requestOptions(input) {
      const active = controller(input)
      const snapshot = await runtime.read()
      active.signal.throwIfAborted()
      const account = snapshot.accounts.find(
        (row) => row.id === input.accountId,
      )
      if (!account || !eligible(account, snapshot, input.modelID))
        throw new Error(
          'request refused: native account is ineligible for this model',
        )
      const state = states.get(input.provenance)
      if (state)
        states.set(input.provenance, {
          ...state,
          scope: { ...state.scope, modelID: input.modelID },
        })
      return options.requestOptions(input, snapshot)
    },
    async admitRequest(input) {
      const state = states.get(input.provenance)
      if (
        !state ||
        !(await admitted(
          input.accountId,
          input.modelID,
          input.route,
          state.active,
        ))
      )
        throw new Error(
          'request refused: native account policy changed before dispatch',
        )
      states.set(input.provenance, {
        ...state,
        scope: { ...state.scope, modelID: input.modelID },
      })
    },
    responseOptions(input) {
      return options.responseOptions?.({
        ...input,
        modelID: states.get(input.provenance)?.scope.modelID ?? input.modelID,
      })
    },
    quotaFromHeaders(headers, input) {
      const state = states.get(input.provenance)
      const requestId = extractAnthropicRequestId(headers)
      if (requestId) options.onRequestId?.(input, requestId)
      if (
        !state ||
        input.route !== 'oauth' ||
        !isQuotaBearingHeaderFrame(headers)
      )
        return undefined
      const identity =
        input.provenance.kind === 'local'
          ? input.provenance.subject.binding.identity
          : state.receipt?.assertedAccountIdentity
      const incoming = {
        ...normalizeQuotaHeaders(headers),
        ...(identity ? { accountIdentity: identity } : {}),
      }
      state.quota = mergeHeaderQuotaForPersistence(state.quota, incoming)
      // Save these quota headers against the exact account and credential
      // version that served this request (its provenance), so another
      // credential never inherits them. The write is started, not awaited:
      // streaming never waits on file locks. onAttemptEnd awaits it, so any
      // account choice after this attempt reads the saved quota.
      const pending = publish(input.provenance, state, { quota: state.quota })
      publications.set(input.provenance, pending)
      void pending.catch(() => {})
      return incoming
    },
    async limitFromResponse(input) {
      const state = states.get(input.provenance)
      if (!state) return undefined
      if (input.status === 401 && state.receipt) {
        if (!reported.has(state.receipt)) {
          reported.add(state.receipt)
          await runtime.vault.reportFailure(
            state.receipt,
            401,
            input.dispatch === 'http-relay' ? 'relay_status_field' : 'direct',
          )
        }
        if (state.retry || state.active.signal.aborted) return undefined
        const active = state.active
        const result = await runtime.vault.prepareRetry(
          state.receipt,
          active.signal,
        )
        active.signal.throwIfAborted()
        if (!result.retry) return undefined
        const receipt = result.receipt
        const identity = receipt.assertedAccountIdentity
        if (!identity) return undefined
        const provenance: NativeSourceProvenance = {
          kind: 'vault',
          credentialId: receipt.credentialId,
          recordVersion: receipt.recordVersion,
        }
        states.set(provenance, { ...state, receipt, retry: true })
        const reason = `vault-newer:${input.attemptId}`
        retries.set(reason, {
          sessionID: input.sessionID,
          accountId: input.accountId,
          retry: true,
          auth: {
            route: 'oauth',
            accessToken: receipt.accessToken,
            provenance,
            identity: getClaudeCodeIdentityForVerifiedAccount(
              identity,
              identity as ProviderAccountUuid,
            ),
          },
        })
        boundRetries()
        return { reason, status: 401 }
      }
      if (
        input.status === 401 &&
        input.provenance.kind === 'local' &&
        state.access &&
        !state.retry
      ) {
        if (state.active.signal.aborted) return undefined
        const active = state.active
        const result = await runtime.authorizeLocal(input.accountId, {
          rejectedAccessToken: state.access,
          signal: active.signal,
          policy: (account, snapshot) =>
            nativeAccountPolicy(account, snapshot, state.scope.modelID),
        })
        active.signal.throwIfAborted()
        if (result.status !== 'usable' || result.access === state.access)
          return undefined
        const provenance: NativeSourceProvenance = {
          kind: 'local',
          subject: result.subject,
        }
        states.set(provenance, { ...state, access: result.access, retry: true })
        const identity = result.subject.binding.identity
        const reason = `local-newer:${input.attemptId}`
        retries.set(reason, {
          sessionID: input.sessionID,
          accountId: input.accountId,
          retry: true,
          auth: {
            route: 'oauth',
            accessToken: result.access,
            provenance,
            identity: getClaudeCodeIdentityForVerifiedAccount(
              identity,
              identity as ProviderAccountUuid,
            ),
          },
        })
        boundRetries()
        return { reason, status: 401 }
      }
      const snapshot = await runtime.read()
      if (shouldFallbackStatus(input.status, snapshot.policyStorage))
        return { reason: `provider-${input.status}`, status: input.status }
      return undefined
    },
    limitFromRelayFailure(input) {
      const state = states.get(input.provenance)
      if (
        !state?.relayFallback ||
        state.active.signal.aborted ||
        !(input.status === 401 || input.status >= 500)
      )
        return undefined
      const reason = `relay-direct:${input.attemptId}`
      retries.set(reason, {
        sessionID: input.sessionID,
        accountId: input.accountId,
        direct: true,
        retry: false,
      })
      boundRetries()
      return { reason }
    },
    limitFromStreamError(input) {
      return input.errorType === 'rate_limit_error'
        ? { reason: 'provider-rate-limit', status: 429 }
        : undefined
    },
    limitFromHostError(error, input) {
      const state = states.get(input.provenance)
      if (
        input.dispatch === 'http-relay' &&
        state?.relayFallback &&
        !state.active.signal.aborted &&
        error.status === undefined
      ) {
        const reason = `relay-direct:${input.attemptId}`
        retries.set(reason, {
          sessionID: input.sessionID,
          accountId: input.accountId,
          direct: true,
          retry: false,
        })
        boundRetries()
        return { reason }
      }
      return undefined
    },
    async onAttemptEnd(input, outcome) {
      const state = states.get(input.provenance)
      if (!state) return
      try {
        await publications.get(input.provenance)
        if (
          outcome.status === 401 &&
          state.receipt &&
          !reported.has(state.receipt)
        ) {
          reported.add(state.receipt)
          await runtime.vault.reportFailure(
            state.receipt,
            401,
            input.dispatch === 'http-relay' ? 'relay_status_field' : 'direct',
          )
        }
        if (!outcome.localRefusal && outcome.status !== undefined)
          usagePublications.publish(() =>
            publish(input.provenance, state, { lastUsed: Date.now() }),
          )
      } finally {
        states.delete(input.provenance)
        publications.delete(input.provenance)
      }
    },
    forgetSession(sessionID) {
      sessions.get(sessionID)?.abort()
      sessions.delete(sessionID)
      for (const [reason, retry] of retries)
        if (retry.sessionID === sessionID) retries.delete(reason)
      for (const [queueKey, queue] of choices)
        if (queue[0]?.sessionID === sessionID) choices.delete(queueKey)
      options.onForgetSession?.(sessionID)
    },
    resetRouting: async (sessionID) =>
      routerFor(await runtime.read()).clear(sessionID),
    async recordPrime(provenance, usage) {
      const state = states.get(provenance)
      if (!state || state.active.signal.aborted) return false
      if (provenance.kind === 'local')
        return runtime.incrementPrimeUsage(
          state.account.id,
          provenance.subject,
          usage,
        )
      if (provenance.kind === 'vault' && state.receipt)
        return runtime.incrementPrimeUsage(
          state.account.id,
          state.receipt,
          usage,
        )
      return false
    },
    close() {
      closed = true
      for (const active of sessions.values()) active.abort()
      sessions.clear()
      choices.clear()
      retries.clear()
      return usagePublications.drain()
    },
  }
  const publications = new WeakMap<NativeSourceProvenance, Promise<void>>()
  return source
}
