import { describe, expect, test } from 'bun:test'
import type {
  NativeAccountSnapshot,
  NativeAccountView,
} from '@cortexkit/anthropic-auth-core'
import { normalizeSidebarState } from '../sidebar-state'
import type { NativeMenuCapabilities } from '../v2/menu-contract'
import { NATIVE_MENU_RPC, registerNativeMenu } from '../v2/rpc'
import { buildNativeSidebarState } from '../v2/sidebar'

const now = Date.UTC(2026, 9, 18, 12)
const checkedAt = now - 60_000
const quota = (fiveHourUsed: number, sevenDayUsed: number) => ({
  checkedAt,
  five_hour: {
    usedPercent: fiveHourUsed,
    remainingPercent: 100 - fiveHourUsed,
    checkedAt,
  },
  seven_day: {
    usedPercent: sevenDayUsed,
    remainingPercent: 100 - sevenDayUsed,
    checkedAt,
  },
})

function account(overrides: Partial<NativeAccountView>): NativeAccountView {
  return {
    id: 'main',
    type: 'oauth',
    source: 'local',
    enabled: true,
    ...overrides,
  }
}

function snapshot(
  accounts: NativeAccountView[],
  policyStorage: Record<string, unknown> = {},
): NativeAccountSnapshot {
  return {
    mode: 'local',
    settings: {},
    accounts,
    policyStorage: { version: 1, accounts: [], ...policyStorage },
  } as unknown as NativeAccountSnapshot
}

const extras = { activeId: undefined, trackedSessions: 0, now }

describe('OpenCode 2 sidebar state', () => {
  test('lists main and enabled OAuth fallbacks with their quota, never API keys', () => {
    const state = buildNativeSidebarState(
      snapshot([
        account({ quota: quota(20, 40) }),
        account({ id: 'work', label: 'Work', quota: quota(85, 10) }),
        account({ id: 'off', label: 'Off', enabled: false }),
        account({ id: 'paid', type: 'api', label: 'Paid key' }),
      ]),
      extras,
    )
    expect(state.main.quota?.five_hour?.remainingPercent).toBe(80)
    expect(state.fallbacks.map((entry) => entry.id)).toEqual(['work'])
    expect(state.fallbacks[0]?.label).toBe('Work')
    expect(state.fallbacks[0]?.quota?.five_hour?.usedPercent).toBe(85)
    expect(state.lastUpdated).toBe(now)
  })

  test('names the account that served the session as active', () => {
    const accounts = [
      account({ quota: quota(1, 1) }),
      account({ id: 'work', quota: quota(1, 1) }),
    ]
    expect(
      buildNativeSidebarState(snapshot(accounts), {
        ...extras,
        activeId: 'work',
      }).activeId,
    ).toBe('work')
    expect(buildNativeSidebarState(snapshot(accounts), extras).activeId).toBe(
      undefined,
    )
  })

  test('reports active backoffs and accounts that need a new sign-in', () => {
    const state = buildNativeSidebarState(
      snapshot([
        account({
          lastQuotaRefreshError: {
            message: 'rate limited',
            checkedAt: now - 1_000,
            nextRetryAt: now + 120_000,
          },
          lastRefreshError: {
            message: 'temporarily unavailable',
            checkedAt: now - 1_000,
            nextRetryAt: now + 60_000,
            status: 503,
          },
        }),
        account({
          id: 'dead',
          lastRefreshError: {
            message: 'invalid_grant',
            checkedAt: now - 1_000,
            nextRetryAt: now + 86_400_000,
            permanent: true,
          },
        }),
        account({
          id: 'old',
          lastRefreshError: {
            message: 'invalid_grant',
            checkedAt: now - 90_000_000,
            nextRetryAt: now - 1_000,
            permanent: true,
          },
        }),
        account({ id: 'vault', source: 'vault', state: 'needs_reauth' }),
      ] as NativeAccountView[]),
      extras,
    )
    expect(state.main.quotaBackedOff).toBe(true)
    expect(state.main.quotaBackoffUntil).toBe(now + 120_000)
    expect(state.main.refreshBackedOff).toBe(true)
    const byId = Object.fromEntries(
      state.fallbacks.map((entry) => [entry.id, entry]),
    )
    expect(byId.dead?.needsReauth).toBe(true)
    expect(byId.old?.needsReauth).toBe(false)
    expect(byId.vault?.vaultReauth).toBe(true)
    expect(byId.vault?.stateLine).toBe('needs sign-in in the vault')
    expect(byId.vault?.quotaDated).toBe(true)
    expect(byId.vault?.custodyState).toBe('on-vault-reauth')
  })

  test('keeps turned-off vault accounts with their custody state, as OpenCode 1 does', () => {
    const state = buildNativeSidebarState(
      snapshot([
        account({ source: 'vault', state: 'active' }),
        account({ id: 'served', source: 'vault', state: 'active' }),
        account({
          id: 'off',
          label: 'Off',
          source: 'vault',
          state: 'active',
          enabled: false,
          quota: quota(10, 10),
        }),
        account({ id: 'cold', source: 'vault', state: 'cold' }),
        account({ id: 'local-off', enabled: false }),
      ]),
      extras,
    )
    const byId = Object.fromEntries(
      state.fallbacks.map((entry) => [entry.id, entry]),
    )
    expect(Object.keys(byId)).toEqual(['served', 'off', 'cold'])
    expect(byId.served).toMatchObject({
      custodyState: 'on-vault-served',
      vaultServed: true,
    })
    expect(byId.served?.stateLine).toBeUndefined()
    expect(byId.off).toMatchObject({
      enabled: false,
      custodyState: 'on-cold',
      stateLine: 'turned off',
      quotaDated: true,
    })
    expect(byId.off?.vaultServed).toBeUndefined()
    expect(byId.cold).toMatchObject({
      custodyState: 'on-cold',
      stateLine: 'unavailable in the vault',
    })
    // The shared renderer keeps rows whose custody is not 'off'.
    expect(
      normalizeSidebarState(JSON.parse(JSON.stringify(state))).fallbacks.map(
        (entry) => entry.custodyState,
      ),
    ).toEqual(['on-vault-served', 'on-cold', 'on-cold'])
  })

  test('explains an unsupported saved credential instead of showing it as serving', () => {
    const state = buildNativeSidebarState(
      snapshot([
        account({ state: 'unsupported-access' }),
        account({ id: 'work', state: 'unsupported-access' }),
      ]),
      extras,
    )
    expect(state.main.stateLine).toContain('sign in to this account again')
    expect(state.main.quotaDated).toBe(true)
    expect(state.fallbacks[0]?.stateLine).toContain(
      'sign in to this account again',
    )
  })

  test('ignores a refresh backoff recorded for a replaced login', () => {
    const lastRefreshError = {
      message: 'invalid_grant',
      checkedAt: now - 1_000,
      nextRetryAt: now + 86_400_000,
      permanent: true,
      accountIdentity: 'previous-account',
    }
    const state = buildNativeSidebarState(
      snapshot([
        account({ accountIdentity: 'current-account', lastRefreshError }),
        account({
          id: 'work',
          accountIdentity: 'current-account',
          lastRefreshError,
        }),
      ]),
      extras,
    )
    expect(state.main.refreshBackedOff).toBe(false)
    expect(state.fallbacks[0]?.needsReauth).toBe(false)
  })

  test('projects routing, fast mode, relay, cache keepalive and Prime from policy', () => {
    const state = buildNativeSidebarState(
      snapshot([account({})], {
        routing: { mode: 'fallback-first' },
        claudeFast: { enabled: true },
        relay: {
          enabled: true,
          url: 'https://relay.invalid',
          tokenConfigured: true,
          transport: 'http',
        },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true },
        prime: { enabled: true },
      }),
      { ...extras, trackedSessions: 3 },
    )
    expect(state.route).toBe('fallback-first')
    expect(state.fastMode).toBe(true)
    expect(state.relay).toEqual({ enabled: true, transport: 'http' })
    expect(state.cacheKeep?.enabled).toBe(true)
    expect(state.cacheKeep?.window).toBe('always')
    expect(state.cacheKeep?.trackedSessions).toBe(3)
    expect(state.prime?.enabled).toBe(true)
    expect(state.prime?.accounts[0]?.id).toBe('main')

    const plain = buildNativeSidebarState(snapshot([account({})]), extras)
    expect(plain.fastMode).toBe(false)
    expect(plain.relay).toBeNull()
    expect(plain.prime).toBeUndefined()
    expect(plain.cacheKeep?.enabled).toBe(false)
  })

  test('survives the RPC boundary unchanged and carries no secret', () => {
    const state = buildNativeSidebarState(
      snapshot([
        account({
          quota: quota(30, 60),
          accountIdentity: '11111111-2222-4333-8444-555555555555',
          credentialId: 'credential-secret-id',
        }),
      ]),
      { ...extras, activeId: 'main' },
    )
    const wire = JSON.parse(JSON.stringify(state))
    expect(normalizeSidebarState(wire)).toEqual(normalizeSidebarState(state))
    const text = JSON.stringify(state)
    expect(text).not.toContain('11111111-2222')
    expect(text).not.toContain('credential-secret-id')
  })
})

describe('OpenCode 2 sidebar RPC', () => {
  test('the output schema fails closed to the empty state', async () => {
    const validate =
      NATIVE_MENU_RPC.methods.sidebar.output['~standard'].validate
    const result = await validate('not a state')
    expect('value' in result && result.value.fallbacks).toEqual([])
    expect('value' in result && result.value.main.quota).toBeNull()
  })

  test('registers a sidebar handler that reads the requested session', async () => {
    let handlers: Record<string, (input: never) => unknown> = {}
    const ctx = {
      rpc: {
        register: async (_definition: unknown, value: typeof handlers) => {
          handlers = value
          return { dispose: async () => {}, events: { emit: async () => {} } }
        },
      },
      command: {
        transform: async () => ({ dispose: async () => {} }),
      },
      event: {
        subscribe: async function* () {},
      },
    }
    const asked: string[] = []
    const capabilities = {
      readSidebar: async (sessionID: string) => {
        asked.push(sessionID)
        return normalizeSidebarState({ activeId: 'main', route: 'main' })
      },
      forgetSession: () => {},
    } as unknown as NativeMenuCapabilities
    const registration = await registerNativeMenu(
      ctx as never,
      {} as never,
      capabilities,
    )
    const answer = (await handlers.sidebar?.({
      sessionId: 'ses_a',
    } as never)) as {
      activeId?: string
    }
    expect(asked).toEqual(['ses_a'])
    expect(answer.activeId).toBe('main')
    await registration.dispose()
  })
})
