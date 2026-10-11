import {
  type AuthorizationResult,
  authorize,
  buildClaudeQuotaSummary,
  buildPrimeAccountStatuses,
  buildPrimeStatusSummary,
  CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
  exchange,
  formatNativeAccountState,
  formatOAuthAccountTier,
  getHostClaustrumEnrollmentPaths,
  type NativeAccountRuntime,
  type NativeMenuDispatch,
  resetClaustrumEnrollmentState,
} from '@cortexkit/anthropic-auth-core'
import { LANE_START_TEXT } from '../lane-start'
import type { NativeMenuCapabilities } from './menu-contract'
import type { NativeSource } from './source'

export type { NativeMenuCapabilities } from './menu-contract'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Account and setting changes use the same Core runtime as model requests. */
export function createNativeMenuCapabilities(options: {
  readonly runtime: NativeAccountRuntime
  readonly source: NativeSource
  readonly start: (sessionID: string, text: string) => Promise<void>
}): NativeMenuCapabilities {
  const { runtime, source } = options
  const pending = new Map<
    string,
    { auth?: AuthorizationResult; readonly active: AbortController }
  >()
  let closed = false
  const write = async (field: string, patch: Record<string, unknown>) => {
    await runtime.updateSettings((settings) => ({
      ...settings,
      [field]: { ...record(settings[field]), ...patch },
    }))
  }
  const done = () => ({ ok: true, text: 'Native Claude settings updated.' })
  const dispatch: NativeMenuDispatch = async (request, options) => {
    if (closed) throw new Error('Native menu is closed')
    options.signal?.throwIfAborted()
    switch (request.action) {
      case 'enable':
      case 'disable':
        await runtime.setEnabled(request.values.id, request.action === 'enable')
        return done()
      case 'remove':
        await runtime.remove(request.values.id)
        return done()
      case 'move-up':
      case 'move-down': {
        const snapshot = await runtime.read()
        const ids = snapshot.accounts.map((account) => account.id)
        const index = ids.indexOf(request.values.id)
        const next = index + (request.action === 'move-up' ? -1 : 1)
        if (index < 0 || next < 0 || next >= ids.length)
          return { ok: false, text: 'Account cannot move in that direction.' }
        const moved = ids[index]
        const neighbour = ids[next]
        if (moved === undefined || neighbour === undefined)
          return { ok: false, text: 'Account order changed.' }
        ids[index] = neighbour
        ids[next] = moved
        await runtime.reorder(ids)
        return done()
      }
      case 'add-apikey':
        await runtime.addApi(request.values)
        return {
          ok: true,
          text: 'API route stored in the native account pool.',
        }
      case 'add-oauth-start': {
        const active = new AbortController()
        pending.get(request.sessionId)?.active.abort()
        const login = {
          active,
          auth: undefined as AuthorizationResult | undefined,
        }
        pending.set(request.sessionId, login)
        const auth = await authorize('max')
        if (closed || active.signal.aborted || options.signal?.aborted)
          return { ok: false, text: 'Sign-in cancelled.' }
        login.auth = auth
        return {
          ok: true,
          text: `Open ${auth.url} and paste the returned code using Finish OAuth sign-in.`,
        }
      }
      case 'add-oauth-finish': {
        const login = pending.get(request.sessionId)
        if (!login?.auth)
          return {
            ok: false,
            text: 'Start OAuth sign-in in this session first.',
          }
        const result = await exchange(
          request.values.code,
          login.auth.verifier,
          login.auth.redirectUri,
          login.auth.state,
        )
        login.active.signal.throwIfAborted()
        options.signal?.throwIfAborted()
        if (closed || result.type !== 'success')
          return { ok: false, text: 'OAuth sign-in did not complete.' }
        await runtime.loginOAuth({
          routeId: crypto.randomUUID(),
          credential: result,
          label: request.values.label,
        })
        login.active.signal.throwIfAborted()
        options.signal?.throwIfAborted()
        if (closed) return { ok: false, text: 'Sign-in cancelled.' }
        pending.delete(request.sessionId)
        return {
          ok: true,
          text: 'OAuth account stored in the native account pool.',
        }
      }
      case 'reset-backoff': {
        const snapshot = await runtime.read()
        for (const account of snapshot.accounts) {
          options.signal?.throwIfAborted()
          if (account.type !== 'oauth') continue
          const fence =
            account.source === 'vault'
              ? await runtime.authorizeVault(account.id, options.signal)
              : await runtime.captureLocalSubject(account.id)
          await runtime.resetBackoff(account.id, fence)
        }
        return done()
      }
      case 'enrollment-reset': {
        const result = await resetClaustrumEnrollmentState(
          getHostClaustrumEnrollmentPaths('opencode'),
          CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        )
        return {
          ok: result === 'reset',
          text:
            result === 'reset'
              ? 'Terminal enrollment state reset. Run offline setup to reconnect.'
              : 'Only terminal enrollment state may be reset; active enrollment was left unchanged.',
        }
      }
      case 'quota-refresh': {
        const snapshot = await runtime.read()
        const accounts = snapshot.accounts.filter(
          (account) => account.type === 'oauth' && account.enabled,
        )
        const results = await Promise.allSettled(
          accounts.map((account) =>
            runtime.fetchQuota(account.id, undefined, options.signal),
          ),
        )
        const ok = results.every((result) => result.status === 'fulfilled')
        return {
          ok,
          text: `${results.filter((result) => result.status === 'fulfilled').length}/${accounts.length} native quota readings refreshed.`,
        }
      }
      case 'routing-reset':
        await source.resetRouting(request.sessionId)
        return done()
      case 'routing-mode':
        await write('routing', { mode: request.values.mode })
        return done()
      case 'killswitch-on':
      case 'killswitch-off':
        await write('killswitch', {
          enabled: request.action === 'killswitch-on',
        })
        return done()
      case 'killswitch-set': {
        await runtime.updateSettings((settings) => {
          const existing = record(settings.killswitch)
          const accounts = { ...record(existing.accounts) }
          let main = existing.main
          for (const entry of request.values.entries) {
            const threshold = {
              five_hour: entry.fh,
              seven_day: entry.sd,
              ...(entry.scoped !== undefined ? { scoped: entry.scoped } : {}),
            }
            if (entry.account === 'main' || entry.account === 'all')
              main = threshold
            if (entry.account === 'all')
              for (const id of Object.keys(accounts)) accounts[id] = threshold
            else if (entry.account !== 'main')
              accounts[entry.account] = threshold
          }
          return { ...settings, killswitch: { ...existing, main, accounts } }
        })
        return done()
      }
      case 'cache-on':
      case 'cache-off':
        await write('claudeCache', { enabled: request.action === 'cache-on' })
        return done()
      case 'cache-mode':
        await write('claudeCache', { mode: request.values.mode })
        return done()
      case 'cachekeep-always':
        await write('cacheKeep', { enabled: true, always: true })
        return done()
      case 'cachekeep-off':
        await write('cacheKeep', { enabled: false })
        return done()
      case 'cachekeep-window':
        await write('cacheKeep', {
          enabled: true,
          always: false,
          startHour: request.values.startHour,
          endHour: request.values.endHour,
        })
        return done()
      case 'cachekeep-subagents':
        await write('cacheKeep', { subagents: request.values.enabled === 'on' })
        return done()
      case 'dump-on':
      case 'dump-off':
        await write('dump', { enabled: request.action === 'dump-on' })
        return done()
      case 'logging-level':
        await write('logging', { level: request.values.level })
        return done()
      case 'fast-on':
      case 'fast-off':
        await write('claudeFast', { enabled: request.action === 'fast-on' })
        return done()
      case 'prime-on':
      case 'prime-off':
        await write('prime', { enabled: request.action === 'prime-on' })
        return done()
      case 'start-fire':
        await optionsStart(request.sessionId)
        return { ok: true, text: 'Claude lane start queued in this session.' }
    }
  }
  const optionsStart = (sessionID: string) =>
    options.start(sessionID, LANE_START_TEXT)
  return {
    dispatch,
    async readStatus(command) {
      const snapshot = await runtime.read()
      if (command === 'account')
        return (
          snapshot.accounts
            .map(
              (account) =>
                `${account.id}${account.label ? ` (${account.label})` : ''}: ${account.type}, ${account.source}, ${account.enabled ? 'enabled' : 'disabled'}${account.state ? `, ${formatNativeAccountState(account)}` : ''}${account.accountIdentity ? `, ${account.accountIdentity}` : ''}`,
            )
            .join('\n') || 'No native Claude accounts.'
        )
      if (command === 'quota')
        return buildClaudeQuotaSummary({
          accounts: snapshot.accounts
            .filter((account) => account.type === 'oauth')
            .map((account) => ({
              name: account.label ?? account.id,
              role:
                account.id === 'main'
                  ? ('main' as const)
                  : ('fallback' as const),
              enabled: account.enabled,
              quota: account.quota,
              tierLabel: formatOAuthAccountTier(account.profile),
              lastRefreshedAt: account.lastRefreshedAt,
              error: account.lastQuotaRefreshError?.message,
            })),
        }).replace(
          /Usage:[^\n]*/,
          'Use /claude to refresh native quota readings.',
        )
      if (command === 'prime')
        return buildPrimeStatusSummary({
          enabled: snapshot.policyStorage.prime?.enabled === true,
          accounts: buildPrimeAccountStatuses(snapshot.policyStorage),
        }).replace(/Usage:[^\n]*/, 'Use /claude to change Prime settings.')
      const fields = {
        routing: 'routing',
        killswitch: 'killswitch',
        cache: 'claudeCache',
        cachekeep: 'cacheKeep',
        dump: 'dump',
        logging: 'logging',
        fast: 'claudeFast',
        prime: 'prime',
      } as const
      return JSON.stringify(snapshot.settings[fields[command]] ?? {})
    },
    forgetSession(sessionID) {
      pending.get(sessionID)?.active.abort()
      pending.delete(sessionID)
    },
    close() {
      closed = true
      for (const login of pending.values()) login.active.abort()
      pending.clear()
    },
  }
}
