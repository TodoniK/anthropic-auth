import type { AccountStorage } from './accounts.ts'
import type { CacheKeepTrackedSession } from './cachekeep-registry.ts'
import { signRequestBody, stripBillingLineageFromBody } from './cch.ts'
import { orderClaudeCodeBody } from './claude-code.ts'
import { dumpDirectRequest, dumpResponseArtifact } from './dump.ts'
import { logger } from './logger.ts'
import { createProviderErrorResponseScope } from './provider-error.ts'

export const CLAUDE_CACHE_KEEP_COMMAND_NAME = 'claude-cachekeep'
export const CACHE_KEEP_TTL_MS = 60 * 60_000
export const CACHE_KEEP_PREWARM_LEAD_MS = 5 * 60_000
export const CACHE_KEEP_TICK_MS = 60_000
export const CACHE_KEEP_EXTENDED_TTL_BETA = 'extended-cache-ttl-2025-04-11'
export const CACHE_KEEP_MAX_TARGETS = 32
export const CACHE_KEEP_MAX_BODY_BYTES = 16 * 1024 * 1024
export const CACHE_KEEP_PREWARM_TIMEOUT_MS = 30_000
export const CACHE_KEEP_RETRY_BASE_MS = 60_000
export const CACHE_KEEP_RETRY_MAX_MS = 15 * 60_000
export const CACHE_KEEP_RETRY_JITTER_MAX_MS = 30_000
// Fixed text returned when no credential headers can be prepared for a
// prewarm. Among retryable prewarm failures it is the only reason that is not
// provider or exception text, so it is the only one logged verbatim.
const CACHE_KEEP_CREDENTIAL_UNAVAILABLE_REASON =
  'OAuth cache prewarm credential is unavailable'

const STATUS_TITLE = '## Claude Cache Keep Status'
const ENABLED_TITLE = '## Claude Cache Keep Enabled'
const DISABLED_TITLE = '## Claude Cache Keep Disabled'
const USAGE_TITLE = '## Claude Cache Keep Usage'
const USAGE =
  'Usage: `/claude-cachekeep`, `/claude-cachekeep always`, `/claude-cachekeep off`, or `/claude-cachekeep HH-HH`.'

export type CacheKeepWindow = {
  startHour: number
  endHour: number
}

export type CacheKeepCommandAction =
  | { type: 'status' }
  | { type: 'disable' }
  | { type: 'always' }
  | { type: 'window'; startHour: number; endHour: number }
  | { type: 'usage' }
  | { type: 'subagents'; enabled: boolean }

export type CacheKeepStatus = {
  enabled: boolean
  always?: boolean
  window?: CacheKeepWindow
  trackedSessions?: number
  trackedSessionDetails?: CacheKeepTrackedSession[]
  nextPrewarmAt?: number
  hybridActive?: boolean
}

function padHour(hour: number) {
  return String(hour).padStart(2, '0')
}

export function parseCacheKeepCommandAction(
  input: string,
): CacheKeepCommandAction {
  const trimmed = input.trim()
  if (!trimmed) return { type: 'status' }
  if (trimmed === 'off') return { type: 'disable' }
  if (trimmed === 'always') return { type: 'always' }
  if (trimmed === 'subagents on') return { type: 'subagents', enabled: true }
  if (trimmed === 'subagents off') return { type: 'subagents', enabled: false }

  const match = /^(\d{1,2})-(\d{1,2})$/.exec(trimmed)
  if (!match) return { type: 'usage' }
  const startHour = Number(match[1])
  const endHour = Number(match[2])
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23 ||
    startHour === endHour
  ) {
    return { type: 'usage' }
  }

  return { type: 'window', startHour, endHour }
}

export function getCacheKeepWindow(
  storage: AccountStorage | null,
): CacheKeepWindow | undefined {
  const startHour = Number(storage?.cacheKeep?.startHour)
  const endHour = Number(storage?.cacheKeep?.endHour)
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23 ||
    startHour === endHour
  ) {
    return undefined
  }
  return { startHour, endHour }
}

export function isCacheKeepAlways(storage: AccountStorage | null) {
  return (
    storage?.cacheKeep?.enabled === true && storage.cacheKeep.always === true
  )
}

export function isCacheKeepPersistentlyEnabled(storage: AccountStorage | null) {
  return (
    storage?.cacheKeep?.enabled === true &&
    (isCacheKeepAlways(storage) || !!getCacheKeepWindow(storage))
  )
}

export function isCacheKeepHybridActive(storage: AccountStorage | null) {
  return (
    isCacheKeepPersistentlyEnabled(storage) &&
    storage?.claudeCache?.enabled === true &&
    storage.claudeCache.mode === 'hybrid'
  )
}

export function isWithinCacheKeepWindow(
  window: CacheKeepWindow | undefined,
  now = new Date(),
) {
  if (!window) return false
  const hour = now.getHours()
  if (window.startHour < window.endHour) {
    return hour >= window.startHour && hour < window.endHour
  }
  return hour >= window.startHour || hour < window.endHour
}

export function isCacheKeepActiveNow(
  storage: AccountStorage | null,
  now = new Date(),
) {
  if (storage?.cacheKeep?.enabled !== true) return false
  return (
    isCacheKeepAlways(storage) ||
    isWithinCacheKeepWindow(getCacheKeepWindow(storage), now)
  )
}

export function localDayKey(now = new Date()) {
  return `${now.getFullYear()}-${padHour(now.getMonth() + 1)}-${padHour(now.getDate())}`
}

function localWindowKey(window: CacheKeepWindow | undefined, now = new Date()) {
  if (
    window &&
    window.startHour > window.endHour &&
    now.getHours() < window.endHour
  ) {
    const previous = new Date(now)
    previous.setDate(previous.getDate() - 1)
    return localDayKey(previous)
  }
  return localDayKey(now)
}

function cacheKeepPeriodKey(
  storage: AccountStorage | null,
  window: CacheKeepWindow | undefined,
  now = new Date(),
) {
  return isCacheKeepAlways(storage) ? 'always' : localWindowKey(window, now)
}

export function buildCacheKeepStatusSummary(status: CacheKeepStatus) {
  const schedule = status.always
    ? 'always (while this process is running)'
    : status.window
      ? `${padHour(status.window.startHour)}-${padHour(status.window.endHour)}`
      : 'not configured'
  const lines = [
    `Cache keep: ${status.enabled ? 'enabled' : 'disabled'}`,
    `Schedule: ${schedule}`,
    'Mode requirement: `/claude-cache mode hybrid` must be active.',
  ]
  if (typeof status.hybridActive === 'boolean') {
    lines.push(`Hybrid active: ${status.hybridActive ? 'yes' : 'no'}`)
  }
  if (typeof status.trackedSessions === 'number') {
    lines.push(`Tracked sessions: ${status.trackedSessions}`)
  }
  if (status.trackedSessionDetails?.length) {
    lines.push('Sessions:')
    for (const session of status.trackedSessionDetails) {
      lines.push(`- ${session.id}`)
    }
  }
  if (status.nextPrewarmAt) {
    lines.push(
      `Next prewarm: ${new Date(status.nextPrewarmAt).toLocaleString()}`,
    )
  }
  return lines.join('\n')
}

export function executeCacheKeepCommand(input: {
  argumentsText: string
  enabled?: boolean
  always?: boolean
  window?: CacheKeepWindow
  trackedSessions?: number
  trackedSessionDetails?: CacheKeepTrackedSession[]
  nextPrewarmAt?: number
  hybridActive?: boolean
}) {
  const action = parseCacheKeepCommandAction(input.argumentsText)
  const status = {
    enabled: input.enabled ?? false,
    always: input.always,
    window: input.window,
    trackedSessions: input.trackedSessions,
    trackedSessionDetails: input.trackedSessionDetails,
    nextPrewarmAt: input.nextPrewarmAt,
    hybridActive: input.hybridActive,
  }

  if (action.type === 'status') {
    return [STATUS_TITLE, '', buildCacheKeepStatusSummary(status)].join('\n')
  }

  if (action.type === 'disable') {
    return [
      DISABLED_TITLE,
      '',
      buildCacheKeepStatusSummary({ ...status, enabled: false }),
    ].join('\n')
  }

  if (action.type === 'always') {
    return [
      ENABLED_TITLE,
      '',
      buildCacheKeepStatusSummary({
        ...status,
        enabled: true,
        always: true,
        window: undefined,
      }),
    ].join('\n')
  }

  if (action.type === 'window') {
    return [
      ENABLED_TITLE,
      '',
      buildCacheKeepStatusSummary({
        ...status,
        enabled: true,
        always: false,
        window: { startHour: action.startHour, endHour: action.endHour },
      }),
    ].join('\n')
  }

  if (action.type === 'subagents') {
    return [
      STATUS_TITLE,
      '',
      buildCacheKeepStatusSummary(status),
      '',
      `Subagent tracking: ${action.enabled ? 'enabled' : 'disabled'}`,
    ].join('\n')
  }

  return [USAGE_TITLE, '', USAGE, '', buildCacheKeepStatusSummary(status)].join(
    '\n',
  )
}

function hasExplicitCacheControl(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasExplicitCacheControl)
  const record = value as Record<string, unknown>
  const cacheControl = record.cache_control
  if (
    cacheControl &&
    typeof cacheControl === 'object' &&
    (cacheControl as Record<string, unknown>).type === 'ephemeral'
  ) {
    return true
  }
  return Object.values(record).some(hasExplicitCacheControl)
}

export async function buildCacheKeepPrewarmBody(
  bodyText: string,
): Promise<{ ok: true; bodyText: string } | { ok: false; reason: string }> {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'body is not valid JSON' }
  }

  if (!hasExplicitCacheControl(body)) {
    return { ok: false, reason: 'body has no explicit cache breakpoints' }
  }

  const warm = structuredClone(body) as Record<string, unknown>
  stripBillingLineageFromBody(warm)
  warm.max_tokens = 0
  delete warm.stream

  const thinking = warm.thinking as Record<string, unknown> | undefined
  if (thinking?.type === 'enabled') delete warm.thinking

  const outputConfig = warm.output_config as Record<string, unknown> | undefined
  if (outputConfig?.format) delete warm.output_config

  const toolChoice = warm.tool_choice as Record<string, unknown> | undefined
  if (toolChoice?.type === 'tool' || toolChoice?.type === 'any') {
    delete warm.tool_choice
  }

  const signedBodyText = await signRequestBody(
    JSON.stringify(orderClaudeCodeBody(warm)),
  )
  return { ok: true, bodyText: signedBodyText }
}

export type CacheKeepTarget = {
  id: string
  url: string
  headers: Record<string, string>
  bodyText: string
  cacheExpiresAt: number
  nextPrewarmAt: number
  consecutiveFailures: number
  dayKey: string
  oauthAccountId?: string
  oauthAccountIdentity?: string
  accountStoragePath?: string
  isSubagent: boolean
}

export type CacheKeepPrewarmAttempt = {
  id: number
  /** One deadline covers credential authorization and the HTTP attempt. */
  signal?: AbortSignal
}

function cacheKeepRetryDelayMs(targetId: string, failureCount: number) {
  const exponential = Math.min(
    CACHE_KEEP_RETRY_MAX_MS,
    CACHE_KEEP_RETRY_BASE_MS * 2 ** Math.min(Math.max(failureCount - 1, 0), 8),
  )
  let hash = 2_166_136_261
  for (const character of `${targetId}:${failureCount}`) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  const jitter =
    (hash >>> 0) %
    (Math.min(CACHE_KEEP_RETRY_JITTER_MAX_MS, exponential / 4) + 1)
  return exponential + jitter
}

/**
 * Credentials one prewarm send actually carried: the whole authorization
 * value, its token without the `Bearer` scheme, and any x-api-key. Read from
 * the headers handed to that send, so a rotated replay is scrubbed with its
 * own credential rather than an earlier or later one.
 */
function cacheKeepSentCredentials(headers: Headers): string[] {
  const credentials: string[] = []
  const authorization = headers.get('authorization')
  if (authorization) {
    credentials.push(authorization)
    const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim()
    if (token) credentials.push(token)
  }
  const apiKey = headers.get('x-api-key')
  if (apiKey) credentials.push(apiKey)
  return credentials
}

export type CacheKeepPrewarmResult =
  | {
      ok: true
      usage?: {
        input_tokens?: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
    }
  | { ok: false; reason: string; status?: number; transient?: true }

export class CacheKeepManager {
  private readonly targets = new Map<string, CacheKeepTarget>()
  private timer: ReturnType<typeof setInterval> | null = null
  private tickPromise: Promise<void> | null = null
  private nextPrewarmAttemptId = 0

  constructor(
    private readonly options: {
      loadStorage: () => Promise<AccountStorage | null>
      fetchImpl?: typeof fetch
      now?: () => number
      prewarmTimeoutMs?: number
      setIntervalImpl?: typeof globalThis.setInterval
      clearIntervalImpl?: typeof globalThis.clearInterval
      prepareHeaders?: (
        headers: Headers,
        target: CacheKeepTarget,
        attempt: CacheKeepPrewarmAttempt,
      ) => Promise<Headers | undefined> | Headers | undefined
      /** Optionally reauthorize a replayable prewarm after a genuine 401.
       * Return headers only for a verified newer version of the same account;
       * onResponse observes only the final physical attempt. */
      retryOnUnauthorized?: (input: {
        target: CacheKeepTarget
        headers: Headers
        bodyText: string
        attempt: CacheKeepPrewarmAttempt
      }) => Promise<Headers | undefined> | Headers | undefined
      onTrackedSessionsChanged?: (
        sessions: readonly CacheKeepTrackedSession[],
      ) => Promise<void> | void
      prepareBody?: (
        bodyText: string,
        target: CacheKeepTarget,
      ) => string | Promise<string>
      onResponse?: (input: {
        target: CacheKeepTarget
        bodyText: string
        status: number
        data: unknown
        receivedAt: number
        attempt: CacheKeepPrewarmAttempt
      }) => void | Promise<void>
      onComplete?: (input: {
        target: CacheKeepTarget
        attempt: CacheKeepPrewarmAttempt
      }) => void | Promise<void>
    },
  ) {}

  start() {
    if (this.timer) return
    logger.debug('cachekeep', 'started')
    this.timer = (this.options.setIntervalImpl ?? globalThis.setInterval)(
      () => {
        // The caught value can carry provider or peer text, so only the fixed
        // stage name is logged.
        void this.tick().catch(() => {
          logger.warn('cachekeep', 'tick failed')
        })
      },
      CACHE_KEEP_TICK_MS,
    )
    if ('unref' in this.timer) this.timer.unref()
  }

  stop() {
    if (!this.timer) return
    logger.debug('cachekeep', 'stopped')
    const clearIntervalImpl =
      this.options.clearIntervalImpl ?? globalThis.clearInterval
    clearIntervalImpl(this.timer)
    this.timer = null
  }

  stats(
    window?: CacheKeepWindow,
    now = this.options.now?.() ?? Date.now(),
    always = false,
  ) {
    const today = always ? 'always' : localWindowKey(window, new Date(now))
    const targets = [...this.targets.values()].filter(
      (target) => target.dayKey === today,
    )
    const nextPrewarmAt = targets.length
      ? Math.min(...targets.map((target) => target.nextPrewarmAt))
      : undefined
    return { trackedSessions: targets.length, nextPrewarmAt }
  }

  trackedSessions(): CacheKeepTrackedSession[] {
    return [...this.targets.values()]
      .map((target) => ({
        id: target.id,
        cacheExpiresAt: target.cacheExpiresAt,
        nextPrewarmAt: target.nextPrewarmAt,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  trackedOAuthRoute(
    sessionId: string,
  ): { oauthAccountId?: string } | undefined {
    const target = this.targets.get(sessionId)
    return target ? { oauthAccountId: target.oauthAccountId } : undefined
  }

  trackedCount(): number {
    return this.targets.size
  }

  private publishTrackedSessions() {
    const callback = this.options.onTrackedSessionsChanged
    if (!callback) return
    try {
      // Host callback failures may echo arbitrary text; log the stage only.
      void Promise.resolve(callback(this.trackedSessions())).catch(() => {
        logger.warn('cachekeep', 'failed to publish tracked sessions')
      })
    } catch {
      logger.warn('cachekeep', 'failed to publish tracked sessions')
    }
  }

  private totalBodyBytes() {
    return [...this.targets.values()].reduce(
      (sum, target) => sum + target.bodyText.length,
      0,
    )
  }

  private evictOldestTarget() {
    const oldest = this.targets.keys().next().value
    if (oldest !== undefined) this.targets.delete(oldest)
  }

  private pruneTargets(now: number, today?: string) {
    for (const [id, target] of this.targets) {
      if (today && target.dayKey !== today) {
        this.targets.delete(id)
        continue
      }
      if (now >= target.cacheExpiresAt) this.targets.delete(id)
    }
    while (this.targets.size > CACHE_KEEP_MAX_TARGETS) this.evictOldestTarget()
    while (this.totalBodyBytes() > CACHE_KEEP_MAX_BODY_BYTES) {
      const before = this.targets.size
      this.evictOldestTarget()
      if (this.targets.size === before) break
    }
  }

  track(input: {
    sessionId?: string | null
    url: string
    headers: Headers
    bodyText: string
    storage: AccountStorage | null
    cacheMode: string
    oauthAccountId?: string
    oauthAccountIdentity?: string
    accountStoragePath?: string
    isSubagent?: boolean
  }) {
    if (!input.sessionId)
      return { tracked: false, reason: 'missing session id' }
    if (!isCacheKeepPersistentlyEnabled(input.storage)) {
      return { tracked: false, reason: 'cachekeep disabled' }
    }
    if (input.cacheMode !== 'hybrid') {
      return { tracked: false, reason: 'cache mode is not hybrid' }
    }
    if (input.bodyText.length > CACHE_KEEP_MAX_BODY_BYTES) {
      return { tracked: false, reason: 'body exceeds cachekeep memory budget' }
    }
    const now = this.options.now?.() ?? Date.now()
    const window = getCacheKeepWindow(input.storage)
    if (!isCacheKeepActiveNow(input.storage, new Date(now))) {
      return { tracked: false, reason: 'outside configured schedule' }
    }

    const today = cacheKeepPeriodKey(input.storage, window, new Date(now))
    this.pruneTargets(now, today)
    if (this.targets.has(input.sessionId)) this.targets.delete(input.sessionId)

    const headers: Record<string, string> = {}
    input.headers.forEach((value, key) => {
      headers[key] = value
    })

    this.targets.set(input.sessionId, {
      id: input.sessionId,
      url: input.url,
      headers,
      bodyText: input.bodyText,
      cacheExpiresAt: now + CACHE_KEEP_TTL_MS,
      nextPrewarmAt: now + CACHE_KEEP_TTL_MS - CACHE_KEEP_PREWARM_LEAD_MS,
      consecutiveFailures: 0,
      dayKey: today,
      oauthAccountId: input.oauthAccountId,
      oauthAccountIdentity: input.oauthAccountIdentity,
      accountStoragePath: input.accountStoragePath,
      isSubagent: input.isSubagent ?? false,
    })
    this.pruneTargets(now, today)
    this.publishTrackedSessions()
    this.start()
    return { tracked: true }
  }

  async prewarmNow(input: {
    sessionId: string
    url: string
    headers: Headers
    bodyText: string
    oauthAccountId?: string
    oauthAccountIdentity?: string
    accountStoragePath?: string
    isSubagent?: boolean
  }): Promise<CacheKeepPrewarmResult> {
    const headers: Record<string, string> = {}
    input.headers.forEach((value, key) => {
      headers[key] = value
    })
    const target: CacheKeepTarget = {
      id: input.sessionId,
      url: input.url,
      headers,
      bodyText: input.bodyText,
      cacheExpiresAt: this.options.now?.() ?? Date.now(),
      nextPrewarmAt: this.options.now?.() ?? Date.now(),
      consecutiveFailures: 0,
      dayKey: '',
      oauthAccountId: input.oauthAccountId,
      oauthAccountIdentity: input.oauthAccountIdentity,
      accountStoragePath: input.accountStoragePath,
      isSubagent: input.isSubagent ?? false,
    }
    return this.sendPrewarm(target)
  }

  tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise
    let run: Promise<void>
    run = this.runTick().finally(() => {
      if (this.tickPromise === run) this.tickPromise = null
    })
    this.tickPromise = run
    return run
  }

  private async runTick() {
    const storage = await this.options.loadStorage()
    const window = getCacheKeepWindow(storage)
    const now = this.options.now?.() ?? Date.now()
    const today = cacheKeepPeriodKey(storage, window, new Date(now))
    if (isCacheKeepAlways(storage)) {
      for (const target of this.targets.values()) target.dayKey = 'always'
    }

    this.pruneTargets(now, today)
    if (!this.targets.size) {
      this.publishTrackedSessions()
      this.stop()
      return
    }

    if (!isCacheKeepHybridActive(storage)) {
      this.publishTrackedSessions()
      return
    }
    if (!isCacheKeepActiveNow(storage, new Date(now))) {
      this.publishTrackedSessions()
      return
    }

    logger.debug('cachekeep', 'fired', { targets: this.targets.size })
    for (const target of this.targets.values()) {
      if (target.nextPrewarmAt > now) continue
      try {
        await this.prewarm(target, now)
      } catch {
        logger.warn('cachekeep', 'prewarm failed', { session: target.id })
        target.consecutiveFailures += 1
        target.nextPrewarmAt =
          now + cacheKeepRetryDelayMs(target.id, target.consecutiveFailures)
      }
    }
    this.publishTrackedSessions()
  }

  private async sendPrewarm(
    target: CacheKeepTarget,
  ): Promise<CacheKeepPrewarmResult> {
    const attempt = {
      id: ++this.nextPrewarmAttemptId,
      signal: AbortSignal.timeout(
        this.options.prewarmTimeoutMs ?? CACHE_KEEP_PREWARM_TIMEOUT_MS,
      ),
    }
    try {
      let bodyText = target.bodyText
      if (this.options.prepareBody) {
        try {
          bodyText = await this.options.prepareBody(bodyText, target)
        } catch {
          logger.warn('cachekeep', 'prepare body failed', {
            session: target.id,
          })
        }
      }
      const preparedTarget = { ...target, bodyText }
      const prewarm = await buildCacheKeepPrewarmBody(bodyText)
      if (!prewarm.ok) return prewarm

      const fetchImpl = this.options.fetchImpl ?? fetch
      const prewarmTarget = { ...preparedTarget, bodyText: prewarm.bodyText }
      let headers = this.options.prepareHeaders
        ? await this.options.prepareHeaders(
            new Headers(target.headers),
            prewarmTarget,
            attempt,
          )
        : new Headers(target.headers)
      if (!headers) {
        return {
          ok: false,
          reason: CACHE_KEEP_CREDENTIAL_UNAVAILABLE_REASON,
          transient: true,
        }
      }
      headers.delete('content-length')
      headers.delete('transfer-encoding')
      let response: Response
      // Every physical send gets its own response scope holding exactly the
      // credentials that send carried, so a provider error or transport
      // exception echoing them is scrubbed before anything reads it: the
      // status check, onResponse data, dumps and the returned reason. The
      // scope retires itself when the error body is read or cancelled; a
      // successful body is passed through untouched.
      const send = async (attemptHeaders: Headers): Promise<Response> => {
        const scope = createProviderErrorResponseScope(
          cacheKeepSentCredentials(attemptHeaders),
          'http',
        )
        try {
          const sent = await fetchImpl(target.url, {
            method: 'POST',
            headers: attemptHeaders,
            body: prewarm.bodyText,
            signal: attempt.signal,
          })
          return scope.redactResponse(sent)
        } catch (error) {
          const redacted = scope.redactError(error)
          scope.dispose()
          throw redacted
        }
      }
      try {
        response = await send(headers)
        if (
          response.status === 401 &&
          !attempt.signal?.aborted &&
          this.options.retryOnUnauthorized
        ) {
          let rotatedHeaders: Headers | undefined
          try {
            rotatedHeaders = await this.options.retryOnUnauthorized({
              target: prewarmTarget,
              headers,
              bodyText: prewarm.bodyText,
              attempt,
            })
          } catch {
            // A failed credential lookup cannot justify replay. Observe and
            // report the original 401 against its actual send-time receipt.
          }
          if (rotatedHeaders && !attempt.signal?.aborted) {
            rotatedHeaders.delete('content-length')
            rotatedHeaders.delete('transfer-encoding')
            await response.body?.cancel().catch(() => {})
            headers = rotatedHeaders
            response = await send(headers)
          }
        }
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          transient: true,
        }
      }
      const receivedAt = this.options.now?.() ?? Date.now()
      const raw = await response.text().catch(() => '')
      let data: unknown = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {}
      try {
        await this.options.onResponse?.({
          target,
          bodyText: prewarm.bodyText,
          status: response.status,
          data,
          receivedAt,
          attempt,
        })
      } catch {}
      try {
        const dumpHandle = await dumpDirectRequest({
          affinity: target.id,
          route: 'cachekeep',
          status: response.status,
          bodyText: prewarm.bodyText,
          url: target.url,
          method: 'POST',
          headers,
          tag: 'cachekeep',
        })
        await dumpResponseArtifact(dumpHandle, {
          status: response.status,
          message: data,
        })
      } catch {
        logger.debug('cachekeep', 'dump failed', { session: target.id })
      }
      if (!response.ok) {
        return {
          ok: false,
          reason: raw || `HTTP ${response.status}`,
          status: response.status,
        }
      }
      const objectData =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : null
      const usage = objectData?.usage as
        | {
            input_tokens?: number
            cache_creation_input_tokens?: number
            cache_read_input_tokens?: number
          }
        | undefined
      return { ok: true, ...(usage && { usage }) }
    } finally {
      try {
        await this.options.onComplete?.({ target, attempt })
      } catch {}
    }
  }

  private async prewarm(target: CacheKeepTarget, now: number) {
    const result = await this.sendPrewarm(target)
    if (!result.ok) {
      if (result.status == null && !result.transient) {
        logger.debug('cachekeep', 'prewarm skipped', {
          session: target.id,
          reason: result.reason,
        })
        this.targets.delete(target.id)
      } else {
        // A failed result's reason may be the raw provider response body or a
        // transport exception message, so only the fixed credential reason
        // is copied into the log; everything else is described by status and
        // the transient flag.
        logger.warn('cachekeep', 'prewarm failed', {
          session: target.id,
          status: result.status,
          ...(result.transient && { transient: true }),
          ...(result.reason === CACHE_KEEP_CREDENTIAL_UNAVAILABLE_REASON && {
            reason: result.reason,
          }),
        })
        target.consecutiveFailures += 1
        target.nextPrewarmAt =
          now + cacheKeepRetryDelayMs(target.id, target.consecutiveFailures)
      }
      return
    }

    target.cacheExpiresAt = now + CACHE_KEEP_TTL_MS
    target.nextPrewarmAt = target.cacheExpiresAt - CACHE_KEEP_PREWARM_LEAD_MS
    target.consecutiveFailures = 0
    logger.debug('cachekeep', 'prewarm succeeded', {
      session: target.id,
      ...(result.usage && { usage: result.usage }),
    })
  }
}
