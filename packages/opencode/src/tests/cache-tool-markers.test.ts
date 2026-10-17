import { describe, expect, test } from 'bun:test'
import { rewriteRequestBody } from '../transform'

const source = {
  model: 'claude-sonnet-4-6',
  max_tokens: 16,
  tools: [
    { name: 'one', input_schema: { type: 'object', properties: {} } },
    {
      name: 'two',
      input_schema: { type: 'object', properties: {} },
      cache_control: { type: 'ephemeral' },
    },
  ],
  system: [
    {
      type: 'text',
      text: 'First system',
      cache_control: { type: 'ephemeral' },
    },
    { type: 'text', text: 'Last system', cache_control: { type: 'ephemeral' } },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'One' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Two' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Three', cache_control: { type: 'ephemeral' } },
      ],
    },
  ],
}

function markers(body: any): Array<{ type: string; ttl?: string }> {
  return [
    ...body.tools,
    ...body.system,
    ...body.messages.flatMap((message: any) => [message, ...message.content]),
    body,
  ].flatMap((target: any) =>
    target.cache_control ? [target.cache_control] : [],
  )
}

describe('OpenCode host tool cache markers', () => {
  for (const mode of ['explicit', 'automatic', 'hybrid'] as const) {
    test(`${mode} respects the breakpoint budget and TTL order`, async () => {
      const output = JSON.parse(
        await rewriteRequestBody(JSON.stringify(source), {
          cache1hEnabled: true,
          cache1hMode: mode,
        }),
      )
      const controls = markers(output)
      expect(controls.length).toBeGreaterThan(0)
      expect(controls.length).toBeLessThanOrEqual(4)
      expect(controls.every((control) => control.ttl === '1h')).toBe(true)
    })

    test(`${mode} leaves the no-tool-marker wire bytes unchanged`, async () => {
      const input = structuredClone(source)
      delete (input.tools[1] as { cache_control?: unknown }).cache_control
      // These wire snapshots were captured before tool marker normalization.
      expect(
        await rewriteRequestBody(JSON.stringify(input), {
          cache1hEnabled: true,
          cache1hMode: mode,
        }),
      ).toMatchSnapshot()
    })
  }

  test('explicit keeps at most four markers even when the host overmarks tools', async () => {
    const input = {
      ...source,
      tools: Array.from({ length: 5 }, (_, index) => ({
        name: `tool${index}`,
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral' },
      })),
    }
    const output = JSON.parse(
      await rewriteRequestBody(JSON.stringify(input), {
        cache1hEnabled: true,
        cache1hMode: 'explicit',
      }),
    )
    expect(markers(output)).toHaveLength(4)
    expect(markers(output).every((control) => control.ttl === '1h')).toBe(true)
    expect(output.messages.at(-1).content[0].cache_control.ttl).toBe('1h')
  })

  test('disabled cache preserves the host default-TTL tool marker', async () => {
    const output = JSON.parse(await rewriteRequestBody(JSON.stringify(source)))
    expect(output.tools[1].cache_control).toEqual({ type: 'ephemeral' })
  })
})
