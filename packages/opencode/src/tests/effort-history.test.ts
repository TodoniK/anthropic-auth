import { describe, expect, test } from 'bun:test'
import {
  applyOpenCodeEffortMarkers,
  EFFORT_ANCHOR_PREFIX,
  EFFORT_MARKER_PREFIX,
  encodeOpenCodeEffortPlan,
  markOpenCodeEffortTransitions,
  OpenCodeEffortPlanTracker,
} from '../effort-history.ts'

const user = (
  id: string,
  sessionID: string,
  modelID: string,
  variant?: string,
  providerID = 'anthropic',
) => ({
  info: {
    id,
    role: 'user',
    sessionID,
    model: { providerID, modelID, variant },
  },
  parts: [{ type: 'text', text: id }],
})

const assistant = (id: string, sessionID: string) => ({
  info: { id, role: 'assistant', sessionID },
  parts: [] as Array<Record<string, unknown>>,
})

function markerTexts(messages: Array<{ parts?: Array<{ text?: unknown }> }>) {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) =>
      typeof part.text === 'string' &&
      part.text.startsWith(EFFORT_MARKER_PREFIX)
        ? [part.text]
        : [],
    ),
  )
}

describe('OpenCode Fable 5.1 effort markers', () => {
  test('marks user boundaries independently of OpenCode assistant record counts', () => {
    const messages = [
      user('msg_low', 'ses_effort', 'claude-fable-5-1', 'low'),
      assistant('msg_step_1', 'ses_effort'),
      assistant('msg_step_2', 'ses_effort'),
      user('msg_high', 'ses_effort', 'claude-fable-5-1', 'high'),
      assistant('msg_step_3', 'ses_effort'),
      user('msg_max', 'ses_effort', 'claude-fable-5-1', 'max'),
    ]

    const marked = markOpenCodeEffortTransitions(messages)

    expect(marked).toMatchObject({
      baseline: 'low',
      markerCount: 2,
      sessionId: 'ses_effort',
      messageId: 'msg_max',
    })
    const markers = markerTexts(messages)
    expect(markers).toHaveLength(2)
    expect(markers[0]).toContain('effort="h"')
    expect(markers[1]).toContain('effort="z"')
    expect(
      markers.every((marker) => / check="[0-9a-f]{32}"\/>$/.test(marker)),
    ).toBe(true)
  })

  test('replaces its own markers when the host invokes the transform twice', () => {
    const messages = [
      user('msg_low', 'ses_repeat', 'claude-fable-5-1', 'low'),
      assistant('msg_step', 'ses_repeat'),
      user('msg_high', 'ses_repeat', 'claude-fable-5-1', 'high'),
    ]

    const first = markOpenCodeEffortTransitions(messages)
    const firstMarkers = messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        typeof part.text === 'string' &&
        part.text.includes('cortexkit-internal-effort')
          ? [part.text]
          : [],
      ),
    )
    const second = markOpenCodeEffortTransitions(messages)
    expect(second).toEqual(first)
    expect(
      messages.flatMap((message) =>
        message.parts.flatMap((part) =>
          typeof part.text === 'string' &&
          part.text.includes('cortexkit-internal-effort')
            ? [part.text]
            : [],
        ),
      ),
    ).toEqual(firstMarkers)
    expect(markerTexts(messages)).toHaveLength(1)
  })

  test('removes correlated markers tagged by a later message transform before replanning', () => {
    const firstPass = [
      user('msg_first_low', 'ses_tagged', 'claude-fable-5-1', 'low'),
      user('msg_first_high', 'ses_tagged', 'claude-fable-5-1', 'high'),
    ]
    markOpenCodeEffortTransitions(firstPass)
    const priorTransition = markerTexts(firstPass)[0]
    expect(priorTransition).toBeDefined()

    const retainedLow = user(
      'msg_retained_low',
      'ses_tagged',
      'claude-fable-5-1',
      'low',
    )
    retainedLow.parts.push({
      type: 'text',
      text: `§901§ ${priorTransition}`,
    })
    const messages = [
      retainedLow,
      user('msg_retained_high', 'ses_tagged', 'claude-fable-5-1', 'high'),
      user('msg_current_high', 'ses_tagged', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()

    const body: {
      model: string
      output_config: { effort: string }
      messages: unknown[]
    } = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: messages.map((message) => ({
        role: 'user',
        content: message.parts.map((part) => ({
          type: 'text',
          text: part.text,
        })),
      })),
    }
    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
      ),
    ).not.toThrow()
    expect(body.messages).toContainEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    })
    expect(JSON.stringify(body)).not.toContain('cortexkit-internal-effort')
    expect(JSON.stringify(body)).not.toContain('§901§')
  })

  test('survives downstream tag persistence across later turns', () => {
    const messages = [
      user('msg_low', 'ses_persisted', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_persisted', 'claude-fable-5-1', 'high'),
    ]
    const persistedSources = new Map<string, string>()
    const runDownstreamTagger = () => {
      let tag = 1
      for (const message of messages) {
        message.parts.forEach((part, partIndex) => {
          if (typeof part.text !== 'string') return
          const key = `${message.info.id}:p${partIndex}`
          const source = persistedSources.get(key) ?? part.text
          persistedSources.set(key, source)
          part.text = `§${tag++}§ ${source}`
        })
      }
    }
    const lowerAndApply = (
      plan: NonNullable<ReturnType<typeof markOpenCodeEffortTransitions>>,
    ) => {
      const body: {
        model: string
        output_config: { effort: string }
        messages: unknown[]
      } = {
        model: 'claude-fable-5-1',
        output_config: { effort: 'high' },
        messages: messages.map((message) => ({
          role: 'user',
          content: message.parts.map((part) => ({
            type: 'text',
            text: part.text,
          })),
        })),
      }
      expect(() =>
        applyOpenCodeEffortMarkers(body, true, encodeOpenCodeEffortPlan(plan)),
      ).not.toThrow()
      expect(JSON.stringify(body)).not.toContain('cortexkit-internal-effort')
    }

    const firstPlan = markOpenCodeEffortTransitions(messages)
    expect(firstPlan).not.toBeNull()
    runDownstreamTagger()
    lowerAndApply(firstPlan as NonNullable<typeof firstPlan>)

    messages.push(
      user('msg_medium', 'ses_persisted', 'claude-fable-5-1', 'medium'),
    )
    const secondPlan = markOpenCodeEffortTransitions(messages)
    expect(secondPlan).not.toBeNull()
    runDownstreamTagger()
    lowerAndApply(secondPlan as NonNullable<typeof secondPlan>)
    expect(secondPlan?.markerCount).toBe(2)
  })

  test('folds a downstream-trimmed transition prefix into the retained baseline', () => {
    const messages = [
      user('msg_low', 'ses_prefix_trim', 'claude-fable-5-1', 'low'),
      user('msg_medium', 'ses_prefix_trim', 'claude-fable-5-1', 'medium'),
      user('msg_high', 'ses_prefix_trim', 'claude-fable-5-1', 'high'),
      user('msg_current', 'ses_prefix_trim', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    expect(plan?.markerCount).toBe(2)

    const retained = messages.slice(2)
    const body: {
      model: string
      output_config: { effort: string }
      messages: unknown[]
    } = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: retained.map((message) => ({
        role: 'user',
        content: message.parts.map((part) => ({
          type: 'text',
          text: part.text,
        })),
      })),
    }

    expect(
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toEqual({ found: 1, inserted: 1 })
    expect(body.output_config).toEqual({ effort: 'medium' })
    expect(body.messages).toEqual([
      {
        role: 'system',
        content: [],
        output_config: { effort: 'high' },
      },
      { role: 'user', content: [{ type: 'text', text: 'msg_high' }] },
      { role: 'user', content: [{ type: 'text', text: 'msg_current' }] },
    ])
  })

  test('folds all downstream-trimmed transitions into the current baseline', () => {
    const messages = [
      user('msg_low', 'ses_full_trim', 'claude-fable-5-1', 'low'),
      user('msg_medium', 'ses_full_trim', 'claude-fable-5-1', 'medium'),
      user('msg_high', 'ses_full_trim', 'claude-fable-5-1', 'high'),
      user('msg_current', 'ses_full_trim', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()

    const missingAnchorBody = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'msg_current' }],
        },
      ],
    }
    expect(() =>
      applyOpenCodeEffortMarkers(
        missingAnchorBody,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toThrow('Fable 5.1 effort marker correlation failed: expected 2, found 0')

    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        {
          role: 'user',
          content: messages[3]?.parts.map((part) => ({
            type: 'text',
            text: part.text.includes(EFFORT_ANCHOR_PREFIX)
              ? `§991§ ${part.text}`
              : part.text,
          })),
        },
      ],
    }
    expect(
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toEqual({ found: 0, inserted: 0 })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'msg_current' }],
      },
    ])
  })

  test('accepts authenticated effort history on a tool continuation', () => {
    const messages = [
      user('msg_low', 'ses_tool_continuation', 'claude-fable-5-1', 'low'),
      assistant('msg_prior', 'ses_tool_continuation'),
      user('msg_current', 'ses_tool_continuation', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    expect(plan?.markerCount).toBe(1)

    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: 'msg_low' },
        { role: 'assistant', content: [{ type: 'text', text: 'prior' }] },
        {
          role: 'user',
          content: messages[2]?.parts.map((part) => ({
            type: 'text',
            text: part.text,
          })),
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'result' },
          ],
        },
      ],
    }

    expect(
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toEqual({ found: 1, inserted: 1 })
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(JSON.stringify(body)).not.toContain('cortexkit-internal-effort')
  })

  test('rejects a plain user boundary appended after the effort anchor', () => {
    const messages = [
      user('msg_low', 'ses_user_suffix', 'claude-fable-5-1', 'low'),
      user('msg_current', 'ses_user_suffix', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: 'msg_low' },
        {
          role: 'user',
          content: messages[1]?.parts.map((part) => ({
            type: 'text',
            text: part.text,
          })),
        },
        { role: 'user', content: 'unexpected boundary' },
      ],
    }

    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toThrow('Missing or invalid internal Fable 5.1 effort anchor placement')
  })

  test('rejects a plain user turn after an assistant reply', () => {
    const messages = [
      user('msg_low', 'ses_plain_turn', 'claude-fable-5-1', 'low'),
      user('msg_current', 'ses_plain_turn', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: 'msg_low' },
        {
          role: 'user',
          content: messages[1]?.parts.map((part) => ({
            type: 'text',
            text: part.text,
          })),
        },
        { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        { role: 'user', content: [{ type: 'text', text: 'next turn' }] },
      ],
    }

    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toThrow('Missing or invalid internal Fable 5.1 effort anchor placement')
  })

  test('rejects a tool result that does not match the preceding tool use', () => {
    const messages = [
      user('msg_low', 'ses_tool_mismatch', 'claude-fable-5-1', 'low'),
      user('msg_current', 'ses_tool_mismatch', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: 'msg_low' },
        {
          role: 'user',
          content: messages[1]?.parts.map((part) => ({
            type: 'text',
            text: part.text,
          })),
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_expected', name: 'Read', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_other',
              content: 'result',
            },
          ],
        },
      ],
    }

    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toThrow('Missing or invalid internal Fable 5.1 effort anchor placement')
  })

  test('rejects a tool-result user message mixed with text', () => {
    const messages = [
      user('msg_low', 'ses_mixed_tool_result', 'claude-fable-5-1', 'low'),
      user('msg_current', 'ses_mixed_tool_result', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: 'msg_low' },
        {
          role: 'user',
          content: messages[1]?.parts.map((part) => ({
            type: 'text',
            text: part.text,
          })),
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'result' },
            { type: 'text', text: 'extra user text' },
          ],
        },
      ],
    }

    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toThrow('Missing or invalid internal Fable 5.1 effort anchor placement')
  })

  test('distinguishes a mismatched anchor token from invalid placement', () => {
    const marked = [
      user('msg_low', 'ses_anchor_token', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_anchor_token', 'claude-fable-5-1', 'high'),
      user('msg_current_a', 'ses_anchor_token', 'claude-fable-5-1', 'high'),
    ]
    const expected = [
      user('msg_low', 'ses_anchor_token', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_anchor_token', 'claude-fable-5-1', 'high'),
      user('msg_current_b', 'ses_anchor_token', 'claude-fable-5-1', 'high'),
    ]
    const markedPlan = markOpenCodeEffortTransitions(marked)
    const expectedPlan = markOpenCodeEffortTransitions(expected)
    expect(markedPlan).not.toBeNull()
    expect(expectedPlan).not.toBeNull()
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: marked.map((message) => ({
        role: 'user',
        content: message.parts.map((part) => ({
          type: 'text',
          text: part.text,
        })),
      })),
    }

    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(
          expectedPlan as NonNullable<typeof expectedPlan>,
        ),
        expectedPlan as NonNullable<typeof expectedPlan>,
      ),
    ).toThrow('Mismatched internal Fable 5.1 effort anchor token')
  })

  test('rejects non-prefix transition loss even with the resolved plan', () => {
    const messages = [
      user('msg_low', 'ses_non_prefix', 'claude-fable-5-1', 'low'),
      user('msg_medium', 'ses_non_prefix', 'claude-fable-5-1', 'medium'),
      user('msg_high', 'ses_non_prefix', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        {
          role: 'user',
          content: messages[1]?.parts.map((part) => ({
            type: 'text',
            text: part.text,
          })),
        },
        {
          role: 'user',
          content: messages[2]?.parts
            .filter(
              (part) =>
                typeof part.text === 'string' &&
                part.text.includes('cortexkit-internal-effort-anchor'),
            )
            .map((part) => ({ type: 'text', text: part.text })),
        },
      ],
    }

    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toThrow('Fable 5.1 effort marker non-prefix loss')
  })

  test('rejects a lowered marker sequence that differs from the post-transform request plan', () => {
    const messages = [
      user('msg_low', 'ses_digest', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_digest', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    const mismatchedHeader = encodeOpenCodeEffortPlan({
      ...(plan as NonNullable<typeof plan>),
      digest: '0'.repeat(64),
    })
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: messages.map((message) => ({
        role: 'user',
        content: message.parts.map((part) => ({
          type: 'text',
          text: part.text,
        })),
      })),
    }

    expect(() =>
      applyOpenCodeEffortMarkers(body, true, mismatchedHeader),
    ).toThrow('Fable 5.1 effort marker request plan mismatch')
  })

  test('defers a change past user records that OpenCode will not lower', () => {
    const dropped = user(
      'msg_dropped_high',
      'ses_deferred',
      'claude-fable-5-1',
      'high',
    )
    dropped.parts = []
    const current = user(
      'msg_current_high',
      'ses_deferred',
      'claude-fable-5-1',
      'high',
    )
    const messages = [
      user('msg_low', 'ses_deferred', 'claude-fable-5-1', 'low'),
      assistant('msg_step_1', 'ses_deferred'),
      dropped,
      assistant('msg_step_2', 'ses_deferred'),
      current,
    ]

    expect(markOpenCodeEffortTransitions(messages)).toMatchObject({
      baseline: 'low',
      markerCount: 1,
    })
    expect(dropped.parts).toEqual([])
    expect(markerTexts([current])).toHaveLength(1)

    const droppedBaseline = user(
      'msg_dropped_low',
      'ses_dropped_baseline',
      'claude-fable-5-1',
      'low',
    )
    droppedBaseline.parts = []
    const firstLowered = user(
      'msg_first_lowered',
      'ses_dropped_baseline',
      'claude-fable-5-1',
      'high',
    )
    expect(
      markOpenCodeEffortTransitions([droppedBaseline, firstLowered]),
    ).toMatchObject({ baseline: 'high', markerCount: 0 })
    expect(markerTexts([firstLowered])).toHaveLength(0)
  })

  test('folds the compaction effort and ignores reordered retained variants', () => {
    const compaction = user(
      'msg_300',
      'ses_compact',
      'claude-fable-5-1',
      'high',
    )
    compaction.parts.unshift({ type: 'compaction', text: '' })
    const retained = user('msg_100', 'ses_compact', 'claude-fable-5-1', 'low')
    const current = user('msg_400', 'ses_compact', 'claude-fable-5-1', 'xhigh')
    const messages = [
      compaction,
      assistant('msg_301', 'ses_compact'),
      retained,
      assistant('msg_101', 'ses_compact'),
      current,
    ]

    expect(markOpenCodeEffortTransitions(messages)).toMatchObject({
      baseline: 'high',
      markerCount: 1,
    })
    expect(markerTexts([retained])).toEqual([])
    expect(markerTexts([current])).toHaveLength(1)
    expect(markerTexts([current])[0]).toContain('effort="x"')
  })

  test('reuses a transform plan for retries of the matching chat request', () => {
    const plan = markOpenCodeEffortTransitions([
      user('msg_low', 'ses_headers', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_headers', 'claude-fable-5-1', 'high'),
    ])
    expect(plan).not.toBeNull()
    const tracker = new OpenCodeEffortPlanTracker()
    tracker.record(plan as NonNullable<typeof plan>)
    const wrongHeaders: Record<string, string> = {}
    expect(
      tracker.markHeaders({
        sessionId: 'ses_headers',
        messageId: 'msg_other',
        headers: wrongHeaders,
      }),
    ).toBe(false)
    expect(wrongHeaders).toEqual({})

    const headers: Record<string, string> = {}
    expect(
      tracker.markHeaders({
        sessionId: 'ses_headers',
        messageId: 'msg_high',
        headers,
      }),
    ).toBe(true)
    expect(headers['x-cortexkit-effort-plan']).toBe(
      encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
    )
    const retryHeaders: Record<string, string> = {}
    expect(
      tracker.markHeaders({
        sessionId: 'ses_headers',
        messageId: 'msg_high',
        headers: retryHeaders,
      }),
    ).toBe(true)
    expect(retryHeaders['x-cortexkit-effort-plan']).toBe(
      headers['x-cortexkit-effort-plan'],
    )
    expect(
      tracker.resolveHeader(retryHeaders['x-cortexkit-effort-plan']),
    ).toEqual(plan as NonNullable<typeof plan>)

    tracker.clear('ses_headers', 'msg_high')
    expect(
      tracker.markHeaders({
        sessionId: 'ses_headers',
        messageId: 'msg_high',
        headers: {},
      }),
    ).toBe(false)
  })

  test('distinguishes concurrent current messages with the same transition timeline', () => {
    const first = markOpenCodeEffortTransitions([
      user('msg_low', 'ses_concurrent', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_concurrent', 'claude-fable-5-1', 'high'),
      user('msg_current_a', 'ses_concurrent', 'claude-fable-5-1', 'high'),
    ])
    const second = markOpenCodeEffortTransitions([
      user('msg_low', 'ses_concurrent', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_concurrent', 'claude-fable-5-1', 'high'),
      user('msg_current_b', 'ses_concurrent', 'claude-fable-5-1', 'high'),
    ])
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    const tracker = new OpenCodeEffortPlanTracker()
    tracker.record(first as NonNullable<typeof first>)
    tracker.record(second as NonNullable<typeof second>)
    const firstHeader = encodeOpenCodeEffortPlan(
      first as NonNullable<typeof first>,
    )
    const secondHeader = encodeOpenCodeEffortPlan(
      second as NonNullable<typeof second>,
    )

    expect(firstHeader).not.toBe(secondHeader)
    expect(tracker.resolveHeader(firstHeader)?.messageId).toBe('msg_current_a')
    expect(tracker.resolveHeader(secondHeader)?.messageId).toBe('msg_current_b')
  })

  test('defaults absent variants to high and does not mark models without per-message effort', () => {
    const defaulted = [user('msg_default', 'ses_default', 'claude-fable-5-1')]
    const defaultPlan = markOpenCodeEffortTransitions(defaulted)
    expect(defaultPlan).toMatchObject({ baseline: 'high', markerCount: 0 })
    expect(markerTexts(defaulted)).toEqual([])
    expect(defaulted[0]?.parts).toHaveLength(1)
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'hello' }],
    }
    expect(
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(
          defaultPlan as NonNullable<typeof defaultPlan>,
        ),
      ),
    ).toEqual({ found: 0, inserted: 0 })
    expect(body.output_config).toEqual({ effort: 'high' })

    for (const model of ['claude-fable-5', 'claude-sonnet-5']) {
      const otherModel = [user('msg_other', 'ses_other', model, 'max')]
      expect(markOpenCodeEffortTransitions(otherModel)).toBeNull()
      expect(markerTexts(otherModel)).toEqual([])
    }
  })

  test('accepts a merged boundary whose transitions are a correctly-ordered run and emits the last effort', () => {
    const messages = [
      user('msg_low', 'ses_merged', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_merged', 'claude-fable-5-1', 'high'),
      user('msg_max', 'ses_merged', 'claude-fable-5-1', 'max'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    expect(plan?.markerCount).toBe(2)

    const highMarker = markerTexts([messages[1]!])[0]
    const maxMarker = markerTexts([messages[2]!])[0]
    const anchor = messages[2]!.parts
      .map((part) => part.text)
      .find((text) => text.startsWith(EFFORT_ANCHOR_PREFIX))
    expect(highMarker).toBeDefined()
    expect(maxMarker).toBeDefined()
    expect(anchor).toBeDefined()

    const body: {
      model: string
      output_config: { effort: string }
      messages: unknown[]
    } = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'low' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'msg_low' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: highMarker },
            { type: 'text', text: maxMarker },
            { type: 'text', text: anchor },
          ],
        },
      ],
    }

    expect(
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toEqual({ found: 2, inserted: 1 })
    expect(body.messages).toContainEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'max' },
    })
    expect(body.messages).not.toContainEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    })
    expect(JSON.stringify(body)).not.toContain('cortexkit-internal-effort')
  })

  test('rejects a merged boundary whose transitions are out of order', () => {
    const messages = [
      user('msg_low', 'ses_merged_order', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_merged_order', 'claude-fable-5-1', 'high'),
      user('msg_max', 'ses_merged_order', 'claude-fable-5-1', 'max'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    const highMarker = markerTexts([messages[1]!])[0]
    const maxMarker = markerTexts([messages[2]!])[0]
    const anchor = messages[2]!.parts
      .map((part) => part.text)
      .find((text) => text.startsWith(EFFORT_ANCHOR_PREFIX))
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'low' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'msg_low' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: maxMarker },
            { type: 'text', text: highMarker },
            { type: 'text', text: anchor },
          ],
        },
      ],
    }

    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toThrow('Fable 5.1 effort marker non-prefix loss')
  })

  test('rejects a merged boundary whose transitions are duplicated', () => {
    const messages = [
      user('msg_low', 'ses_merged_dup', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_merged_dup', 'claude-fable-5-1', 'high'),
      user('msg_max', 'ses_merged_dup', 'claude-fable-5-1', 'max'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    const highMarker = markerTexts([messages[1]!])[0]
    const maxMarker = markerTexts([messages[2]!])[0]
    const anchor = messages[2]!.parts
      .map((part) => part.text)
      .find((text) => text.startsWith(EFFORT_ANCHOR_PREFIX))
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'low' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'msg_low' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: highMarker },
            { type: 'text', text: highMarker },
            { type: 'text', text: maxMarker },
            { type: 'text', text: anchor },
          ],
        },
      ],
    }

    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toThrow('Fable 5.1 effort marker correlation failed: expected 2, found 3')
  })

  test('rejects a foreign-scope marker at index 1 of a merged boundary', () => {
    const messages = [
      user('msg_low', 'ses_merged_scope', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_merged_scope', 'claude-fable-5-1', 'high'),
      user('msg_max', 'ses_merged_scope', 'claude-fable-5-1', 'max'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    const highMarker = markerTexts([messages[1]!])[0]
    const anchor = messages[2]!.parts
      .map((part) => part.text)
      .find((text) => text.startsWith(EFFORT_ANCHOR_PREFIX))

    // A valid marker minted for a different session carries a foreign scope.
    const foreignMessages = [
      user('msg_foreign_low', 'ses_foreign_scope', 'claude-fable-5-1', 'low'),
      user('msg_foreign_high', 'ses_foreign_scope', 'claude-fable-5-1', 'high'),
    ]
    markOpenCodeEffortTransitions(foreignMessages)
    const foreignMarker = markerTexts([foreignMessages[1]!])[0]
    expect(foreignMarker).toBeDefined()

    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'low' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'msg_low' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: highMarker },
            { type: 'text', text: foreignMarker },
            { type: 'text', text: anchor },
          ],
        },
      ],
    }

    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toThrow('Fable 5.1 effort marker scope mismatch')
  })
})

test('preserves a header in flight when the same message plan is re-recorded after a prefix trim', () => {
  const full = [
    user('msg_low', 'ses_overwrite', 'claude-fable-5-1', 'low'),
    user('msg_medium', 'ses_overwrite', 'claude-fable-5-1', 'medium'),
    user('msg_high', 'ses_overwrite', 'claude-fable-5-1', 'high'),
    user('msg_current', 'ses_overwrite', 'claude-fable-5-1', 'high'),
  ]
  const first = markOpenCodeEffortTransitions(full)
  expect(first?.markerCount).toBe(2)
  if (!first) throw new Error('Missing first effort plan')
  const tracker = new OpenCodeEffortPlanTracker()
  tracker.record(first)
  const firstHeaders: Record<string, string> = {}
  expect(
    tracker.markHeaders({
      sessionId: first.sessionId,
      messageId: first.messageId,
      headers: firstHeaders,
    }),
  ).toBe(true)
  const firstHeader = firstHeaders['x-cortexkit-effort-plan']
  expect(firstHeader).toBe(encodeOpenCodeEffortPlan(first))

  const second = markOpenCodeEffortTransitions(full.slice(2))
  expect(second?.markerCount).toBe(0)
  if (!second) throw new Error('Missing re-recorded effort plan')
  tracker.record(second)
  const secondHeaders: Record<string, string> = {}
  expect(
    tracker.markHeaders({
      sessionId: second.sessionId,
      messageId: second.messageId,
      headers: secondHeaders,
    }),
  ).toBe(true)
  expect(secondHeaders['x-cortexkit-effort-plan']).not.toBe(firstHeader)
  expect(tracker.resolveHeader(firstHeader)).toEqual(first)
  expect(
    tracker.resolveHeader(secondHeaders['x-cortexkit-effort-plan']),
  ).toEqual(second)

  // Explicitly retiring the message revokes both headers. Re-recording alone
  // must preserve the old one while it is still in flight.
  tracker.clear(first.sessionId, first.messageId)
  expect(tracker.resolveHeader(firstHeader)).toBeUndefined()
  expect(
    tracker.resolveHeader(secondHeaders['x-cortexkit-effort-plan']),
  ).toBeUndefined()
})

test('bounds the plan history and its reverse index while retaining the newest header', () => {
  const tracker = new OpenCodeEffortPlanTracker()
  const cap = 4096
  const plan = (index: number) => ({
    scope: 'a'.repeat(32),
    baseline: 'high' as const,
    markerCount: 0,
    digest: index.toString(16).padStart(64, '0'),
    transitionTokens: [],
    sessionId: `ses_history_${index}`,
    messageId: `msg_history_${index}`,
  })
  const oldest = plan(0)
  const newest = plan(cap)
  for (let index = 0; index <= cap; index++) tracker.record(plan(index))
  const internals = tracker as unknown as {
    history: Map<string, unknown>
    historyByMessage: Map<string, Set<string>>
  }
  expect(internals.history.size).toBe(cap)
  expect(internals.historyByMessage.size).toBe(cap)
  expect(
    tracker.resolveHeader(encodeOpenCodeEffortPlan(oldest)),
  ).toBeUndefined()
  expect(tracker.resolveHeader(encodeOpenCodeEffortPlan(newest))).toEqual(
    newest,
  )
})

test('refuses complete marker loss when an earlier message survives the supposed prefix trim', () => {
  const messages = [
    user('msg_low', 'ses_nonprefix_zero', 'claude-fable-5-1', 'low'),
    user('msg_medium', 'ses_nonprefix_zero', 'claude-fable-5-1', 'medium'),
    user('msg_high', 'ses_nonprefix_zero', 'claude-fable-5-1', 'high'),
    user('msg_current', 'ses_nonprefix_zero', 'claude-fable-5-1', 'high'),
  ]
  const plan = markOpenCodeEffortTransitions(messages)
  expect(plan?.markerCount).toBe(2)
  if (!plan) throw new Error('Missing effort plan')
  const body = {
    model: 'claude-fable-5-1',
    output_config: { effort: 'low' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'msg_low' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'old reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'msg_current' }] },
    ],
  }
  expect(() =>
    applyOpenCodeEffortMarkers(
      body,
      true,
      encodeOpenCodeEffortPlan(plan),
      plan,
    ),
  ).toThrow('Fable 5.1 effort marker correlation failed: expected 2, found 0')
})

test('rebinds an identical zero-marker header across ordinary same-effort turns without revoking the newer turn', () => {
  const first = markOpenCodeEffortTransitions([
    user('msg_first', 'ses_zero_alias', 'claude-fable-5-1', 'high'),
  ])
  const second = markOpenCodeEffortTransitions([
    user('msg_first', 'ses_zero_alias', 'claude-fable-5-1', 'high'),
    user('msg_second', 'ses_zero_alias', 'claude-fable-5-1', 'high'),
  ])
  expect(first?.markerCount).toBe(0)
  expect(second?.markerCount).toBe(0)
  if (!first || !second) throw new Error('Missing same-effort plans')
  const firstHeader = encodeOpenCodeEffortPlan(first)
  const secondHeader = encodeOpenCodeEffortPlan(second)
  expect(firstHeader).toBe(secondHeader)

  const tracker = new OpenCodeEffortPlanTracker()
  tracker.record(first)
  tracker.record(second)
  expect(tracker.resolveHeader(secondHeader)?.messageId).toBe(second.messageId)
  tracker.clear(first.sessionId, first.messageId)
  expect(
    tracker.markHeaders({
      sessionId: second.sessionId,
      messageId: second.messageId,
      headers: {},
    }),
  ).toBe(true)
  expect(tracker.resolveHeader(secondHeader)?.messageId).toBe(second.messageId)
  tracker.clear(second.sessionId, second.messageId)
  expect(tracker.resolveHeader(secondHeader)).toBeUndefined()
})

test('rejects a cross-session plan collision even when its encoded zero-marker header is copied', () => {
  const first = markOpenCodeEffortTransitions([
    user('msg_first', 'ses_original', 'claude-fable-5-1', 'high'),
  ])
  expect(first?.markerCount).toBe(0)
  if (!first) throw new Error('Missing plan')
  const tracker = new OpenCodeEffortPlanTracker()
  tracker.record(first)
  const forged = { ...first, sessionId: 'ses_other', messageId: 'msg_other' }
  expect(encodeOpenCodeEffortPlan(forged)).toBe(encodeOpenCodeEffortPlan(first))
  expect(() => tracker.record(forged)).toThrow(
    'Fable 5.1 effort plan header collision',
  )
  expect(tracker.resolveHeader(encodeOpenCodeEffortPlan(first))).toEqual(first)
  expect(
    tracker.markHeaders({
      sessionId: forged.sessionId,
      messageId: forged.messageId,
      headers: {},
    }),
  ).toBe(false)
})

test('reports bounded shape metadata when every marker and anchor disappears but older history remains', () => {
  const messages = [
    user('msg_low', 'ses_missing_diag', 'claude-fable-5-1', 'low'),
    user('msg_high', 'ses_missing_diag', 'claude-fable-5-1', 'high'),
    user('msg_current', 'ses_missing_diag', 'claude-fable-5-1', 'high'),
  ]
  const plan = markOpenCodeEffortTransitions(messages)
  expect(plan?.markerCount).toBe(1)
  if (!plan) throw new Error('Missing effort plan')
  const body = {
    model: 'claude-fable-5-1',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'operator private text' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'assistant private text' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'current private text' }],
      },
    ],
  }
  let refusal: unknown
  try {
    applyOpenCodeEffortMarkers(body, true, encodeOpenCodeEffortPlan(plan), plan)
  } catch (error) {
    refusal = error
  }
  expect(refusal).toMatchObject({
    check: 'missing_all_markers',
    details: {
      markerCount: 1,
      resolvedPlan: true,
      plannedBoundaryId: 'msg_current',
      retainedMessageCount: 3,
      retainedUserMessageCount: 2,
      lastUserMessageIndex: 2,
      lastUserTextBlockCount: 1,
      lastUserToolResultBlockCount: 0,
    },
  })
  expect(JSON.stringify(refusal)).not.toContain('private text')
})

type HostMessage = ReturnType<typeof user> | ReturnType<typeof assistant>

/** Lower host records the way OpenCode does: one text block per text part. */
function lower(messages: HostMessage[]) {
  return messages.map((message) =>
    message.info.role === 'user'
      ? {
          role: 'user',
          content: (message.parts as Array<{ text?: unknown }>).flatMap(
            (part) =>
              typeof part.text === 'string'
                ? [{ type: 'text', text: part.text }]
                : [],
          ),
        }
      : { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  )
}

const ADAPTIVE = { type: 'adaptive', display: 'summarized' }

describe('OpenCode per-message effort beyond Fable 5.1', () => {
  for (const model of [
    'claude-mythos-5-1',
    'claude-opus-5-5',
    'claude-opus-5-5[1m]',
    'claude-opus-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
  ]) {
    test(`${model} keeps the earliest top-level effort and inserts a system marker`, () => {
      const session = `ses_${model}`
      const messages: HostMessage[] = [
        user('msg_low', session, model, 'low'),
        assistant('msg_step', session),
        user('msg_high', session, model, 'high'),
      ]
      const plan = markOpenCodeEffortTransitions(messages)
      expect(plan).toMatchObject({ baseline: 'low', markerCount: 1 })
      if (!plan) throw new Error('Missing effort plan')
      const body: Record<string, unknown> = {
        model,
        thinking: { ...ADAPTIVE },
        output_config: { effort: 'high' },
        messages: lower(messages),
      }

      expect(
        applyOpenCodeEffortMarkers(
          body,
          true,
          encodeOpenCodeEffortPlan(plan),
          plan,
        ),
      ).toEqual({ found: 1, inserted: 1 })
      expect(body.output_config).toEqual({ effort: 'low' })
      expect(body.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'msg_low' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'system', content: [], output_config: { effort: 'high' } },
        { role: 'user', content: [{ type: 'text', text: 'msg_high' }] },
      ])
    })
  }

  test('leaves a newly eligible request without an effort change byte-identical', () => {
    for (const [model, variant] of [
      ['claude-opus-5-5', 'high'],
      ['claude-opus-5-5', undefined],
      ['claude-sonnet-5-5', 'max'],
    ] as const) {
      const messages: HostMessage[] = [
        user('msg_first', 'ses_steady', model, variant),
        assistant('msg_step', 'ses_steady'),
        user('msg_second', 'ses_steady', model, variant),
      ]
      const plan = markOpenCodeEffortTransitions(messages)
      expect(plan).toMatchObject({ markerCount: 0 })
      if (!plan) throw new Error('Missing effort plan')
      const body: Record<string, unknown> = {
        model,
        thinking: { ...ADAPTIVE },
        ...(variant ? { output_config: { effort: variant } } : {}),
        messages: lower(messages),
      }
      const before = JSON.stringify(body)
      expect(
        applyOpenCodeEffortMarkers(
          body,
          true,
          encodeOpenCodeEffortPlan(plan),
          plan,
        ),
      ).toEqual({ found: 0, inserted: 0 })
      expect(JSON.stringify(body)).toBe(before)
    }
  })

  test('uses each model default effort for a turn without a variant', () => {
    const messages: HostMessage[] = [
      user('msg_default', 'ses_default_effort', 'claude-opus-5-5'),
      assistant('msg_step', 'ses_default_effort'),
      user('msg_low', 'ses_default_effort', 'claude-opus-5-5', 'low'),
    ]
    expect(markOpenCodeEffortTransitions(messages)).toMatchObject({
      baseline: 'medium',
      markerCount: 1,
    })
    expect(
      markOpenCodeEffortTransitions([
        user('msg_default', 'ses_default_sonnet', 'claude-sonnet-5-5'),
      ]),
    ).toMatchObject({ baseline: 'high', markerCount: 0 })
  })

  test('strips markers without inserting effort messages on Sonnet 5.5 between_tools', () => {
    const messages: HostMessage[] = [
      user('msg_low', 'ses_between', 'claude-sonnet-5-5', 'low'),
      assistant('msg_step', 'ses_between'),
      user('msg_high', 'ses_between', 'claude-sonnet-5-5', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    if (!plan) throw new Error('Missing effort plan')
    const body: Record<string, unknown> = {
      model: 'claude-sonnet-5-5',
      thinking: { type: 'between_tools' },
      output_config: { effort: 'high' },
      messages: lower(messages),
    }

    expect(
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan),
        plan,
      ),
    ).toEqual({ found: 1, inserted: 0 })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'msg_low' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'msg_high' }] },
    ])
  })

  test('strips markers without inserting effort messages on an API-key route', () => {
    const messages: HostMessage[] = [
      user('msg_low', 'ses_api_key', 'claude-opus-5-5', 'low'),
      assistant('msg_step', 'ses_api_key'),
      user('msg_high', 'ses_api_key', 'claude-opus-5-5', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    if (!plan) throw new Error('Missing effort plan')
    const body: Record<string, unknown> = {
      model: 'claude-opus-5-5',
      thinking: { ...ADAPTIVE },
      output_config: { effort: 'high' },
      messages: lower(messages),
    }

    expect(
      applyOpenCodeEffortMarkers(
        body,
        false,
        encodeOpenCodeEffortPlan(plan),
        plan,
      ),
    ).toEqual({ found: 1, inserted: 0 })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(JSON.stringify(body)).not.toContain('cortexkit-internal-effort')
    expect(body.messages).toHaveLength(3)
  })

  test('keeps one timeline per model family in a mixed session', () => {
    const fable = [
      user('msg_fable_low', 'ses_mixed', 'claude-fable-5-1', 'low'),
      assistant('msg_step_1', 'ses_mixed'),
      user('msg_opus_max', 'ses_mixed', 'claude-opus-5-5', 'max'),
      assistant('msg_step_2', 'ses_mixed'),
      user('msg_fable_current', 'ses_mixed', 'claude-fable-5-1', 'low'),
    ]
    expect(markOpenCodeEffortTransitions(fable)).toMatchObject({
      baseline: 'low',
      markerCount: 0,
    })
    expect(markerTexts(fable)).toEqual([])

    const opus = [
      user('msg_fable_low', 'ses_mixed', 'claude-fable-5-1', 'low'),
      assistant('msg_step_1', 'ses_mixed'),
      user('msg_opus_max', 'ses_mixed', 'claude-opus-5-5', 'max'),
      assistant('msg_step_2', 'ses_mixed'),
      user('msg_opus_current', 'ses_mixed', 'claude-opus-5-5[1m]', 'max'),
    ]
    expect(markOpenCodeEffortTransitions(opus)).toMatchObject({
      baseline: 'max',
      markerCount: 0,
    })
  })
})
