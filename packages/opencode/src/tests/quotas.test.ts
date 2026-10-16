import { describe, expect, test } from 'bun:test'
import type {
  AccountStorage,
  OAuthAccount,
} from '@cortexkit/anthropic-auth-core'
import {
  buildClaudeQuotaSummary,
  buildFallbackQuotaSummaries,
} from '@cortexkit/anthropic-auth-core'

describe('quota summaries', () => {
  test('credit wording uses percentages rather than currency formatting', () => {
    const summary = buildClaudeQuotaSummary({
      accounts: [
        {
          name: 'malformed',
          role: 'main',
          quota: {
            extraUsage: {
              used: { amountMinor: 10035, currency: 'ZZZZ', exponent: 50 },
              limit: { amountMinor: 10000, currency: 'ZZZZ', exponent: 50 },
              exhausted: false,
            },
          },
        },
      ],
    })

    expect(summary).toContain('credits 0% left')
  })

  test('claude quota shows Team tier exhausted credits binding marker and fallback advice', () => {
    const summary = buildClaudeQuotaSummary({
      accounts: [
        {
          name: 'work',
          role: 'fallback',
          tierLabel: 'Team · Max 5x',
          quota: {
            five_hour: {
              usedPercent: 78,
              remainingPercent: 22,
              checkedAt: 100,
            },
            seven_day: {
              usedPercent: 40,
              remainingPercent: 60,
              checkedAt: 100,
            },
            extraUsage: {
              used: { amountMinor: 10035, currency: 'USD', exponent: 2 },
              limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
              exhausted: true,
            },
            bindingWindow: 'five_hour',
            bindingWindowSource: 'poll',
            fallbackAdvised: true,
          },
        },
      ],
      now: 100,
    })

    expect(summary).toContain('Team · Max 5x')
    expect(summary).toContain('credits spent')
    expect(summary).toContain('5h 22% left •')
    expect(summary).toContain('→ fallback advised')
  })

  test('claude quota omits credits and advice for disabled personal capture', () => {
    const summary = buildClaudeQuotaSummary({
      accounts: [
        {
          name: 'personal',
          role: 'main',
          tierLabel: 'Max 20x',
          quota: {
            five_hour: {
              usedPercent: 3,
              remainingPercent: 97,
              checkedAt: 100,
            },
            seven_day: {
              usedPercent: 12,
              remainingPercent: 88,
              checkedAt: 100,
            },
            fallbackAdvised: false,
          },
        },
      ],
      now: 100,
    })

    expect(summary).toContain('Max 20x')
    expect(summary).not.toContain('credits')
    expect(summary).not.toContain('fallback advised')
  })

  test('formats main and fallback quota windows', () => {
    const now = Date.parse('2026-04-28T12:00:00.000Z')
    const summary = buildClaudeQuotaSummary({
      now,
      refreshedAt: now,
      accounts: [
        {
          name: 'OpenCode anthropic',
          role: 'main',
          lastRefreshedAt: now - 2 * 60_000,
          quota: {
            five_hour: {
              usedPercent: 25,
              remainingPercent: 75,
              resetsAt: '2026-04-28T13:15:00.000Z',
              checkedAt: now,
            },
            seven_day: {
              usedPercent: 50,
              remainingPercent: 50,
              checkedAt: now - 60_000,
            },
            scoped: [
              {
                id: 'claude-weekly-scoped-fable',
                title: 'Fable only',
                modelName: 'Fable',
                usedPercent: 5,
                remainingPercent: 95,
                checkedAt: now,
              },
            ],
          },
        },
      ],
    })

    expect(summary).toContain('## Claude Quotas')
    expect(summary).toContain('### OpenCode anthropic (main)')
    expect(summary).toContain('Last token refresh: 2m ago')
    expect(summary).toContain('5h 75% left, resets 1h')
    expect(summary).toContain('7d 50% left')
    expect(summary).toContain('Fable only 95% left')
    expect(summary).not.toContain('checked')
  })

  test('formats reset timestamps as relative durations', () => {
    const now = Date.parse('2026-04-28T12:00:00.000Z')
    const summary = buildClaudeQuotaSummary({
      now,
      accounts: [
        {
          name: 'main',
          role: 'main',
          quota: {
            five_hour: {
              usedPercent: 0,
              remainingPercent: 100,
              resetsAt: '2026-04-28T12:09:05.000Z',
              checkedAt: now,
            },
            seven_day: {
              usedPercent: 0,
              remainingPercent: 100,
              resetsAt: 'not-a-date',
              checkedAt: now,
            },
          },
        },
      ],
    })

    expect(summary).toContain('5h 100% left, resets 9m')
    expect(summary).toContain('7d 100% left')
    expect(summary).not.toContain('not-a-date')
  })

  test('builds fallback summaries from sidecar storage', () => {
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [
        {
          id: 'fallback-1',
          label: 'personal',
          type: 'oauth',
          refresh: 'refresh',
          enabled: false,
          lastRefreshedAt: 2,
          quota: {
            five_hour: {
              usedPercent: 90,
              remainingPercent: 10,
              checkedAt: 1,
            },
          },
        },
      ],
    }

    expect(buildFallbackQuotaSummaries(storage)).toEqual([
      {
        name: 'personal',
        role: 'fallback',
        enabled: false,
        quota: (storage.accounts[0] as OAuthAccount).quota,
        lastRefreshedAt: 2,
      },
    ])
  })

  test('skips API-key fallback routes in OAuth quota summaries', () => {
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [
        {
          id: 'kie-opus',
          label: 'Kie Opus',
          type: 'api',
          apiKey: 'kie-key',
          baseURL: 'https://api.kie.ai/claude',
        },
      ],
    }

    expect(buildFallbackQuotaSummaries(storage)).toEqual([])
  })

  test('includes fallback quota refresh errors when available', () => {
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [
        {
          id: 'fallback-1',
          label: 'personal',
          type: 'oauth',
          refresh: 'refresh',
        },
      ],
    }

    expect(
      buildFallbackQuotaSummaries(
        storage,
        new Map([['fallback-1', 'Fallback token refresh failed: 400']]),
      ),
    ).toEqual([
      {
        name: 'personal',
        role: 'fallback',
        enabled: true,
        quota: undefined,
        lastRefreshedAt: undefined,
        error: 'Fallback token refresh failed: 400',
      },
    ])
  })
})
