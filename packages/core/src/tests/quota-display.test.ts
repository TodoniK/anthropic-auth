import { describe, expect, test } from 'bun:test'
import type { OAuthQuotaSnapshot } from '../accounts.ts'
import {
  buildClaudeQuotaSummary,
  formatQuota,
  quotaDisplayProjection,
  quotaTextParts,
  quotaWindowParts,
} from '../quotas.ts'

const now = Date.parse('2026-04-28T12:00:00Z')
const hour = 3_600_000
const day = 24 * hour
const reset = (ms: number) => new Date(now + ms).toISOString()

describe('quota display adapter', () => {
  test('maps both standard windows and every model-scoped window without filtering families', () => {
    const snapshot: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 60,
        remainingPercent: 40,
        checkedAt: now,
        resetsAt: reset(2 * hour),
      },
      seven_day: {
        usedPercent: 30,
        remainingPercent: 70,
        checkedAt: now,
        resetsAt: reset(4 * day),
      },
      scoped: [
        {
          id: 'fable-weekly',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 90,
          remainingPercent: 10,
          checkedAt: now,
        },
        {
          id: 'opus-weekly',
          title: 'Opus only',
          modelName: 'Opus',
          modelId: 'claude-opus-5',
          usedPercent: 80,
          remainingPercent: 20,
          checkedAt: now,
        },
      ],
    }
    const projection = quotaDisplayProjection(snapshot, now)
    expect(projection?.limits).toEqual([
      {
        scope: 'all',
        label: 'five_hour',
        kind: 'reading',
        windowMinutes: 300,
        usedPercent: 60,
        remainingPercent: 40,
        checkedAt: now,
        resetsAt: reset(2 * hour),
      },
      {
        scope: 'all',
        label: 'seven_day',
        kind: 'reading',
        windowMinutes: 10080,
        usedPercent: 30,
        remainingPercent: 70,
        checkedAt: now,
        resetsAt: reset(4 * day),
      },
      {
        scope: 'Fable',
        label: 'Fable only',
        kind: 'reading',
        windowMinutes: 10080,
        usedPercent: 90,
        remainingPercent: 10,
        checkedAt: now,
        resetsAt: undefined,
      },
      {
        scope: 'claude-opus-5',
        label: 'Opus only',
        kind: 'reading',
        windowMinutes: 10080,
        usedPercent: 80,
        remainingPercent: 20,
        checkedAt: now,
        resetsAt: undefined,
      },
    ])
    expect(quotaTextParts(projection, { now })).toEqual([
      '5h 40% left, resets 2h',
      '7d 70% left, resets 4d',
      'Fable only 10% left',
      'Opus only 20% left',
    ])
    expect(snapshot.scoped).toHaveLength(2)
  })

  test('preserves independent remaining figures rather than deriving them from used percentages', () => {
    const projection = quotaDisplayProjection(
      {
        five_hour: {
          usedPercent: 59.9,
          remainingPercent: 40.4,
          checkedAt: now,
        },
      },
      now,
    )
    expect(
      quotaWindowParts(projection, { now }).windows[0]?.remainingPercent,
    ).toBe(40.4)
    expect(formatQuota(projection, { now })).toBe('5h 40% left')
  })

  test('stale exhausted readings keep their figure and expose reset-since-reading and oldest age', () => {
    const projection = quotaDisplayProjection(
      {
        five_hour: {
          usedPercent: 100,
          remainingPercent: 0,
          checkedAt: now - 2 * day,
          resetsAt: reset(-day),
        },
        seven_day: { usedPercent: 20, remainingPercent: 80, checkedAt: now },
      },
      now,
    )
    expect(quotaWindowParts(projection, { now })).toEqual({
      windows: [
        {
          kind: 'window',
          name: '5h',
          figure: '0% left',
          remainingPercent: 0,
          checkedAt: now - 2 * day,
          resetSinceReading: true,
        },
        {
          kind: 'window',
          name: '7d',
          figure: '80% left',
          remainingPercent: 80,
          checkedAt: now,
          resetSinceReading: false,
        },
      ],
      age: 'checked 2d ago',
    })
    expect(quotaTextParts(projection, { now })).toEqual([
      '5h 0% left',
      '7d 80% left',
      'checked 2d ago',
    ])
  })

  test('no reading and explicitly empty scoped lists never invent model windows', () => {
    expect(quotaDisplayProjection(undefined, now)).toBeUndefined()
    expect(quotaDisplayProjection(null, now)).toBeUndefined()
    const projection = quotaDisplayProjection({ scoped: [] }, now)
    expect(projection?.limits).toEqual([])
    expect(quotaWindowParts(projection, { now })).toEqual({ windows: [] })
    expect(formatQuota(projection, { now })).toBe('no quota reading yet')
    expect(formatQuota(undefined, { now })).toBe('no quota reading yet')
  })

  test('legacy sidebar readings use snapshot time when available and do not fabricate stale ages otherwise', () => {
    const window = { usedPercent: 60, remainingPercent: 40 }
    expect(
      formatQuota(quotaDisplayProjection({ five_hour: window }, now), { now }),
    ).toBe('5h 40% left')
    expect(
      formatQuota(
        quotaDisplayProjection(
          { five_hour: window, checkedAt: now - 2 * day },
          now,
        ),
        { now },
      ),
    ).toBe('5h 40% left · checked 2d ago')
  })

  test('maps extra-usage utilization and the provider exhaustion verdict independently', () => {
    const extraUsage = {
      used: { amountMinor: 2500, currency: 'USD', exponent: 2 },
      limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
      utilizationPercent: 60,
      exhausted: false,
    }
    const snapshot = { checkedAt: now - 2 * day, extraUsage }
    const projection = quotaDisplayProjection(snapshot, now)
    expect(projection?.budget).toEqual({
      checkedAt: now - 2 * day,
      reached: false,
      remainingPercent: 40,
    })
    expect(formatQuota(projection, { now })).toBe(
      'credits 40% left · checked 2d ago',
    )
    expect(
      formatQuota(
        quotaDisplayProjection(
          {
            ...snapshot,
            extraUsage: { ...extraUsage, exhausted: true },
          },
          now,
        ),
        { now },
      ),
    ).toBe('credits spent · checked 2d ago')
    expect(extraUsage.used.amountMinor).toBe(2500)
  })

  test('extra usage without utilization derives its figure from monetary totals, including non-cent units', () => {
    const projection = quotaDisplayProjection(
      {
        extraUsage: {
          used: { amountMinor: 6000, currency: 'JPY', exponent: 0 },
          limit: { amountMinor: 10000, currency: 'JPY', exponent: 0 },
          exhausted: false,
        },
      },
      now,
    )
    expect(formatQuota(projection, { now })).toBe('credits 40% left')
    expect(projection?.budget?.checkedAt).toBe(now)
  })

  test('a monetary budget percent is exact, so a model window that reads the same keeps the narrow slot', () => {
    const projection = quotaDisplayProjection(
      {
        five_hour: { usedPercent: 62, remainingPercent: 38, checkedAt: now },
        seven_day: { usedPercent: 41, remainingPercent: 59, checkedAt: now },
        scoped: [
          {
            id: 'fable',
            title: 'Fable only',
            modelName: 'Fable',
            usedPercent: 78,
            remainingPercent: 22,
            checkedAt: now,
          },
        ],
        extraUsage: {
          used: { amountMinor: 7800, currency: 'USD', exponent: 2 },
          limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
          exhausted: false,
        },
      },
      now,
    )
    expect(projection?.budget?.remainingPercent).toBe(22)
    expect(formatQuota(projection, { now, form: 'compact' })).toBe(
      '5h 38% left · 7d 59% left · Fable only 22% left · credits 22% left',
    )
    expect(formatQuota(projection, { now, form: 'narrow' })).toBe(
      '5h 38% · 7d 59% · Fa 22% left',
    )
  })

  test('zero extra-usage limits have no percentage unless the provider reports utilization', () => {
    const extraUsage = {
      used: { amountMinor: 0, currency: 'USD', exponent: 2 },
      limit: { amountMinor: 0, currency: 'USD', exponent: 2 },
      exhausted: false,
    }
    expect(
      formatQuota(quotaDisplayProjection({ extraUsage }, now), { now }),
    ).toBe('credits available')
    expect(
      formatQuota(
        quotaDisplayProjection(
          {
            extraUsage: {
              ...extraUsage,
              utilizationPercent: 100,
              exhausted: true,
            },
          },
          now,
        ),
        { now },
      ),
    ).toBe('credits spent')
  })

  test('the command summary shares stale wording, preserves scoped binding and handles no reading', () => {
    const summary = buildClaudeQuotaSummary({
      now,
      accounts: [
        {
          name: 'main',
          role: 'main',
          quota: {
            scoped: [
              {
                id: 'fable-weekly',
                title: 'Fable only',
                modelName: 'Fable',
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: now - 2 * day,
              },
            ],
            bindingWindow: 'fable-weekly',
          },
        },
        { name: 'empty', role: 'fallback', quota: { scoped: [] } },
      ],
    })
    expect(summary).toContain('  - Fable only 0% left •\n  - checked 2d ago')
    expect(summary).toContain('### empty (fallback)\n  - no quota reading yet')
    expect(summary).not.toContain('5h')
    expect(summary).not.toContain('7d')
  })
})
