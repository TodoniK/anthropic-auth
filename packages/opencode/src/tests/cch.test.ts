import { describe, expect, test } from 'bun:test'
import {
  buildBillingHeaderValue,
  computeCCH,
  computeCcVersionSuffix,
  countUserPrompts,
  extractFirstUserMessageText,
  signRequestBody,
  stripBillingLineageFields,
  stripBillingLineageFromBody,
} from '@cortexkit/anthropic-auth-core'

describe('billing header helpers', () => {
  test('extracts text from the first user message', () => {
    expect(
      extractFirstUserMessageText([
        { role: 'assistant', content: 'ignore me' },
        {
          role: 'user',
          content: [
            { type: 'image', text: 'ignored' },
            { type: 'text', text: 'hello world test message' },
          ],
        },
      ]),
    ).toBe('hello world test message')
  })

  test('uses the visible final text block after leading reminders', () => {
    expect(
      extractFirstUserMessageText([
        {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>first</system-reminder>' },
            { type: 'text', text: '<system-reminder>second</system-reminder>' },
            { type: 'text', text: 'What is 2+2? Answer in one sentence.' },
          ],
        },
      ]),
    ).toBe('What is 2+2? Answer in one sentence.')
    expect(
      computeCcVersionSuffix('What is 2+2? Answer in one sentence.', '2.1.258'),
    ).toBe('97a')
  })

  test('starts suffix sampling at the command name after leading reminders', () => {
    expect(
      extractFirstUserMessageText([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system-reminder>ignore this</system-reminder>',
            },
            {
              type: 'text',
              text: '<command-name>help</command-name>\nshow help',
            },
          ],
        },
      ]),
    ).toBe('<command-name>help</command-name>\nshow help')
  })

  test('computes the 5-character body cch hash', async () => {
    expect(
      await computeCCH(new TextEncoder().encode('hello world test message')),
    ).toBe('cc124')
  })

  test('computes the version suffix from the first user text', () => {
    expect(computeCcVersionSuffix('hello world test message', '2.1.258')).toBe(
      'ef1',
    )
    expect(computeCcVersionSuffix('hella world test message', '2.1.258')).toBe(
      '9ee',
    )
  })

  test('zero-pads missing sampled text positions', () => {
    expect(computeCcVersionSuffix('short', '2.1.258')).toBe('587')
  })

  test('signs serialized request body cch placeholder', async () => {
    const body = JSON.stringify({
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.87.623; cc_entrypoint=sdk-cli; cch=00000;',
        },
      ],
    })

    expect(await signRequestBody(body)).toContain('cch=12a77;')
  })

  test('includes request lineage in the canonical cch input like Claude Code', async () => {
    const base = {
      messages: [{ role: 'user', content: 'hello' }],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.258.123; cc_entrypoint=cli; cch=00000;',
        },
      ],
    }
    const lineage = structuredClone(base)
    lineage.system[0]!.text +=
      ' cc_prev_req=req_011111111111111111111111; cc_prompt_id=00000000-0000-4000-8000-000000000001;'

    const baseCch = (await signRequestBody(JSON.stringify(base))).match(
      /cch=([0-9a-f]{5});/,
    )?.[1]
    const lineageCch = (await signRequestBody(JSON.stringify(lineage))).match(
      /cch=([0-9a-f]{5});/,
    )?.[1]

    expect(lineageCch).not.toBe(baseCch)
  })

  test('signing an already-signed body is idempotent', async () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hello' }],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.258.123; cc_entrypoint=cli; cch=00000;',
        },
      ],
    })
    const signed = await signRequestBody(body)

    expect(await signRequestBody(signed)).toBe(signed)
  })

  test('uses the empty-text suffix for empty and non-text first-user shapes', () => {
    const expected = computeCcVersionSuffix('', '2.1.258')

    expect(buildBillingHeaderValue([], '2.1.258', 'cli')).toContain(
      `cc_version=2.1.258.${expected};`,
    )
    expect(
      buildBillingHeaderValue(
        [{ role: 'assistant', content: 'no user' }],
        '2.1.258',
        'cli',
      ),
    ).toContain(`cc_version=2.1.258.${expected};`)
    expect(
      buildBillingHeaderValue(
        [
          {
            role: 'user',
            content: [{ type: 'image', text: 'ignored' }],
          },
        ],
        '2.1.258',
        'cli',
      ),
    ).toContain(`cc_version=2.1.258.${expected};`)
  })

  test('canonical cch ignores model and max_tokens but keeps fallbacks', async () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.258.123; cc_entrypoint=cli; cch=00000;',
        },
      ],
      max_tokens: 1024,
      fallbacks: ['claude-haiku-4-5'],
    }
    const changed = {
      ...body,
      model: 'claude-opus-4-6',
      max_tokens: 4096,
    }
    const withoutFallbacks: Record<string, unknown> = { ...body }
    delete withoutFallbacks.fallbacks

    const signed = JSON.parse(await signRequestBody(JSON.stringify(body)))
    const changedSigned = JSON.parse(
      await signRequestBody(JSON.stringify(changed)),
    )
    const withoutFallbacksSigned = JSON.parse(
      await signRequestBody(JSON.stringify(withoutFallbacks)),
    )
    expect(changedSigned.system[0].text).toBe(signed.system[0].text)
    expect(withoutFallbacksSigned.system[0].text).not.toBe(
      signed.system[0].text,
    )
  })

  test('signs only the billing header cch and leaves message history unchanged', async () => {
    const historyText = 'historical debug content: cch=abcde; cch=00000;'
    const body = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: historyText }],
        },
      ],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.87.623; cc_entrypoint=sdk-cli; cch=00000;',
        },
      ],
    })

    const signed = await signRequestBody(body)
    const parsed = JSON.parse(signed)

    expect(parsed.messages[0].content[0].text).toBe(historyText)
    expect(parsed.system[0].text).toMatch(/cch=[0-9a-f]{5};$/)
    expect(parsed.system[0].text).not.toContain('cch=00000;')
  })

  test('builds the full billing header value', () => {
    expect(
      buildBillingHeaderValue(
        [{ role: 'user', content: 'hello world test message' }],
        '2.1.258',
        'cli',
      ),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.258.ef1; cc_entrypoint=cli; cch=00000;',
    )
  })

  test('appends validated request lineage in Claude Code wire order', () => {
    expect(
      buildBillingHeaderValue(
        [{ role: 'user', content: 'hello world test message' }],
        '2.1.258',
        'cli',
        undefined,
        {
          previousRequestId: 'req_011111111111111111111111',
          promptId: '00000000-0000-4000-8000-000000000001',
        },
      ),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.258.ef1; cc_entrypoint=cli; cch=00000; cc_prev_req=req_011111111111111111111111; cc_prompt_id=00000000-0000-4000-8000-000000000001;',
    )
  })

  test('appends the 2.1.302 turn fields after the prompt id, and only with one', () => {
    const messages = [{ role: 'user', content: 'hello world test message' }]
    expect(
      buildBillingHeaderValue(messages, '2.1.302', 'cli', undefined, {
        previousRequestId: 'req_011111111111111111111111',
        promptId: '00000000-0000-4000-8000-000000000001',
        promptIndex: 2,
      }),
    ).toEndWith(
      '; cch=00000; cc_prev_req=req_011111111111111111111111; cc_prompt_id=00000000-0000-4000-8000-000000000001; cc_turn_origin=human; cc_prompt_index=2; cc_turn_index=2;',
    )
    // No prompt id (a background request): no turn fields either.
    expect(
      buildBillingHeaderValue(messages, '2.1.302', 'cli', undefined, {
        promptIndex: 2,
      }),
    ).toEndWith('; cch=00000;')
    for (const promptIndex of [0, -1, 1.5]) {
      expect(
        buildBillingHeaderValue(messages, '2.1.302', 'cli', undefined, {
          promptId: '00000000-0000-4000-8000-000000000001',
          promptIndex,
        }),
      ).toEndWith('cc_prompt_id=00000000-0000-4000-8000-000000000001;')
    }
    expect(
      stripBillingLineageFields(
        'x-anthropic-billing-header: cc_version=2.1.302.ef1; cc_entrypoint=cli; cch=abcde; cc_prompt_id=00000000-0000-4000-8000-000000000001; cc_turn_origin=human; cc_prompt_index=3; cc_turn_index=3;',
      ),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.302.ef1; cc_entrypoint=cli; cch=abcde;',
    )
  })

  test('counts user prompts, not tool-result follow-ups', () => {
    expect(countUserPrompts(undefined)).toBe(0)
    expect(
      countUserPrompts([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
        { role: 'system', content: [] },
        { role: 'assistant', content: 'done' },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't2' },
            { type: 'text', text: 'and another thing' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
      ]),
    ).toBe(3)
  })

  test('strips lineage only from the generated billing block', () => {
    const body = {
      system: [
        {
          type: 'text',
          text: 'Keep this user text cc_prompt_id=00000000-0000-4000-8000-000000000001;',
        },
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.258.ef1; cc_entrypoint=cli; cch=abcde; cc_prev_req=req_011111111111111111111111; cc_prompt_id=00000000-0000-4000-8000-000000000001;',
        },
      ],
    }

    expect(stripBillingLineageFromBody(body)).toBe(1)
    expect(body.system[0]?.text).toContain('cc_prompt_id=')
    expect(body.system[1]?.text).toBe(
      'x-anthropic-billing-header: cc_version=2.1.258.ef1; cc_entrypoint=cli; cch=abcde;',
    )
  })

  test('omits malformed lineage values and strips lineage from reusable bodies', () => {
    expect(
      buildBillingHeaderValue(
        [{ role: 'user', content: 'hello world test message' }],
        '2.1.258',
        'cli',
        undefined,
        {
          previousRequestId: 'req_bad; injected=true',
          promptId: 'not-a-uuid',
        },
      ),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.258.ef1; cc_entrypoint=cli; cch=00000;',
    )
    expect(
      stripBillingLineageFields(
        'x-anthropic-billing-header: cc_version=2.1.258.ef1; cc_entrypoint=cli; cch=abcde; cc_prev_req=req_011111111111111111111111; cc_prompt_id=00000000-0000-4000-8000-000000000001;',
      ),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.258.ef1; cc_entrypoint=cli; cch=abcde;',
    )
  })
})
