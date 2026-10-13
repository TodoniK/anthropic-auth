import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ProviderAccountUuid } from '@cortexkit/anthropic-auth-core'
import {
  CACHE_1H_MODES,
  type Cache1hMode,
  custodyTombstoneKey,
  DEFAULT_CACHE_1H_MODE,
  type LogLevel,
  logger,
  parseJsonRedacted,
} from '@cortexkit/anthropic-auth-core'

export type { ProviderAccountUuid } from '@cortexkit/anthropic-auth-core'

// Archived 1.x config/state JSON serialization is test-only; production uses
// native pool/runtime storage, never this writer.
export * from '@cortexkit/anthropic-auth-core'

import {
  acquireRefreshFileLock,
  getAccountStatePath,
  getAccountStoragePath,
} from '@cortexkit/anthropic-auth-core'

export const ACCOUNT_FILE_NAME = 'anthropic-auth.json'
export const ACCOUNT_STATE_FILE_NAME = 'anthropic-auth-state.json'
export const QUOTA_URL = 'https://api.anthropic.com/api/oauth/usage'

export type QuotaWindowName = 'five_hour' | 'seven_day'
export const QUOTA_FIELD_NAMES = [
  'five_hour',
  'seven_day',
  'scoped',
  'extraUsage',
  'bindingWindow',
  'fallbackAdvised',
] as const
export type QuotaFieldName = (typeof QUOTA_FIELD_NAMES)[number]
export type QuotaFieldSource = 'poll' | 'headers'
export type QuotaFieldSources = Partial<
  Record<QuotaFieldName, QuotaFieldSource>
>

export type AccountBase = {
  id: string
  label?: string
  enabled?: boolean
  addedAt?: number
  lastUsed?: number
}

export type OAuthAccount = AccountBase & {
  type: 'oauth'
  authLineageId?: string
  // Persisted under this name on both fallback accounts and the main profile because the
  // quota feed schema owns the anthropicAccountUuid key; only the branded type and the
  // request-scoped identity variables use the provider-neutral providerAccountUuid name.
  anthropicAccountUuid?: ProviderAccountUuid
  /** Non-secret scoped identity; never a capability handle or bearer token. */
  claustrumScopedCredentialId?: string
  claustrumScopedState?: string
  access?: string
  refresh: string
  expires?: number
  lastRefreshedAt?: number
  lastRefreshError?: AccountOperationError
  lastQuotaRefreshError?: AccountOperationError
  quota?: OAuthQuotaSnapshot
  profile?: OAuthAccountProfile
  /**
   * Per-fallback cumulative prime counters. Lives in the runtime-state file
   * (scoped under `accounts[id].prime`) and never in `anthropic-auth.json`.
   */
  prime?: PrimeUsageCounters
}

export function hasNoLocalCredential(account: {
  access?: unknown
  refresh?: unknown
}): boolean {
  return (
    account.access == null &&
    (account.refresh == null || account.refresh === '')
  )
}

export type ApiKeyAccount = AccountBase & {
  type: 'api'
  apiKey?: string
  baseURL: string
  authHeader?: 'authorization-bearer' | 'x-api-key'
}

export type FallbackAccount = OAuthAccount | ApiKeyAccount

export type ClaustrumMode = 'local' | 'claustrum'

export type ClaustrumConfig = {
  mode?: ClaustrumMode
  /** Set by authoritative scoped discovery, not an authentication toggle. */
  scopedRoster?: true
  /** Producer inventory cursor committed with the roster; never a bearer. */
  rosterView?: string
  /** Authoritative, non-secret primary identity from scoped discovery. */
  primaryAccount?: {
    credentialId: string
    accountId: ProviderAccountUuid
    state: string
  }
  /** Preserve explicit exclusions when a vaulted account disappears and returns. */
  disabledAccountIdentities?: string[]
}

export function isOAuthAccount(
  account: FallbackAccount,
): account is OAuthAccount {
  return account.type === 'oauth'
}

export function isApiKeyAccount(
  account: FallbackAccount,
): account is ApiKeyAccount {
  return account.type === 'api'
}

export function isValidApiBaseURL(value: string | undefined) {
  const raw = value?.trim()
  if (!raw) return false
  try {
    const url = new URL(raw)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

export type AccountOperationError = {
  message: string
  checkedAt: number
  nextRetryAt?: number
  retryCount?: number
  accountIdentity?: string
  tokenHash?: string
  /** Fingerprint of the refresh token that produced this error. */
  refreshTokenFingerprint?: string
  /**
   * HTTP status of the underlying refresh/quota failure, when known. Lets
   * consumers distinguish a permanently-dead token (400 invalid_grant →
   * re-login) from a transient failure (429/5xx → recovers) without a delay
   * heuristic. Absent on errors persisted before this field existed.
   */
  status?: number
  /**
   * Explicit dead-token discriminator, set at construction. True ONLY when the
   * refresh endpoint returned 400 invalid_grant (token is genuinely dead →
   * re-login). False for transient failures AND for retry-exhausted/network
   * errors that get a long backoff but are NOT dead — so they are not nagged
   * for re-login. Absent on errors persisted before this field existed (those
   * fall back to status / the 24h-delay heuristic).
   */
  permanent?: boolean
}

export type AccountQuotaWindow = {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
  checkedAt: number
}

export type AccountScopedQuotaWindow = AccountQuotaWindow & {
  id: string
  title: string
  modelId?: string
  modelName: string
}

export type QuotaMoney = {
  amountMinor: number
  currency: string
  exponent: number
}

export type OAuthExtraUsageSnapshot = {
  used: QuotaMoney
  limit: QuotaMoney
  utilizationPercent?: number
  severity?: string
  exhausted: boolean
}

export type OAuthAccountProfile = {
  tier: string
  orgType: string
  checkedAt: number
  /** Stable account identity; tokenFingerprint remains loadable for legacy state. */
  accountIdentity?: string
  providerAccountUuid?: ProviderAccountUuid
  tokenFingerprint?: string
}

export type OAuthQuotaSnapshot = Partial<
  Record<QuotaWindowName, AccountQuotaWindow>
> & {
  /** Stable main/fallback account identity; access tokens are fetch credentials only. */
  accountIdentity?: string
  scoped?: AccountScopedQuotaWindow[]
  extraUsage?: OAuthExtraUsageSnapshot
  bindingWindow?: string
  bindingWindowSource?: 'poll' | 'headers'
  fieldSources?: QuotaFieldSources
  fallbackAdvised?: boolean
  source?: 'poll' | 'headers'
  // Top-level freshness stamp for the whole snapshot. mergeAccountRuntimeState
  // uses this when the snapshot has no per-window checkedAt (e.g. a windowless
  // empty-scoped snapshot) — without it, a windowless refresh gets read as
  // checkedAt=0 and treated as stale, so an old per-window quota resurrects
  // instead of being overwritten.
  checkedAt?: number
}

export type PrimeUsageCounters = {
  count: number
  inputTokens: number
  outputTokens: number
  since: number
}

export type PrimeUsageDelta = {
  inputTokens?: number
  outputTokens?: number
}

export type PrimeRuntimeState = {
  enabled?: boolean
  mainAuthLineageId?: string
  mainAuthLineageRefreshTokenFingerprint?: string
  /**
   * Main account prime counters. Persisted only on the main side of the
   * runtime-state file — `configFromStorage()` never writes them to the config
   * file so they cannot leak into `anthropic-auth.json`.
   */
  main?: PrimeUsageCounters
}

export type RoutingMode = 'main-first' | 'fallback-first' | 'sticky-balanced'

export type KillswitchThresholds = Partial<
  Record<QuotaWindowName | '5h' | '1w' | 'scoped', number>
>

export type KillswitchConfig = {
  enabled?: boolean
  /** Thresholds for the main OAuth account (remaining % below which the account is killed). */
  main?: KillswitchThresholds
  /** Per-account overrides keyed by account ID. Accounts without an entry use the `main` thresholds. */
  accounts?: Record<string, KillswitchThresholds>
}

export type AccountStorage = {
  version: 1
  mainAccountId?: string
  main?: {
    type: 'opencode'
    provider: 'anthropic'
    profile?: OAuthAccountProfile
  }
  routing?: {
    mode?: RoutingMode
  }
  fallbackOn?: number[]
  refresh?: {
    enabled?: boolean
    intervalMinutes?: number
    refreshBeforeExpiryMinutes?: number
    mainLastRefreshError?: AccountOperationError
    mainRefreshErrorClearedAt?: number
    mainRefreshLeaseId?: string
    mainRefreshLeaseUntil?: number
    mainRefreshLeaseTokenHash?: string
  }
  quota?: {
    enabled?: boolean
    checkIntervalMinutes?: number
    refreshEveryNRequests?: number
    minimumRemaining?: Partial<Record<QuotaWindowName | '5h' | '1w', number>>
    failClosedOnUnknownQuota?: boolean
    /** Opt-in OpenCode TUI toast after quota refresh. Default: false. */
    showToasts?: boolean
    mainQuota?: OAuthQuotaSnapshot
    mainQuotaCheckedAt?: number
    // Fingerprint of the access token that produced mainQuota. Used to avoid
    // seeding a different account's persisted quota after a main-account switch.
    mainQuotaToken?: string
    mainLastQuotaApiError?: AccountOperationError
    // Monotonic transition marker. Unlike an absent error, a newer marker is an
    // affirmative cross-process clear that stale writers must not resurrect.
    mainQuotaErrorGeneration?: number
    // Observation time for the clear; rejects errors observed before it even
    // when a separate process allocated an equal or higher generation.
    mainQuotaErrorClearedAt?: number
  }
  quotaHeaderFeed?: {
    enabled?: boolean
  }
  claudeCache?: {
    enabled?: boolean
    mode?: Cache1hMode
  }
  dump?: {
    enabled?: boolean
  }
  logging?: {
    level?: LogLevel
  }
  claudeFast?: {
    enabled?: boolean
  }
  thinkingBinding?: {
    prefixMismatchBehavior?: 'account-default' | 'error' | 'drop_block'
  }
  /**
   * Zero out Anthropic OAuth model costs in the provider hook. Default: enabled
   * (OAuth usage is quota-based, not per-token billed, so costs show as $0).
   * Set `enabled: false` to opt out and display the provider's real model costs.
   */
  costZeroing?: {
    enabled?: boolean
  }
  cacheKeep?: {
    enabled?: boolean
    always?: boolean
    startHour?: number
    endHour?: number
    subagents?: boolean
  }
  /**
   * Opt-in flag and runtime metadata for `/claude-prime`. The `enabled` flag
   * belongs on the config side; counters and main lineage bindings live in the
   * state file and must never appear in `anthropic-auth.json`. See
   * `configFromStorage()` for the write-side filter.
   */
  prime?: PrimeRuntimeState
  relay?: {
    enabled?: boolean
    url?: string
    token?: string
    fallbackToDirect?: boolean
    transport?: 'http' | 'websocket'
  }
  claustrum?: ClaustrumConfig
  killswitch?: KillswitchConfig
  accounts: FallbackAccount[]
}

/**
 * Whether Anthropic OAuth model costs should be zeroed in the provider hook.
 * Defaults to enabled; only an explicit `costZeroing.enabled === false` opts out
 * (to display the provider's real model costs).
 */
export function isCostZeroingEnabled(
  storage: Pick<AccountStorage, 'costZeroing'>,
): boolean {
  return storage.costZeroing?.enabled !== false
}

export type AccountRuntimeEntry = Partial<
  Pick<
    OAuthAccount,
    | 'access'
    | 'authLineageId'
    | 'anthropicAccountUuid'
    | 'claustrumScopedCredentialId'
    | 'claustrumScopedState'
    | 'refresh'
    | 'expires'
    | 'lastUsed'
    | 'lastRefreshedAt'
    | 'lastRefreshError'
    | 'lastQuotaRefreshError'
    | 'quota'
    | 'profile'
    | 'prime'
  > &
    Pick<ApiKeyAccount, 'apiKey' | 'lastUsed'>
>

export type AccountRuntimeState = {
  version: 1
  main?: {
    scopedAccountIdentity?: string
    profile?: OAuthAccountProfile
    profileToken?: string
    quota?: OAuthQuotaSnapshot
    quotaCheckedAt?: number
    quotaToken?: string
    lastQuotaApiError?: AccountOperationError
    quotaErrorGeneration?: number
    quotaErrorClearedAt?: number
    lastRefreshError?: AccountOperationError
    refreshErrorClearedAt?: number
    refreshLeaseId?: string
    refreshLeaseUntil?: number
    refreshLeaseTokenHash?: string
    prime?: PrimeUsageCounters
    primeAuthLineageId?: string
    primeAuthLineageRefreshTokenFingerprint?: string
  }
  accounts?: Record<string, AccountRuntimeEntry>
}

export type AccountStateSaveScope = {
  mainProfile?: boolean
  mainQuota?: boolean
  mainRefresh?: boolean
  mainPrime?: boolean
  accounts?: true | string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeAccountBase(value: Record<string, unknown>): AccountBase {
  return {
    id:
      typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : randomUUID(),
    label: typeof value.label === 'string' ? value.label : undefined,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    addedAt: typeof value.addedAt === 'number' ? value.addedAt : undefined,
    lastUsed: typeof value.lastUsed === 'number' ? value.lastUsed : undefined,
  }
}

function normalizeAccount(value: unknown): FallbackAccount | null {
  if (!isRecord(value)) return null
  if (value.type === 'api') {
    const baseURL =
      typeof value.baseURL === 'string' ? value.baseURL.trim() : ''
    const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
    if (!isValidApiBaseURL(baseURL)) return null
    const authHeader =
      value.authHeader === 'x-api-key' ? 'x-api-key' : 'authorization-bearer'
    return {
      ...normalizeAccountBase(value),
      type: 'api',
      apiKey: apiKey || undefined,
      baseURL,
      authHeader,
    }
  }

  if (value.type !== 'oauth') return null
  const refresh = typeof value.refresh === 'string' ? value.refresh : ''
  const rosterOnly =
    value.enabled === true &&
    typeof value.id === 'string' &&
    Boolean(value.id.trim()) &&
    typeof value.label === 'string' &&
    Boolean(value.label.trim()) &&
    hasNoLocalCredential(value)
  const scopedRosterOnly =
    typeof value.claustrumScopedCredentialId === 'string' &&
    Boolean(value.claustrumScopedCredentialId.trim()) &&
    typeof value.anthropicAccountUuid === 'string' &&
    Boolean(value.anthropicAccountUuid.trim()) &&
    hasNoLocalCredential(value)
  if (!refresh.trim() && !rosterOnly && !scopedRosterOnly) return null

  return {
    ...normalizeAccountBase(value),
    type: 'oauth',
    authLineageId:
      typeof value.authLineageId === 'string' && value.authLineageId.trim()
        ? value.authLineageId
        : undefined,
    anthropicAccountUuid:
      typeof value.anthropicAccountUuid === 'string' &&
      value.anthropicAccountUuid.trim()
        ? (value.anthropicAccountUuid.trim() as ProviderAccountUuid)
        : undefined,
    claustrumScopedCredentialId:
      typeof value.claustrumScopedCredentialId === 'string' &&
      value.claustrumScopedCredentialId.trim()
        ? value.claustrumScopedCredentialId.trim()
        : undefined,
    claustrumScopedState:
      typeof value.claustrumScopedState === 'string' &&
      value.claustrumScopedState.trim()
        ? value.claustrumScopedState.trim()
        : undefined,
    access: typeof value.access === 'string' ? value.access : undefined,
    refresh,
    expires: typeof value.expires === 'number' ? value.expires : undefined,
    lastRefreshedAt:
      typeof value.lastRefreshedAt === 'number'
        ? value.lastRefreshedAt
        : undefined,
    lastRefreshError: normalizeOperationError(value.lastRefreshError),
    lastQuotaRefreshError: normalizeOperationError(value.lastQuotaRefreshError),
    quota: normalizeQuota(value.quota),
    profile: normalizeOAuthAccountProfile(value.profile),
    prime: normalizePrimeUsageCounters(value.prime),
  }
}

function normalizeOAuthAccountProfile(
  value: unknown,
): OAuthAccountProfile | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.tier !== 'string' ||
    !value.tier.trim() ||
    typeof value.orgType !== 'string' ||
    !value.orgType.trim() ||
    typeof value.checkedAt !== 'number' ||
    !Number.isFinite(value.checkedAt)
  ) {
    return undefined
  }
  return {
    tier: value.tier.trim(),
    orgType: value.orgType.trim(),
    checkedAt: value.checkedAt,
    ...(typeof value.accountIdentity === 'string' &&
      value.accountIdentity.trim() && {
        accountIdentity: value.accountIdentity.trim(),
      }),
    ...(typeof value.providerAccountUuid === 'string' &&
      value.providerAccountUuid.trim() && {
        providerAccountUuid:
          value.providerAccountUuid.trim() as ProviderAccountUuid,
      }),
    ...(typeof value.tokenFingerprint === 'string' &&
      value.tokenFingerprint.trim() && {
        tokenFingerprint: value.tokenFingerprint.trim(),
      }),
  }
}

function normalizeOperationError(
  value: unknown,
): AccountOperationError | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.message !== 'string') return undefined
  const checkedAt = Number(value.checkedAt)
  if (!Number.isFinite(checkedAt)) return undefined
  const nextRetryAt = Number(value.nextRetryAt)
  const retryCount = Number(value.retryCount)
  const status = Number(value.status)
  return {
    message: value.message,
    checkedAt,
    nextRetryAt: Number.isFinite(nextRetryAt) ? nextRetryAt : undefined,
    retryCount: Number.isFinite(retryCount) ? retryCount : undefined,
    accountIdentity:
      typeof value.accountIdentity === 'string' && value.accountIdentity.trim()
        ? value.accountIdentity.trim()
        : undefined,
    tokenHash:
      typeof value.tokenHash === 'string' ? value.tokenHash : undefined,
    refreshTokenFingerprint:
      typeof value.refreshTokenFingerprint === 'string' &&
      value.refreshTokenFingerprint.trim()
        ? value.refreshTokenFingerprint.trim()
        : undefined,
    // Preserve the dead-token discriminators across save/load. Without these,
    // a retry-exhausted transient (permanent=false, 24h backoff) would lose its
    // flag on reload and the 24h-delay heuristic would wrongly re-classify it
    // permanent → false "needs re-login" nag.
    status: Number.isFinite(status) ? status : undefined,
    permanent:
      typeof value.permanent === 'boolean' ? value.permanent : undefined,
  }
}

function normalizeQuotaWindow(value: unknown): AccountQuotaWindow | undefined {
  if (!isRecord(value)) return undefined
  const usedPercent = Number(value.usedPercent)
  const remainingPercent = Number(value.remainingPercent)
  const checkedAt = Number(value.checkedAt)
  if (
    !Number.isFinite(usedPercent) ||
    !Number.isFinite(remainingPercent) ||
    !Number.isFinite(checkedAt)
  ) {
    return undefined
  }
  return {
    usedPercent,
    remainingPercent,
    checkedAt,
    resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : undefined,
  }
}

function normalizePrimeUsageCounters(
  value: unknown,
): PrimeUsageCounters | undefined {
  if (!isRecord(value)) return undefined
  const count = Number(value.count)
  const inputTokens = Number(value.inputTokens)
  const outputTokens = Number(value.outputTokens)
  const since = Number(value.since)
  if (
    ![count, inputTokens, outputTokens, since].every(Number.isFinite) ||
    count < 0 ||
    inputTokens < 0 ||
    outputTokens < 0 ||
    since < 0
  ) {
    return undefined
  }
  return {
    count: Math.floor(count),
    inputTokens: Math.floor(inputTokens),
    outputTokens: Math.floor(outputTokens),
    since: Math.floor(since),
  }
}

function normalizeQuota(value: unknown): OAuthAccount['quota'] {
  if (!isRecord(value)) return undefined
  const quota: OAuthAccount['quota'] = {}
  for (const key of ['five_hour', 'seven_day'] as const) {
    const normalized = normalizeQuotaWindow(value[key])
    if (normalized) quota[key] = normalized
  }

  // Persist a top-level snapshot checkedAt through normalize so the
  // mergeAccountRuntimeState freshness comparison stays meaningful when the
  // snapshot has no per-window checkedAt (e.g. {scoped:[]}). Pre-feature
  // inputs without this key are unaffected — only on-disk snapshots that
  // already carry it reach this branch.
  if (typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt)) {
    quota.checkedAt = value.checkedAt
  }
  if (
    typeof value.accountIdentity === 'string' &&
    value.accountIdentity.trim()
  ) {
    quota.accountIdentity = value.accountIdentity.trim()
  }

  if (Array.isArray(value.scoped)) {
    const scoped = value.scoped
      .map((entry): AccountScopedQuotaWindow | undefined => {
        if (!isRecord(entry)) return undefined
        const window = normalizeQuotaWindow(entry)
        if (!window) return undefined
        if (typeof entry.id !== 'string' || !entry.id.trim()) return undefined
        if (typeof entry.title !== 'string' || !entry.title.trim()) {
          return undefined
        }
        if (typeof entry.modelName !== 'string' || !entry.modelName.trim()) {
          return undefined
        }
        const modelId =
          typeof entry.modelId === 'string' && entry.modelId.trim()
            ? entry.modelId.trim()
            : undefined
        return {
          ...window,
          id: entry.id.trim(),
          title: entry.title.trim(),
          ...(modelId && { modelId }),
          modelName: entry.modelName.trim(),
        }
      })
      .filter((entry): entry is AccountScopedQuotaWindow => entry != null)
    // Preserve empty `[]` so a downstream reader can distinguish "scoped
    // owned by anthropic-auth, none visible" from "no scoped data on this
    // snapshot". Pre-feature inputs without a `scoped` key are not affected
    // — only inputs that already carried an array reach this line.
    quota.scoped = scoped
  }

  if (isRecord(value.extraUsage)) {
    const used = normalizeQuotaMoney(value.extraUsage.used)
    const limit = normalizeQuotaMoney(value.extraUsage.limit)
    if (used && limit && typeof value.extraUsage.exhausted === 'boolean') {
      quota.extraUsage = {
        used,
        limit,
        ...(typeof value.extraUsage.utilizationPercent === 'number' &&
          Number.isFinite(value.extraUsage.utilizationPercent) && {
            utilizationPercent: value.extraUsage.utilizationPercent,
          }),
        ...(typeof value.extraUsage.severity === 'string' && {
          severity: value.extraUsage.severity,
        }),
        exhausted: value.extraUsage.exhausted,
      }
    }
  }

  if (typeof value.bindingWindow === 'string' && value.bindingWindow.trim()) {
    quota.bindingWindow = value.bindingWindow.trim()
  }
  if (
    value.bindingWindowSource === 'poll' ||
    value.bindingWindowSource === 'headers'
  ) {
    quota.bindingWindowSource = value.bindingWindowSource
  }
  if (typeof value.fallbackAdvised === 'boolean') {
    quota.fallbackAdvised = value.fallbackAdvised
  }
  if (value.source === 'poll' || value.source === 'headers') {
    quota.source = value.source
  }

  if (isRecord(value.fieldSources)) {
    const fieldSources: QuotaFieldSources = {}
    for (const field of QUOTA_FIELD_NAMES) {
      if (quota[field] === undefined) continue
      const source = value.fieldSources[field]
      if (source === 'poll' || source === 'headers') {
        fieldSources[field] = source
      }
    }
    if (Object.keys(fieldSources).length > 0) {
      quota.fieldSources = fieldSources
    }
  }

  return Object.keys(quota).length ? quota : undefined
}

function normalizeQuotaMoney(value: unknown): QuotaMoney | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.amountMinor !== 'number' ||
    !Number.isFinite(value.amountMinor) ||
    typeof value.currency !== 'string' ||
    !value.currency.trim() ||
    typeof value.exponent !== 'number' ||
    !Number.isFinite(value.exponent)
  ) {
    return undefined
  }
  return {
    amountMinor: value.amountMinor,
    currency: value.currency.trim(),
    exponent: value.exponent,
  }
}

// Fresh empty storage shell — main OpenCode OAuth account, no fallback
// accounts. Returns a new object each call so mutating callers don't alias.
export function createEmptyStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    accounts: [],
  }
}

function normalizeStorage(value: unknown): AccountStorage | null {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return null
  return {
    version: 1,
    mainAccountId:
      typeof value.mainAccountId === 'string' && value.mainAccountId.trim()
        ? value.mainAccountId.trim()
        : undefined,
    main: {
      type: 'opencode',
      provider: 'anthropic',
      profile: normalizeOAuthAccountProfile(
        isRecord(value.main) ? value.main.profile : undefined,
      ),
    },
    routing: isRecord(value.routing) ? value.routing : undefined,
    fallbackOn: Array.isArray(value.fallbackOn)
      ? value.fallbackOn.filter((status) => Number.isInteger(status))
      : undefined,
    refresh: isRecord(value.refresh) ? value.refresh : undefined,
    quota: isRecord(value.quota) ? value.quota : undefined,
    quotaHeaderFeed: isRecord(value.quotaHeaderFeed)
      ? value.quotaHeaderFeed
      : undefined,
    claudeCache: isRecord(value.claudeCache) ? value.claudeCache : undefined,
    dump: isRecord(value.dump) ? value.dump : undefined,
    claudeFast: isRecord(value.claudeFast) ? value.claudeFast : undefined,
    thinkingBinding: isRecord(value.thinkingBinding)
      ? value.thinkingBinding
      : undefined,
    costZeroing: isRecord(value.costZeroing) ? value.costZeroing : undefined,
    cacheKeep: isRecord(value.cacheKeep) ? value.cacheKeep : undefined,
    relay: isRecord(value.relay) ? value.relay : undefined,
    claustrum: normalizeClaustrumConfig(value.claustrum),
    logging: isRecord(value.logging) ? value.logging : undefined,
    killswitch: isRecord(value.killswitch) ? value.killswitch : undefined,
    prime: (() => {
      if (!isRecord(value.prime)) return undefined
      const enabled =
        typeof value.prime.enabled === 'boolean'
          ? value.prime.enabled
          : undefined
      const main = normalizePrimeUsageCounters(value.prime.main)
      const mainAuthLineageId =
        typeof value.prime.mainAuthLineageId === 'string' &&
        value.prime.mainAuthLineageId.trim()
          ? value.prime.mainAuthLineageId
          : undefined
      const mainAuthLineageRefreshTokenFingerprint =
        typeof value.prime.mainAuthLineageRefreshTokenFingerprint ===
          'string' && value.prime.mainAuthLineageRefreshTokenFingerprint.trim()
          ? value.prime.mainAuthLineageRefreshTokenFingerprint
          : undefined
      if (
        enabled === undefined &&
        !main &&
        !mainAuthLineageId &&
        !mainAuthLineageRefreshTokenFingerprint
      )
        return undefined
      return {
        ...(enabled !== undefined && { enabled }),
        ...(main && { main }),
        ...(mainAuthLineageId && { mainAuthLineageId }),
        ...(mainAuthLineageRefreshTokenFingerprint && {
          mainAuthLineageRefreshTokenFingerprint,
        }),
      }
    })(),
    accounts: value.accounts
      .map(normalizeAccount)
      .filter((account): account is FallbackAccount => account != null),
  }
}

function normalizeClaustrumConfig(value: unknown): ClaustrumConfig | undefined {
  if (!isRecord(value)) return undefined
  const mode: ClaustrumMode | undefined =
    value.mode === 'local' || value.mode === 'claustrum'
      ? value.mode
      : undefined
  const primary = isRecord(value.primaryAccount)
    ? value.primaryAccount
    : undefined
  const primaryAccount =
    primary &&
    typeof primary.credentialId === 'string' &&
    primary.credentialId.trim() &&
    typeof primary.accountId === 'string' &&
    primary.accountId.trim() &&
    typeof primary.state === 'string'
      ? {
          credentialId: primary.credentialId.trim(),
          accountId: primary.accountId.trim() as ProviderAccountUuid,
          state: primary.state,
        }
      : undefined
  const scopedRoster = value.scopedRoster === true
  const rosterView =
    typeof value.rosterView === 'string' &&
    value.rosterView.length > 0 &&
    value.rosterView.length <= 4096
      ? value.rosterView
      : undefined
  const disabledAccountIdentities = Array.isArray(
    value.disabledAccountIdentities,
  )
    ? [
        ...new Set(
          value.disabledAccountIdentities
            .filter(
              (id): id is string =>
                typeof id === 'string' && id.trim().length > 0,
            )
            .map((id) => id.trim()),
        ),
      ]
    : []
  if (!mode && !scopedRoster && disabledAccountIdentities.length === 0) {
    return undefined
  }
  return {
    ...(mode && { mode }),
    ...(scopedRoster && { scopedRoster: true as const }),
    ...(scopedRoster && rosterView && { rosterView }),
    ...(primaryAccount && { primaryAccount }),
    ...(disabledAccountIdentities.length > 0 && { disabledAccountIdentities }),
  }
}

async function readJsonIfPresent(path: string): Promise<{
  exists: boolean
  value: unknown
}> {
  try {
    return {
      exists: true,
      value: parseJsonRedacted(await readFile(path, 'utf8')),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, value: null }
    }
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(
      `account store at ${path} is corrupt or unreadable (${cause}) — fix or remove it`,
    )
  }
}

function objectWithDefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function numericField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// A clear is a monotonic tombstone; older or absent writes must not reopen backoff.
export function mergeMainQuotaErrorClearedAt(
  existing: number | undefined,
  incoming: number | undefined,
): number | undefined {
  if (incoming === undefined || !Number.isFinite(incoming)) return existing
  if (existing === undefined || !Number.isFinite(existing)) return incoming
  return Math.max(existing, incoming)
}

export function mergeMainRefreshErrorClearedAt(
  existing: number | undefined,
  incoming: number | undefined,
): number | undefined {
  if (incoming === undefined || !Number.isFinite(incoming)) return existing
  if (existing === undefined || !Number.isFinite(existing)) return incoming
  return Math.max(existing, incoming)
}

function accountCredentialTimestamp(value: Record<string, unknown>): number {
  return Math.max(
    numericField(value.lastRefreshedAt),
    numericField(value.lastUsed),
    numericField(value.addedAt),
  )
}

function legacyConfigCredentialsAreNewer(
  account: Record<string, unknown>,
  stateAccount: Record<string, unknown>,
): boolean {
  if (account.type !== 'oauth') return false
  if (typeof account.refresh !== 'string' || !account.refresh.trim()) {
    return false
  }
  const tokenChanged = Boolean(
    (typeof account.access === 'string' &&
      typeof stateAccount.access === 'string' &&
      account.access !== stateAccount.access) ||
      (typeof account.refresh === 'string' &&
        typeof stateAccount.refresh === 'string' &&
        account.refresh !== stateAccount.refresh),
  )
  if (!tokenChanged) return false
  return (
    accountCredentialTimestamp(account) >
    accountCredentialTimestamp(stateAccount)
  )
}

function mergeConfigAccountAndState(
  account: Record<string, unknown>,
  stateAccount: Record<string, unknown>,
): Record<string, unknown> {
  if (
    typeof account.claustrumScopedCredentialId === 'string' &&
    typeof account.anthropicAccountUuid === 'string'
  ) {
    const sameBinding =
      stateAccount.claustrumScopedCredentialId ===
        account.claustrumScopedCredentialId &&
      stateAccount.anthropicAccountUuid === account.anthropicAccountUuid
    const scoped: Record<string, unknown> = {
      ...(sameBinding ? stateAccount : {}),
      ...account,
      refresh: '',
    }
    delete scoped.access
    delete scoped.expires
    delete scoped.lastRefreshedAt
    delete scoped.lastRefreshError
    return scoped
  }
  if (legacyConfigCredentialsAreNewer(account, stateAccount)) {
    const merged = { ...stateAccount, ...account }
    const configTimestamp = accountCredentialTimestamp(account)
    if (configTimestamp > numericField(merged.lastRefreshedAt)) {
      merged.lastRefreshedAt = configTimestamp
    }
    delete merged.quota
    delete merged.lastRefreshError
    delete merged.lastQuotaRefreshError
    return merged
  }
  return { ...account, ...stateAccount }
}

function configAccountHasInvalidShape(account: Record<string, unknown>) {
  if (account.type !== 'api' && account.type !== 'oauth') return true
  if (
    account.type === 'api' &&
    'baseURL' in account &&
    (typeof account.baseURL !== 'string' || !isValidApiBaseURL(account.baseURL))
  ) {
    return true
  }
  if (
    account.type === 'oauth' &&
    'refresh' in account &&
    (typeof account.refresh !== 'string' || !account.refresh.trim())
  ) {
    return true
  }
  return false
}

function mergeConfigAndState(
  configValue: unknown,
  stateValue: unknown,
): unknown {
  if (!isRecord(configValue)) return configValue
  const state = isRecord(stateValue) ? stateValue : {}
  const mainState = isRecord(state.main) ? state.main : undefined
  const stateAccounts = isRecord(state.accounts) ? state.accounts : {}

  const quotaConfig = isRecord(configValue.quota) ? configValue.quota : {}
  const refreshConfig = isRecord(configValue.refresh) ? configValue.refresh : {}
  const mainQuotaSource = mainState ?? quotaConfig
  const mainRefreshSource = mainState ?? refreshConfig
  const mainQuotaErrorClearedAt =
    typeof mainState?.quotaErrorClearedAt === 'number' &&
    Number.isFinite(mainState.quotaErrorClearedAt) &&
    mainState.quotaErrorClearedAt >= 0
      ? mainState.quotaErrorClearedAt
      : undefined
  const mainRefreshErrorClearedAt =
    typeof mainState?.refreshErrorClearedAt === 'number' &&
    Number.isFinite(mainState.refreshErrorClearedAt) &&
    mainState.refreshErrorClearedAt >= 0
      ? mainState.refreshErrorClearedAt
      : undefined
  const configQuotaError = quotaConfig.mainLastQuotaApiError
  const mainLastQuotaApiError =
    mainState?.lastQuotaApiError ??
    (mainQuotaErrorClearedAt !== undefined &&
    isRecord(configQuotaError) &&
    typeof configQuotaError.checkedAt === 'number' &&
    configQuotaError.checkedAt <= mainQuotaErrorClearedAt
      ? undefined
      : configQuotaError)
  const configRefreshError = refreshConfig.mainLastRefreshError
  const mainLastRefreshError =
    mainState?.lastRefreshError ??
    (mainRefreshErrorClearedAt !== undefined &&
    isRecord(configRefreshError) &&
    typeof configRefreshError.checkedAt === 'number' &&
    configRefreshError.checkedAt <= mainRefreshErrorClearedAt
      ? undefined
      : configRefreshError)

  const accounts = Array.isArray(configValue.accounts)
    ? configValue.accounts.map((account) => {
        if (!isRecord(account)) return account
        const rawId = typeof account.id === 'string' ? account.id : undefined
        const stateValue = rawId
          ? (stateAccounts[rawId] ?? stateAccounts[rawId.trim()])
          : undefined
        const stateAccount: Record<string, unknown> = isRecord(stateValue)
          ? (stateValue as Record<string, unknown>)
          : {}
        return mergeConfigAccountAndState(account, stateAccount)
      })
    : []

  return {
    ...configValue,
    main: {
      type: 'opencode',
      provider: 'anthropic',
      profile: normalizeOAuthAccountProfile(mainState?.profile),
    },
    refresh: objectWithDefinedEntries({
      ...refreshConfig,
      mainLastRefreshError,
      mainRefreshErrorClearedAt: mainRefreshSource.refreshErrorClearedAt,
      mainRefreshLeaseId: mainRefreshSource.refreshLeaseId,
      mainRefreshLeaseUntil: mainRefreshSource.refreshLeaseUntil,
      mainRefreshLeaseTokenHash: mainRefreshSource.refreshLeaseTokenHash,
    }),
    quota: objectWithDefinedEntries({
      ...quotaConfig,
      mainQuota: mainQuotaSource.quota,
      mainQuotaCheckedAt: mainQuotaSource.quotaCheckedAt,
      mainQuotaToken: mainQuotaSource.quotaToken,
      mainLastQuotaApiError,
      mainQuotaErrorGeneration: mainQuotaSource.quotaErrorGeneration,
      mainQuotaErrorClearedAt: mainQuotaSource.quotaErrorClearedAt,
    }),
    // Carry the main-side prime counters from the state file back into the
    // merged storage so a subsequent read sees the cumulative counters. The
    // `enabled` flag stays sourced from the config side; main-side counters
    // live exclusively on the state file.
    prime: (() => {
      const configPrime = isRecord(configValue.prime)
        ? configValue.prime
        : undefined
      const mainCounters = normalizePrimeUsageCounters(mainState?.prime)
      const mainAuthLineageId =
        typeof mainState?.primeAuthLineageId === 'string' &&
        mainState.primeAuthLineageId.trim()
          ? mainState.primeAuthLineageId
          : undefined
      const mainAuthLineageRefreshTokenFingerprint =
        typeof mainState?.primeAuthLineageRefreshTokenFingerprint ===
          'string' && mainState.primeAuthLineageRefreshTokenFingerprint.trim()
          ? mainState.primeAuthLineageRefreshTokenFingerprint
          : undefined
      if (
        !configPrime &&
        !mainCounters &&
        !mainAuthLineageId &&
        !mainAuthLineageRefreshTokenFingerprint
      )
        return undefined
      return {
        ...(configPrime &&
          typeof configPrime.enabled === 'boolean' && {
            enabled: configPrime.enabled,
          }),
        ...(mainCounters && { main: mainCounters }),
        ...(mainAuthLineageId && { mainAuthLineageId }),
        ...(mainAuthLineageRefreshTokenFingerprint && {
          mainAuthLineageRefreshTokenFingerprint,
        }),
      }
    })(),
    accounts,
  }
}

export async function loadAccounts(path = getAccountStoragePath()) {
  const config = await readJsonIfPresent(path)
  const state = await readJsonIfPresent(getAccountStatePath(path))
  // Runtime-only flows (main-OAuth refresh with no fallback accounts) write the
  // state file but never the config file, so the store is absent only when
  // neither exists. Synthesize an empty config to merge state into otherwise.
  if (!config.exists && !state.exists) return null
  const configValue = config.exists ? config.value : createEmptyStorage()
  return normalizeStorage(mergeConfigAndState(configValue, state.value))
}

async function loadExistingTopLevelFields(path: string) {
  const existing = await readJsonIfPresent(path)
  return isRecord(existing.value) ? existing.value : {}
}

function omitUndefinedTopLevel(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function accountConfig(account: FallbackAccount) {
  return objectWithDefinedEntries({
    id: account.id,
    label: account.label,
    type: account.type,
    enabled: account.enabled,
    addedAt: account.addedAt,
    baseURL: account.type === 'api' ? account.baseURL : undefined,
    authHeader: account.type === 'api' ? account.authHeader : undefined,
    claustrumScopedCredentialId:
      account.type === 'oauth'
        ? account.claustrumScopedCredentialId
        : undefined,
    anthropicAccountUuid:
      account.type === 'oauth' && account.claustrumScopedCredentialId
        ? account.anthropicAccountUuid
        : undefined,
  })
}

function accountRuntimeState(account: FallbackAccount) {
  if (account.type === 'api') {
    return objectWithDefinedEntries({
      apiKey: account.apiKey,
      lastUsed: account.lastUsed,
    })
  }
  return objectWithDefinedEntries({
    authLineageId: account.authLineageId,
    anthropicAccountUuid: account.anthropicAccountUuid,
    claustrumScopedCredentialId: account.claustrumScopedCredentialId,
    claustrumScopedState: account.claustrumScopedState,
    access: account.access,
    refresh: account.refresh,
    expires: account.expires,
    lastUsed: account.lastUsed,
    lastRefreshedAt: account.lastRefreshedAt,
    lastRefreshError: account.lastRefreshError,
    lastQuotaRefreshError: account.lastQuotaRefreshError,
    quota: account.quota,
    profile: account.profile,
    prime: account.prime,
  })
}

/** Returns the latest timestamp carried by any quota snapshot window. */
export function quotaSnapshotCheckedAt(quota: OAuthQuotaSnapshot | undefined) {
  return Math.max(
    quota?.five_hour?.checkedAt ?? 0,
    quota?.seven_day?.checkedAt ?? 0,
    ...(quota?.scoped?.map((window) => window.checkedAt) ?? []),
    quota?.checkedAt ?? 0,
  )
}

function quotaSourcePrecedence(quota: OAuthQuotaSnapshot | undefined) {
  if (quota?.source === 'poll') return 2
  if (quota?.source === 'headers') return 1
  return 0
}

function mergeHeaderScopedQuota(
  existing: OAuthQuotaSnapshot,
  incoming: OAuthQuotaSnapshot,
) {
  if (!('scoped' in existing)) return incoming.scoped
  if (!Array.isArray(existing.scoped) || existing.scoped.length === 0) {
    return existing.scoped
  }
  if (!Array.isArray(incoming.scoped) || incoming.scoped.length === 0) {
    return existing.scoped
  }
  const merged = new Map(incoming.scoped.map((window) => [window.id, window]))
  for (const window of existing.scoped) {
    const candidate = merged.get(window.id)
    if (!candidate || window.checkedAt >= candidate.checkedAt) {
      merged.set(window.id, window)
    }
  }
  return [...merged.values()]
}

function mergeHeaderOwnedWindow(
  existingSnapshot: OAuthQuotaSnapshot,
  incomingSnapshot: OAuthQuotaSnapshot,
  key: QuotaWindowName,
) {
  const existing = existingSnapshot[key]
  const incoming = incomingSnapshot[key]
  if (!incoming) return existing
  if (!existing) return incoming
  if (incoming.checkedAt > existing.checkedAt) return incoming
  if (incoming.checkedAt < existing.checkedAt) return existing
  return quotaSourcePrecedence(existingSnapshot) >
    quotaSourcePrecedence(incomingSnapshot)
    ? existing
    : incoming
}

export function quotaFieldSource(
  snapshot: OAuthQuotaSnapshot | undefined,
  field: QuotaFieldName,
): QuotaFieldSource | undefined {
  if (!snapshot || snapshot[field] === undefined) return undefined
  return (
    snapshot.fieldSources?.[field] ??
    (snapshot.source === 'poll' || snapshot.source === 'headers'
      ? snapshot.source
      : undefined)
  )
}

function fieldSourcesForMergedQuota(
  existing: OAuthQuotaSnapshot,
  incoming: OAuthQuotaSnapshot,
  merged: OAuthQuotaSnapshot,
): QuotaFieldSources | undefined {
  const fieldSources: QuotaFieldSources = {}
  for (const field of QUOTA_FIELD_NAMES) {
    if (merged[field] === undefined) continue
    if (field === 'scoped' || field === 'extraUsage') {
      fieldSources[field] = 'poll'
      continue
    }
    if (
      field === 'bindingWindow' &&
      existing.bindingWindowSource === 'poll' &&
      existing.bindingWindow === merged.bindingWindow
    ) {
      fieldSources[field] = 'poll'
      continue
    }
    if (
      field === 'fallbackAdvised' &&
      incoming.fieldSources?.fallbackAdvised === undefined
    ) {
      const source = quotaFieldSource(existing, field)
      if (source) fieldSources[field] = source
      continue
    }
    const source =
      incoming[field] === merged[field]
        ? quotaFieldSource(incoming, field)
        : existing[field] === merged[field]
          ? quotaFieldSource(existing, field)
          : (quotaFieldSource(existing, field) ??
            quotaFieldSource(incoming, field))
    if (source) fieldSources[field] = source
  }
  return Object.keys(fieldSources).length > 0 ? fieldSources : undefined
}

export function mergeHeaderQuotaForPersistence(
  existing: OAuthQuotaSnapshot | undefined,
  incoming: OAuthQuotaSnapshot,
) {
  if (!existing || incoming.source !== 'headers') return incoming
  const preservePollBinding = existing.bindingWindowSource === 'poll'
  const merged = {
    ...existing,
    ...incoming,
    five_hour: mergeHeaderOwnedWindow(existing, incoming, 'five_hour'),
    seven_day: mergeHeaderOwnedWindow(existing, incoming, 'seven_day'),
    scoped: mergeHeaderScopedQuota(existing, incoming),
    extraUsage: existing.extraUsage ?? incoming.extraUsage,
    fallbackAdvised:
      incoming.fieldSources?.fallbackAdvised !== undefined
        ? incoming.fallbackAdvised
        : (existing.fallbackAdvised ?? incoming.fallbackAdvised),
    bindingWindow: preservePollBinding
      ? existing.bindingWindow
      : (incoming.bindingWindow ?? existing.bindingWindow),
    bindingWindowSource: preservePollBinding
      ? 'poll'
      : (incoming.bindingWindowSource ?? existing.bindingWindowSource),
  } satisfies OAuthQuotaSnapshot
  const fieldSources = fieldSourcesForMergedQuota(existing, incoming, merged)
  return {
    ...merged,
    ...(fieldSources && { fieldSources }),
  }
}

function mergeAccountRuntimeState(
  existing: unknown,
  incoming: AccountRuntimeEntry,
): AccountRuntimeEntry {
  if (!isRecord(existing)) return incoming
  const incomingForMerge = { ...incoming }
  const existingEntry = existing as AccountRuntimeEntry
  const tokenChanged = Boolean(
    (existingEntry.access &&
      incomingForMerge.access &&
      existingEntry.access !== incomingForMerge.access) ||
      (existingEntry.refresh &&
        incomingForMerge.refresh &&
        existingEntry.refresh !== incomingForMerge.refresh),
  )
  const mergesHeaderQuota = Boolean(
    !tokenChanged && incomingForMerge.quota?.source === 'headers',
  )
  const effectiveIncoming =
    mergesHeaderQuota && incomingForMerge.quota
      ? {
          ...incomingForMerge,
          quota: mergeHeaderQuotaForPersistence(
            existingEntry.quota,
            incomingForMerge.quota,
          ),
        }
      : incomingForMerge
  if (
    existingEntry.refresh === custodyTombstoneKey('anthropic') &&
    ((typeof effectiveIncoming.access === 'string' &&
      effectiveIncoming.access.length > 0) ||
      (typeof effectiveIncoming.refresh === 'string' &&
        effectiveIncoming.refresh !== custodyTombstoneKey('anthropic'))) &&
    (!effectiveIncoming.authLineageId ||
      effectiveIncoming.authLineageId === existingEntry.authLineageId)
  ) {
    logger.warn(
      'accounts',
      'discarded stale credential write over a custody tombstone',
    )
    const {
      access: _access,
      refresh: _refresh,
      expires: _expires,
      ...safe
    } = effectiveIncoming
    return mergeAccountRuntimeState(existingEntry, safe)
  }
  const preferredRefreshError = (() => {
    const existingError = existingEntry.lastRefreshError
    const incomingError = effectiveIncoming.lastRefreshError
    if (!existingError) return incomingError
    if (incomingError) {
      return incomingError.checkedAt >= existingError.checkedAt
        ? incomingError
        : existingError
    }
    return (effectiveIncoming.lastRefreshedAt ?? 0) >
      (existingEntry.lastRefreshedAt ?? 0)
      ? undefined
      : existingError
  })()
  const existingQuotaCheckedAt = quotaSnapshotCheckedAt(existingEntry.quota)
  const incomingQuotaCheckedAt = quotaSnapshotCheckedAt(effectiveIncoming.quota)
  const existingQuotaWinsEqualTimestamp = Boolean(
    existingQuotaCheckedAt === incomingQuotaCheckedAt &&
      quotaSourcePrecedence(existingEntry.quota) >
        quotaSourcePrecedence(effectiveIncoming.quota),
  )

  if (
    !mergesHeaderQuota &&
    (existingQuotaCheckedAt > incomingQuotaCheckedAt ||
      existingQuotaWinsEqualTimestamp)
  ) {
    const existingRefreshAt = existingEntry.lastRefreshedAt ?? 0
    const incomingRefreshAt = effectiveIncoming.lastRefreshedAt ?? 0
    if (tokenChanged && incomingRefreshAt <= existingRefreshAt) {
      const merged: AccountRuntimeEntry = { ...existingEntry }
      if (
        typeof effectiveIncoming.lastUsed === 'number' &&
        (!(typeof existingEntry.lastUsed === 'number') ||
          effectiveIncoming.lastUsed > existingEntry.lastUsed)
      ) {
        merged.lastUsed = effectiveIncoming.lastUsed
      }
      return merged
    }

    const merged: AccountRuntimeEntry = {
      ...existingEntry,
      ...effectiveIncoming,
    }
    if (tokenChanged) {
      if (!('profile' in effectiveIncoming)) delete merged.profile
      if (effectiveIncoming.quota?.source) {
        merged.quota = effectiveIncoming.quota
      } else {
        delete merged.quota
      }
      if (!('lastQuotaRefreshError' in effectiveIncoming)) {
        delete merged.lastQuotaRefreshError
      }
      merged.lastRefreshError = preferredRefreshError
      return merged
    }

    return {
      ...merged,
      quota: existingEntry.quota,
      lastQuotaRefreshError: existingEntry.lastQuotaRefreshError,
      lastRefreshError: preferredRefreshError,
    }
  }
  const merged: AccountRuntimeEntry = {
    ...existingEntry,
    ...effectiveIncoming,
  }
  if (tokenChanged) {
    if (!('profile' in effectiveIncoming)) delete merged.profile
    if (!effectiveIncoming.quota?.source) delete merged.quota
  }
  if (!('lastQuotaRefreshError' in effectiveIncoming)) {
    delete merged.lastQuotaRefreshError
  }
  merged.lastRefreshError = preferredRefreshError
  return merged
}

function configFromStorage(storage: AccountStorage): Record<string, unknown> {
  const refresh = storage.refresh
    ? objectWithDefinedEntries({
        enabled: storage.refresh.enabled,
        intervalMinutes: storage.refresh.intervalMinutes,
        refreshBeforeExpiryMinutes: storage.refresh.refreshBeforeExpiryMinutes,
      })
    : undefined
  const quota = storage.quota
    ? objectWithDefinedEntries({
        enabled: storage.quota.enabled,
        checkIntervalMinutes: storage.quota.checkIntervalMinutes,
        refreshEveryNRequests: storage.quota.refreshEveryNRequests,
        minimumRemaining: storage.quota.minimumRemaining,
        failClosedOnUnknownQuota: storage.quota.failClosedOnUnknownQuota,
        showToasts: storage.quota.showToasts,
      })
    : undefined

  return omitUndefinedTopLevel({
    version: 1,
    mainAccountId: storage.mainAccountId,
    main: { type: 'opencode', provider: 'anthropic' },
    routing: storage.routing,
    fallbackOn: storage.fallbackOn,
    refresh,
    quota,
    quotaHeaderFeed: storage.quotaHeaderFeed,
    claudeCache: storage.claudeCache,
    dump: storage.dump,
    logging: storage.logging,
    claudeFast: storage.claudeFast,
    thinkingBinding: storage.thinkingBinding,
    costZeroing: storage.costZeroing,
    cacheKeep: storage.cacheKeep,
    relay: storage.relay,
    claustrum: storage.claustrum,
    killswitch: storage.killswitch,
    prime: (() => {
      // Config side carries ONLY the `enabled` flag — runtime counters and
      // lineage bindings stay on the state file. Write `enabled` whenever it was explicitly set so a
      // toggle off persists `{ enabled: false }` and is visible to a stale
      // reader that only inspects the config.
      if (typeof storage.prime?.enabled !== 'boolean') return undefined
      return { enabled: storage.prime.enabled }
    })(),
    accounts: storage.accounts.map(accountConfig),
  })
}

export function getClaustrumMode(
  storage: AccountStorage | null,
): ClaustrumMode {
  return storage?.claustrum?.mode === 'claustrum' ? 'claustrum' : 'local'
}

export async function setClaustrumModePersistent(
  mode: ClaustrumMode,
  path = getAccountStoragePath(),
): Promise<'changed' | 'unchanged'> {
  return enqueueSave(async () => {
    const lock = await acquireAccountConfigWriteLock(path)
    try {
      const existing = await loadAccounts(path)
      const storage = existing ?? createEmptyStorage()
      if (existing && getClaustrumMode(storage) === mode) return 'unchanged'
      storage.claustrum = { ...storage.claustrum, mode }
      await saveAccountsWithConfigLock(storage, path, {
        [WRITE_CLAUSTRUM_MODE]: true,
      })
      return 'changed'
    } finally {
      await lock.release()
    }
  })
}

// ---------------------------------------------------------------------------
// Shared save queue prevents concurrent fixture writes from overwriting updates
// to different sections of the old config/state files.
// ---------------------------------------------------------------------------
let saveChain: Promise<void> = Promise.resolve()

function enqueueSave<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    saveChain = saveChain.then(
      () => fn().then(resolve, reject),
      () => fn().then(resolve, reject),
    )
  })
}

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

const WRITE_CLAUSTRUM_MODE = Symbol('writeClaustrumMode')
const MUTATE_ACCOUNT_ROSTER = Symbol('mutateAccountRoster')

export interface SaveAccountsOptions {
  /** Account ids intentionally removed by this mutation. */
  removedAccountIds?: readonly string[]
  /** Preserve disk order when a stale snapshot is missing newer accounts. */
  preserveExistingAccountOrder?: boolean
}

type InternalSaveAccountsOptions = SaveAccountsOptions & {
  [WRITE_CLAUSTRUM_MODE]?: true
  [MUTATE_ACCOUNT_ROSTER]?: true
}

function sameAccountIdentity(
  left: FallbackAccount,
  right: FallbackAccount,
): boolean {
  return (
    left.id === right.id ||
    Boolean(left.label && right.label && left.label === right.label)
  )
}

function mergeAccountsForSave(
  existing: readonly FallbackAccount[],
  incoming: readonly FallbackAccount[],
  options: SaveAccountsOptions,
): FallbackAccount[] {
  const removedIds = new Set(options.removedAccountIds ?? [])
  const current = existing.filter((account) => !removedIds.has(account.id))
  const next = incoming.filter((account) => !removedIds.has(account.id))
  const missing = current.filter(
    (account) =>
      !next.some((candidate) => sameAccountIdentity(candidate, account)),
  )
  if (!missing.length) return [...next]
  if (options.preserveExistingAccountOrder === false) {
    return [...next, ...missing]
  }

  const usedIncoming = new Set<number>()
  const merged = current.map((account) => {
    const index = next.findIndex(
      (candidate, candidateIndex) =>
        !usedIncoming.has(candidateIndex) &&
        sameAccountIdentity(candidate, account),
    )
    const candidate = next[index]
    if (!candidate) return account
    usedIncoming.add(index)
    return candidate
  })
  for (let index = 0; index < next.length; index++) {
    const candidate = next[index]
    if (!usedIncoming.has(index) && candidate) merged.push(candidate)
  }
  return merged
}

function preserveScopedAccountsOnSave(
  current: readonly FallbackAccount[],
  incoming: readonly FallbackAccount[],
  options: SaveAccountsOptions,
): FallbackAccount[] {
  const apiRoutes = mergeAccountsForSave(
    current.filter(isApiKeyAccount),
    incoming.filter(isApiKeyAccount),
    options,
  )
  const byId = new Map(apiRoutes.map((account) => [account.id, account]))
  const result = current.flatMap<FallbackAccount>((account) => {
    if (isOAuthAccount(account)) return [account]
    const replacement = byId.get(account.id)
    if (!replacement) return []
    byId.delete(account.id)
    return [replacement]
  })
  result.push(...byId.values())
  return result
}

const ACCOUNT_CONFIG_LOCK_TTL_MS = 10_000
const ACCOUNT_CONFIG_LOCK_WAIT_MS = 12_000
const ACCOUNT_STATE_LOCK_TTL_MS = 10_000
const ACCOUNT_STATE_LOCK_WAIT_MS = 12_000

async function acquireAccountWriteLock(input: {
  path: string
  name: string
  ttlMs: number
  waitMs: number
  description: string
}) {
  const { path, name, ttlMs, waitMs, description } = input
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + waitMs
  while (true) {
    const lock = await acquireRefreshFileLock({
      name,
      ttlMs,
      path,
      renew: true,
    })
    if (lock) return lock
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the account ${description} lock`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function acquireAccountConfigWriteLock(path: string) {
  return acquireAccountWriteLock({
    path,
    name: 'config-write',
    ttlMs: ACCOUNT_CONFIG_LOCK_TTL_MS,
    waitMs: ACCOUNT_CONFIG_LOCK_WAIT_MS,
    description: 'configuration write',
  })
}

function acquireAccountStateWriteLock(path: string) {
  return acquireAccountWriteLock({
    path,
    name: 'state-write',
    ttlMs: ACCOUNT_STATE_LOCK_TTL_MS,
    waitMs: ACCOUNT_STATE_LOCK_WAIT_MS,
    description: 'state write',
  })
}

export function saveAccounts(
  storage: AccountStorage,
  path = getAccountStoragePath(),
  options: SaveAccountsOptions = {},
): Promise<void> {
  const resolvedPath = path
  return enqueueSave(() => saveAccountsLocked(storage, resolvedPath, options))
}

async function saveAccountsLocked(
  storage: AccountStorage,
  path: string,
  options: InternalSaveAccountsOptions,
) {
  const lock = await acquireAccountConfigWriteLock(path)
  try {
    await saveAccountsWithConfigLock(storage, path, options)
  } finally {
    await lock.release()
  }
}

async function saveAccountsWithConfigLock(
  storage: AccountStorage,
  path: string,
  options: InternalSaveAccountsOptions,
) {
  const current = await loadAccounts(path)
  // A config-only writer may hold a pre-discovery snapshot. It must not
  // resurrect departed OAuth members or overwrite scoped exclusions.
  const preserveScopedRoster =
    current?.claustrum?.scopedRoster === true && !options[MUTATE_ACCOUNT_ROSTER]
  const mergeOptions = preserveScopedRoster
    ? {
        ...options,
        removedAccountIds: options.removedAccountIds?.filter((id) =>
          current?.accounts.some(
            (account) => account.id === id && isApiKeyAccount(account),
          ),
        ),
      }
    : options
  const nextStorage: AccountStorage = {
    ...storage,
    ...(storage.claustrum && {
      claustrum: {
        ...current?.claustrum,
        ...storage.claustrum,
        ...(preserveScopedRoster && current?.claustrum),
        ...(options[WRITE_CLAUSTRUM_MODE]
          ? { mode: storage.claustrum.mode }
          : current?.claustrum?.mode
            ? { mode: current.claustrum.mode }
            : {}),
      },
    }),
    ...(!storage.claustrum &&
      current?.claustrum && {
        claustrum: current.claustrum,
      }),
    accounts: preserveScopedRoster
      ? preserveScopedAccountsOnSave(
          current?.accounts ?? [],
          storage.accounts,
          mergeOptions,
        )
      : mergeAccountsForSave(
          current?.accounts ?? [],
          storage.accounts,
          mergeOptions,
        ),
  }
  const existing = await loadExistingTopLevelFields(path)
  const nextConfig = { ...existing, ...configFromStorage(nextStorage) }
  if (!nextStorage.claustrum) delete nextConfig.claustrum
  await writeJsonAtomic(path, nextConfig)
  // Acquire config before state in both profile and full saves, so two
  // writers cannot each hold a lock while waiting for the other's lock.
  const stateLock = await acquireAccountStateWriteLock(path)
  try {
    await saveAccountStateUnlocked(nextStorage, path, {
      mainQuota: true,
      mainRefresh: true,
      accounts: true,
    })
  } finally {
    await stateLock.release()
  }
}

function applyMainProfileStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  state.main = state.main ?? {}
  state.main.profile = storage.main?.profile
}

function applyMainQuotaStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  state.main = state.main ?? {}
  const incomingError = storage.quota?.mainLastQuotaApiError
  const incomingGeneration =
    typeof storage.quota?.mainQuotaErrorGeneration === 'number' &&
    Number.isSafeInteger(storage.quota.mainQuotaErrorGeneration) &&
    storage.quota.mainQuotaErrorGeneration >= 0
      ? storage.quota.mainQuotaErrorGeneration
      : undefined
  const incomingClearedAt =
    typeof storage.quota?.mainQuotaErrorClearedAt === 'number' &&
    Number.isFinite(storage.quota.mainQuotaErrorClearedAt) &&
    storage.quota.mainQuotaErrorClearedAt >= 0
      ? storage.quota.mainQuotaErrorClearedAt
      : undefined
  const existingGeneration =
    typeof state.main.quotaErrorGeneration === 'number' &&
    Number.isSafeInteger(state.main.quotaErrorGeneration) &&
    state.main.quotaErrorGeneration >= 0
      ? state.main.quotaErrorGeneration
      : 0
  const existingErrorObservedAt =
    typeof state.main.lastQuotaApiError?.checkedAt === 'number' &&
    Number.isFinite(state.main.lastQuotaApiError.checkedAt) &&
    state.main.lastQuotaApiError.checkedAt >= 0
      ? state.main.lastQuotaApiError.checkedAt
      : undefined
  const existingClearedAt =
    typeof state.main.quotaErrorClearedAt === 'number' &&
    Number.isFinite(state.main.quotaErrorClearedAt) &&
    state.main.quotaErrorClearedAt >= 0
      ? state.main.quotaErrorClearedAt
      : undefined
  const existingObservedAt = Math.max(
    existingErrorObservedAt ?? 0,
    existingClearedAt ?? 0,
  )
  const incomingErrorObservedAt =
    typeof incomingError?.checkedAt === 'number' &&
    Number.isFinite(incomingError.checkedAt) &&
    incomingError.checkedAt >= 0
      ? incomingError.checkedAt
      : undefined

  // Error transitions are ordered by observation time, not write order. All
  // instances share one host clock, so an error observed before a clear cannot
  // resurrect that clear even when both processes allocated the same generation.
  if (
    incomingError === undefined &&
    incomingClearedAt !== undefined &&
    incomingClearedAt >= existingObservedAt
  ) {
    state.main.lastQuotaApiError = undefined
    state.main.quotaErrorClearedAt = mergeMainQuotaErrorClearedAt(
      existingClearedAt,
      incomingClearedAt,
    )
    if (
      incomingGeneration !== undefined &&
      incomingGeneration >= existingGeneration
    ) {
      state.main.quotaErrorGeneration = incomingGeneration
    }
  } else if (
    incomingError &&
    typeof incomingError.checkedAt === 'number' &&
    Number.isFinite(incomingError.checkedAt) &&
    incomingError.checkedAt > existingObservedAt
  ) {
    const acceptsByObservation =
      incomingErrorObservedAt !== undefined &&
      incomingErrorObservedAt > existingObservedAt
    const acceptsEqualObservation =
      incomingErrorObservedAt !== undefined &&
      incomingErrorObservedAt === existingObservedAt &&
      existingErrorObservedAt !== undefined &&
      existingClearedAt === undefined &&
      incomingGeneration !== undefined &&
      incomingGeneration >= existingGeneration
    const acceptsLegacyGeneration =
      incomingErrorObservedAt === undefined &&
      incomingClearedAt === undefined &&
      incomingGeneration !== undefined &&
      incomingGeneration >= existingGeneration &&
      existingClearedAt === undefined
    if (
      acceptsByObservation ||
      acceptsEqualObservation ||
      acceptsLegacyGeneration
    ) {
      state.main.lastQuotaApiError = incomingError
      if (incomingGeneration !== undefined) {
        state.main.quotaErrorGeneration = Math.max(
          existingGeneration,
          incomingGeneration,
        )
      }
    }
  }

  const incomingQuota = storage.quota?.mainQuota
  const sameToken = Boolean(
    state.main.quotaToken &&
      storage.quota?.mainQuotaToken &&
      state.main.quotaToken === storage.quota.mainQuotaToken,
  )
  const effectiveIncomingQuota =
    sameToken && incomingQuota?.source === 'headers'
      ? mergeHeaderQuotaForPersistence(state.main.quota, incomingQuota)
      : incomingQuota
  const mergesHeaderQuota = Boolean(
    sameToken && incomingQuota?.source === 'headers',
  )
  // Ordering authority must travel inside the account-bound snapshot. The
  // legacy top-level quotaCheckedAt/mainQuotaCheckedAt fields carry no account
  // identity and can form a mixed pair under concurrent cross-account writes.
  const existingCheckedAt = quotaSnapshotCheckedAt(state.main.quota)
  const incomingCheckedAt = quotaSnapshotCheckedAt(effectiveIncomingQuota)
  if (
    !mergesHeaderQuota &&
    (existingCheckedAt > incomingCheckedAt ||
      (existingCheckedAt === incomingCheckedAt &&
        quotaSourcePrecedence(state.main.quota) >
          quotaSourcePrecedence(effectiveIncomingQuota)))
  ) {
    return
  }

  state.main.quota = effectiveIncomingQuota
  const boundCheckedAt = quotaSnapshotCheckedAt(effectiveIncomingQuota)
  state.main.quotaCheckedAt = boundCheckedAt > 0 ? boundCheckedAt : undefined
  state.main.quotaToken = storage.quota?.mainQuotaToken
}

function applyMainRefreshStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  state.main = state.main ?? {}
  const incomingError = storage.refresh?.mainLastRefreshError
  const incomingClearedAt = storage.refresh?.mainRefreshErrorClearedAt
  const existingErrorObservedAt = state.main.lastRefreshError?.checkedAt
  const existingClearedAt = state.main.refreshErrorClearedAt
  const existingObservedAt = Math.max(
    existingErrorObservedAt ?? 0,
    existingClearedAt ?? 0,
  )
  if (
    incomingError === undefined &&
    incomingClearedAt !== undefined &&
    incomingClearedAt >= existingObservedAt
  ) {
    state.main.lastRefreshError = undefined
    state.main.refreshErrorClearedAt = mergeMainRefreshErrorClearedAt(
      existingClearedAt,
      incomingClearedAt,
    )
  } else if (
    incomingError &&
    typeof incomingError.checkedAt === 'number' &&
    Number.isFinite(incomingError.checkedAt) &&
    incomingError.checkedAt > existingObservedAt
  ) {
    state.main.lastRefreshError = incomingError
  }
  state.main.refreshLeaseId = storage.refresh?.mainRefreshLeaseId
  state.main.refreshLeaseUntil = storage.refresh?.mainRefreshLeaseUntil
  state.main.refreshLeaseTokenHash = storage.refresh?.mainRefreshLeaseTokenHash
}

function applyMainPrimeStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  const incoming = storage.prime?.main
  const incomingAuthLineageId = storage.prime?.mainAuthLineageId
  const incomingAuthLineageRefreshTokenFingerprint =
    storage.prime?.mainAuthLineageRefreshTokenFingerprint
  if (
    !incoming &&
    !incomingAuthLineageId &&
    !incomingAuthLineageRefreshTokenFingerprint
  )
    return
  state.main = state.main ?? {}
  // Counters belong to the 1.x runtime-state file. In that release, a
  // cross-process marker allowed only one Prime request to claim each reset window.
  if (incoming) state.main.prime = incoming
  if (incomingAuthLineageId) {
    state.main.primeAuthLineageId = incomingAuthLineageId
  }
  if (incomingAuthLineageRefreshTokenFingerprint) {
    state.main.primeAuthLineageRefreshTokenFingerprint =
      incomingAuthLineageRefreshTokenFingerprint
  }
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)]),
  )
}

export function saveAccountState(
  storage: AccountStorage,
  path = getAccountStoragePath(),
  scope: AccountStateSaveScope = {
    mainProfile: true,
    mainQuota: true,
    mainRefresh: true,
    accounts: true,
  },
): Promise<void> {
  const resolvedPath = path
  return enqueueSave(async () => {
    const lock = await acquireAccountStateWriteLock(resolvedPath)
    try {
      await saveAccountStateUnlocked(storage, resolvedPath, scope)
    } finally {
      await lock.release()
    }
  })
}

export function saveOAuthProfileState(
  input: {
    accountId: 'main' | string
    profile: OAuthAccountProfile | undefined
    accountIdentity?: string
  },
  path = getAccountStoragePath(),
): Promise<boolean> {
  const resolvedPath = path
  return enqueueSave(async () => {
    const configLock = await acquireAccountConfigWriteLock(resolvedPath)
    try {
      const stateLock = await acquireAccountStateWriteLock(resolvedPath)
      try {
        const current = await loadAccounts(resolvedPath)
        const statePath = getAccountStatePath(resolvedPath)
        const existing = (await readJsonIfPresent(statePath)).value
        const next: AccountRuntimeState = isRecord(existing)
          ? ({ ...existing, version: 1 } as AccountRuntimeState)
          : { version: 1 }
        const { accountId, accountIdentity, profile } = input
        if (
          current?.claustrum?.scopedRoster &&
          getClaustrumMode(current) === 'claustrum'
        ) {
          const account = current.accounts.find(
            (entry) => entry.id === accountId,
          )
          const expected =
            accountId === 'main'
              ? current.claustrum.primaryAccount?.accountId
              : account && isOAuthAccount(account)
                ? account.anthropicAccountUuid
                : undefined
          if (
            !expected ||
            accountIdentity !== expected ||
            (profile?.accountIdentity !== undefined &&
              profile.accountIdentity !== expected) ||
            (profile?.providerAccountUuid !== undefined &&
              profile.providerAccountUuid !== expected)
          )
            return false
        }

        if (accountId === 'main') {
          next.main = { ...(next.main ?? {}) }
          const existingProfile = normalizeOAuthAccountProfile(
            next.main.profile,
          )
          if (!profile) {
            if (
              existingProfile &&
              (accountIdentity === undefined ||
                existingProfile.accountIdentity === undefined ||
                existingProfile.accountIdentity === accountIdentity)
            ) {
              return false
            }
            next.main.profile = undefined
            return await writeJsonAtomic(statePath, pruneUndefined(next)).then(
              () => true,
            )
          }
          if (
            profile.accountIdentity !== undefined &&
            profile.accountIdentity !== accountIdentity
          ) {
            return false
          }
          const persistedProfile =
            accountIdentity === undefined ||
            profile.accountIdentity === accountIdentity
              ? profile
              : { ...profile, accountIdentity }
          if (
            existingProfile &&
            (accountIdentity === undefined ||
              existingProfile.accountIdentity === undefined ||
              existingProfile.accountIdentity === accountIdentity) &&
            existingProfile.checkedAt > persistedProfile.checkedAt
          ) {
            return false
          }
          next.main.profile = persistedProfile
        } else {
          const account = current?.accounts.find(
            (candidate): candidate is OAuthAccount =>
              candidate.id === accountId && isOAuthAccount(candidate),
          )
          if (!account) return false
          next.accounts = {
            ...(isRecord(next.accounts) ? next.accounts : {}),
          }
          const existingEntry = isRecord(next.accounts[accountId])
            ? { ...next.accounts[accountId] }
            : {}
          const existingProfile = normalizeOAuthAccountProfile(
            existingEntry.profile,
          )
          if (!profile) {
            if (
              existingProfile &&
              (accountIdentity === undefined ||
                existingProfile.accountIdentity === undefined ||
                existingProfile.accountIdentity === accountIdentity)
            ) {
              return false
            }
            existingEntry.profile = undefined
          } else {
            if (
              profile.accountIdentity !== undefined &&
              profile.accountIdentity !== accountIdentity
            ) {
              return false
            }
            const persistedProfile =
              accountIdentity === undefined ||
              profile.accountIdentity === accountIdentity
                ? profile
                : { ...profile, accountIdentity }
            if (
              existingProfile &&
              (accountIdentity === undefined ||
                existingProfile.accountIdentity === undefined ||
                existingProfile.accountIdentity === accountIdentity) &&
              existingProfile.checkedAt > persistedProfile.checkedAt
            ) {
              return false
            }
            existingEntry.profile = persistedProfile
          }
          next.accounts[accountId] = existingEntry
        }

        await writeJsonAtomic(statePath, pruneUndefined(next))
        return true
      } finally {
        await stateLock.release()
      }
    } finally {
      await configLock.release()
    }
  })
}

function fenceScopedPrimaryState(
  state: AccountRuntimeState,
  primaryId: string | undefined,
) {
  if (!isRecord(state.main)) state.main = {}
  const main = state.main
  if (!primaryId || main.scopedAccountIdentity !== primaryId) {
    delete main.prime
    delete main.primeAuthLineageId
    delete main.primeAuthLineageRefreshTokenFingerprint
    delete main.quotaErrorGeneration
    delete main.quotaErrorClearedAt
  }
  main.scopedAccountIdentity = primaryId
  if (!primaryId || main.quota?.accountIdentity !== primaryId) {
    delete main.quota
    delete main.quotaCheckedAt
    delete main.quotaToken
  }
  if (!primaryId || main.lastQuotaApiError?.accountIdentity !== primaryId)
    delete main.lastQuotaApiError
  if (
    !primaryId ||
    (main.profile?.providerAccountUuid ?? main.profile?.accountIdentity) !==
      primaryId
  ) {
    delete main.profile
    delete main.profileToken
  }
  delete main.lastRefreshError
  delete main.refreshErrorClearedAt
  delete main.refreshLeaseId
  delete main.refreshLeaseUntil
  delete main.refreshLeaseTokenHash
}

async function saveAccountStateUnlocked(
  storage: AccountStorage,
  path: string,
  scope: AccountStateSaveScope,
) {
  const statePath = getAccountStatePath(path)
  const existing = (await readJsonIfPresent(statePath)).value
  const next: AccountRuntimeState = isRecord(existing)
    ? ({ ...existing, version: 1 } as AccountRuntimeState)
    : { version: 1 }

  const persistedConfig = (await readJsonIfPresent(path)).value
  const authority = isRecord(persistedConfig)
    ? normalizeClaustrumConfig(persistedConfig.claustrum)
    : undefined
  const scoped =
    authority?.mode === 'claustrum' && authority.scopedRoster === true
  const primaryId = authority?.primaryAccount?.accountId
  const samePrimary = Boolean(
    primaryId && storage.claustrum?.primaryAccount?.accountId === primaryId,
  )
  if (scoped) fenceScopedPrimaryState(next, primaryId)
  const incomingProfileId =
    storage.main?.profile?.providerAccountUuid ??
    storage.main?.profile?.accountIdentity
  if (
    scope.mainProfile &&
    (!scoped ||
      (samePrimary &&
        (!storage.main?.profile || incomingProfileId === primaryId)))
  )
    applyMainProfileStatePatch(next, storage)
  const quotaMatches =
    samePrimary &&
    (!storage.quota?.mainQuota ||
      storage.quota.mainQuota.accountIdentity === primaryId) &&
    (!storage.quota?.mainLastQuotaApiError ||
      storage.quota.mainLastQuotaApiError.accountIdentity === primaryId)
  if (scope.mainQuota && (!scoped || quotaMatches)) {
    applyMainQuotaStatePatch(
      next,
      scoped
        ? { ...storage, quota: { ...storage.quota, mainQuotaToken: primaryId } }
        : storage,
    )
  }
  if (scope.mainRefresh && !scoped) applyMainRefreshStatePatch(next, storage)
  if (scope.mainPrime && (!scoped || samePrimary))
    applyMainPrimeStatePatch(next, storage)

  if (scope.accounts) {
    const ids = scope.accounts === true ? null : new Set(scope.accounts)
    const config = persistedConfig
    const configAccounts =
      isRecord(config) && Array.isArray(config.accounts)
        ? new Map(
            config.accounts
              .filter(isRecord)
              .map((entry) => [String(entry.id ?? '').trim(), entry]),
          )
        : new Map<string, Record<string, unknown>>()
    const configuredIds = (() => {
      if (!isRecord(config) || !Array.isArray(config.accounts)) return null
      if (config.accounts.length === 0) return new Set<string>()
      const stateAccounts = isRecord(next.accounts) ? next.accounts : {}
      const incomingAccounts = Object.fromEntries(
        storage.accounts.map((account) => [
          account.id.trim(),
          accountRuntimeState(account),
        ]),
      )
      // Keep both forms because legacy state may still use either key while
      // scoped saves must preserve entries not superseded by an incoming account.
      const memberships = config.accounts.map((account) => {
        if (!isRecord(account) || typeof account.id !== 'string') return null
        const id = account.id.trim()
        if (!id) return null
        if (configAccountHasInvalidShape(account)) return null
        const stateValue = stateAccounts[account.id] ?? stateAccounts[id]
        const stateAccount: Record<string, unknown> = isRecord(stateValue)
          ? (stateValue as Record<string, unknown>)
          : {}
        const incomingAccount = incomingAccounts[id] as
          | Record<string, unknown>
          | undefined
        return normalizeAccount(
          mergeConfigAccountAndState(account, incomingAccount ?? stateAccount),
        )
          ? [account.id, id]
          : null
      })
      // A populated config with any unparseable entry cannot establish safe membership.
      return memberships.every((membership) => membership !== null)
        ? new Set(memberships.flatMap((membership) => membership ?? []))
        : null
    })()
    next.accounts = { ...(isRecord(next.accounts) ? next.accounts : {}) }
    for (const account of storage.accounts) {
      const accountId = account.id.trim()
      if (ids && !ids.has(account.id) && !ids.has(accountId)) continue
      if (
        configuredIds &&
        !configuredIds.has(account.id) &&
        !configuredIds.has(accountId)
      )
        continue
      const legacyKeys = Object.keys(next.accounts).filter(
        (key) => key !== accountId && key.trim() === accountId,
      )
      const legacyKey = legacyKeys[0]
      const existingAccount =
        next.accounts[accountId] ??
        (legacyKey ? next.accounts[legacyKey] : undefined)
      for (const key of legacyKeys) delete next.accounts[key]
      const configured = configAccounts.get(accountId)
      if (
        configured &&
        typeof configured.claustrumScopedCredentialId === 'string' &&
        typeof configured.anthropicAccountUuid === 'string'
      ) {
        const matches = (value: unknown): value is AccountRuntimeEntry =>
          isRecord(value) &&
          value.claustrumScopedCredentialId ===
            configured.claustrumScopedCredentialId &&
          value.anthropicAccountUuid === configured.anthropicAccountUuid
        const incoming = accountRuntimeState(account)
        const merged = mergeAccountRuntimeState(
          matches(existingAccount) ? existingAccount : undefined,
          matches(incoming) ? incoming : {},
        )
        // The current config owns identity. Older local writers cannot restore
        // credentials, handles or another account's observations after cutover.
        next.accounts[accountId] = {
          ...merged,
          claustrumScopedCredentialId: configured.claustrumScopedCredentialId,
          anthropicAccountUuid:
            configured.anthropicAccountUuid as ProviderAccountUuid,
          refresh: '',
        }
        const scoped = next.accounts[accountId]
        delete scoped.access
        delete scoped.expires
        delete scoped.lastRefreshedAt
        delete scoped.lastRefreshError
      } else {
        const merged = mergeAccountRuntimeState(
          existingAccount,
          accountRuntimeState(account),
        )
        if (configured) {
          delete merged.claustrumScopedCredentialId
          delete merged.claustrumScopedState
        }
        next.accounts[accountId] = merged
      }
    }
    if (configuredIds) {
      // Config membership is authoritative for scoped writes too; otherwise a
      // stale writer can preserve state for an account removed out of band.
      for (const id of Object.keys(next.accounts)) {
        if (!configuredIds.has(id)) delete next.accounts[id]
      }
    }
    if (ids) {
      for (const id of ids) {
        if (!storage.accounts.some((account) => account.id === id)) {
          delete next.accounts[id]
        }
      }
    }
  }

  await writeJsonAtomic(statePath, pruneUndefined(next))
}

export function isCache1hPersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.claudeCache?.enabled === true
}

function normalizeCache1hMode(value: unknown): Cache1hMode {
  return typeof value === 'string' &&
    CACHE_1H_MODES.includes(value as Cache1hMode)
    ? (value as Cache1hMode)
    : DEFAULT_CACHE_1H_MODE
}

export function getCache1hPersistentMode(
  storage: AccountStorage | null,
): Cache1hMode {
  return normalizeCache1hMode(storage?.claudeCache?.mode)
}

export async function setCache1hPersistentEnabled(
  enabled: boolean,
  mode?: Cache1hMode,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.claudeCache = {
    ...(storage.claudeCache ?? {}),
    enabled,
    mode: mode ?? getCache1hPersistentMode(storage),
  }
  await saveAccounts(storage, path)
  return storage
}

export async function setCache1hPersistentMode(
  mode: Cache1hMode,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.claudeCache = {
    ...(storage.claudeCache ?? {}),
    enabled: storage.claudeCache?.enabled === true,
    mode,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isDumpPersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.dump?.enabled === true
}

export async function setDumpPersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.dump = {
    ...(storage.dump ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isFastModePersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.claudeFast?.enabled === true
}

export async function setFastModePersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.claudeFast = {
    ...(storage.claudeFast ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export async function setCacheKeepPersistentWindow(
  startHour: number,
  endHour: number,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.cacheKeep = {
    ...(storage.cacheKeep ?? {}),
    enabled: true,
    always: false,
    startHour,
    endHour,
  }
  await saveAccounts(storage, path)
  return storage
}

export async function setCacheKeepPersistentAlways(
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.cacheKeep = {
    ...(storage.cacheKeep ?? {}),
    enabled: true,
    always: true,
  }
  delete storage.cacheKeep.startHour
  delete storage.cacheKeep.endHour
  await saveAccounts(storage, path)
  return storage
}

export async function setCacheKeepPersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.cacheKeep = {
    ...(storage.cacheKeep ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isCacheKeepSubagentsEnabled(storage: AccountStorage | null) {
  return storage?.cacheKeep?.subagents === true
}

export async function setCacheKeepSubagentsEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.cacheKeep = {
    ...(storage.cacheKeep ?? {}),
    subagents: enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isPrimePersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.prime?.enabled === true
}

export async function setPrimePersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.prime = {
    ...(storage.prime ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export function setLogLevelPersistent(
  level: LogLevel,
  path = getAccountStoragePath(),
) {
  return enqueueSave(async () => {
    const storage = (await loadAccounts(path)) ?? createEmptyStorage()
    storage.logging = { ...storage.logging, level }
    await saveAccountsLocked(storage, path, {})
    const { setLogLevel } = await import('@cortexkit/anthropic-auth-core')
    setLogLevel(level)
    return storage
  })
}

export function upsertAccount(
  storage: AccountStorage,
  account: FallbackAccount,
) {
  const index = storage.accounts.findIndex(
    (candidate) =>
      candidate.id === account.id ||
      (account.label && candidate.label === account.label),
  )
  if (index >= 0) {
    const existing = storage.accounts[index]
    if (!existing) return
    const lineageChanged =
      existing.type === 'oauth' &&
      account.type === 'oauth' &&
      existing.authLineageId !== account.authLineageId
    const updated: FallbackAccount = {
      ...existing,
      ...account,
      addedAt: existing.addedAt ?? account.addedAt,
      ...(account.type === 'oauth' && {
        quota: account.quota,
        profile: account.profile,
        lastRefreshedAt: account.lastRefreshedAt,
        lastRefreshError: account.lastRefreshError,
        lastQuotaRefreshError: account.lastQuotaRefreshError,
      }),
    }
    if (lineageChanged && updated.type === 'oauth') {
      logger.debug(
        'accounts',
        'cleared provider UUID after auth lineage change',
      )
      delete updated.anthropicAccountUuid
    }
    storage.accounts[index] = updated
    return
  }
  storage.accounts.push(account)
}

export function persistFallbackQuotaHeaderPersistent(
  input: {
    accountId: string
    authLineageId?: string
    quota: OAuthQuotaSnapshot
    anthropicAccountUuid?: ProviderAccountUuid
  },
  path = getAccountStoragePath(),
): Promise<boolean> {
  return enqueueSave(async () => {
    const configLock = await acquireAccountConfigWriteLock(path)
    try {
      const stateLock = await acquireAccountStateWriteLock(path)
      try {
        const storage = await loadAccounts(path)
        const account = storage?.accounts.find(
          (candidate): candidate is OAuthAccount =>
            candidate.id === input.accountId && isOAuthAccount(candidate),
        )
        if (
          !storage ||
          !account ||
          account.authLineageId !== input.authLineageId
        )
          return false
        account.quota = { ...input.quota, accountIdentity: account.id }
        if (input.anthropicAccountUuid !== undefined)
          account.anthropicAccountUuid = input.anthropicAccountUuid
        await saveAccountStateUnlocked(storage, path, {
          accounts: [input.accountId],
        })
        return true
      } finally {
        await stateLock.release()
      }
    } finally {
      await configLock.release()
    }
  })
}
