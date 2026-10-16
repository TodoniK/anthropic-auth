import { describe, expect, test } from 'bun:test'
import {
  createStrippedStream,
  rewriteRequestBody,
  stripToolPrefix,
  type ToolNameMap,
} from '../transform'

async function prepare(
  names: readonly string[],
  sessionId = 'tool-mapping-test',
) {
  let toolNameMap: ToolNameMap | undefined
  const body = await rewriteRequestBody(
    JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      stream: true,
      tools: names.map((name) => ({
        name,
        description: `Use ${name}`,
        input_schema: { type: 'object', properties: {} },
      })),
      tool_choice: { type: 'tool', name: names[0] },
      messages: [{ role: 'user', content: 'Use the requested tool.' }],
    }),
    {
      sessionId,
      onToolNameMap: (map) => {
        toolNameMap = map
      },
    },
  )
  return { body: JSON.parse(body), toolNameMap }
}

function streamOf(names: string[], chunkSize: number) {
  const frames = names
    .map((name, index) => {
      const data = {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: `toolu_${index}`,
          name,
          input: {},
        },
      }
      return `event: content_block_start\ndata: ${JSON.stringify(data)}\n\n`
    })
    .join('')
  const bytes = new TextEncoder().encode(frames)
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          controller.enqueue(bytes.slice(offset, offset + chunkSize))
        }
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

async function restore(
  request: Awaited<ReturnType<typeof prepare>>,
  names: string[],
  chunkSize = 7,
) {
  const text = await createStrippedStream(streamOf(names, chunkSize), {
    toolNameMap: request.toolNameMap,
  }).text()
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)).content_block.name as string)
}

describe('request-bound response tool names', () => {
  test('exact host and wire names beat competing namespace suffixes', async () => {
    const names = ['search', 'move', 'delete', 'import']
    const request = await prepare([
      ...names,
      ...names.map((name) => `aft_${name}`),
      'ctx_search',
      'ast_grep_search',
    ])
    expect(
      request.body.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      'mcp_Search',
      'mcp_Move',
      'mcp_Delete',
      'mcp_Import',
      'mcp_Aft_search',
      'mcp_Aft_move',
      'mcp_Aft_delete',
      'mcp_Aft_import',
      'mcp_Ctx_search',
      'mcp_Ast_grep_search',
    ])
    expect(request.body.tool_choice).toEqual({
      type: 'tool',
      name: 'mcp_Search',
    })
    expect(
      await restore(request, [
        'mcp_Search',
        'search',
        'mcp_Move',
        'move',
        'mcp_Delete',
        'delete',
        'mcp_Import',
        'import',
        'mcp_Aft_search',
        'aft_search',
        'mcp_Ctx_search',
        'mcp_Ast_grep_search',
      ]),
    ).toEqual([
      'search',
      'search',
      'move',
      'move',
      'delete',
      'delete',
      'import',
      'import',
      'aft_search',
      'aft_search',
      'ctx_search',
      'ast_grep_search',
    ])
  })

  test.each(['aft_search', 'ctx_search', 'ast_grep_search'])(
    'recovers a unique short name only from declared %s',
    async (name) => {
      const request = await prepare([name])
      expect(
        await restore(request, ['mcp_Search', 'search', 'Search']),
      ).toEqual([name, name, name])
    },
  )

  test.each([
    { tools: ['aft_search', 'ctx_search'] },
    { tools: ['aft_search', 'ast_grep_search'] },
    { tools: ['ctx_search', 'ast_grep_search'] },
    { tools: ['aft_search', 'ctx_search', 'ast_grep_search'] },
  ])('leaves ambiguous short names unresolved for %j', async ({ tools }) => {
    const request = await prepare(tools)
    expect(await restore(request, ['mcp_Search', 'search', 'Search'])).toEqual([
      'mcp_Search',
      'search',
      'Search',
    ])
  })

  test('does not map absent tools, historical tools or a missing request binding', async () => {
    const request = await prepare(['bash'])
    const unknown = [
      'search',
      'mcp_Search',
      'mcp_Aft_search',
      'aft_search',
      'mcp_Move',
    ]
    expect(await restore(request, unknown)).toEqual(unknown)
    const historyOnly = await rewriteRequestBody(
      JSON.stringify({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'old', name: 'aft_search', input: {} },
            ],
          },
          { role: 'user', content: 'Continue.' },
        ],
      }),
      {
        onToolNameMap: (map) => {
          request.toolNameMap = map
        },
      },
    )
    expect(JSON.parse(historyOnly).messages[0].content[0].name).toBe(
      'mcp_Aft_search',
    )
    expect(await restore(request, unknown)).toEqual(unknown)
    expect(stripToolPrefix('{"name":"mcp_Bash"}')).toBe('{"name":"mcp_Bash"}')
  })

  test('preserves exact case, already-prefixed names and forced tool-choice round trips', async () => {
    const names = ['ReadFile', 'StructuredOutput', 'mcp_search', 'aft_search']
    const request = await prepare(names)
    expect(
      request.body.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      'mcp_ReadFile',
      'mcp_StructuredOutput',
      'mcp_Mcp_search',
      'mcp_Aft_search',
    ])
    expect(request.body.tool_choice).toEqual({
      type: 'tool',
      name: 'mcp_ReadFile',
    })
    expect(
      await restore(request, [
        'mcp_ReadFile',
        'ReadFile',
        'readFile',
        'mcp_StructuredOutput',
        'mcp_Mcp_search',
        'mcp_search',
        'mcp_Aft_search',
      ]),
    ).toEqual([
      'ReadFile',
      'ReadFile',
      'ReadFile',
      'StructuredOutput',
      'mcp_search',
      'mcp_search',
      'aft_search',
    ])
  })

  test('does not redirect a real host name that is also another tools wire name', async () => {
    const request = await prepare(['search', 'mcp_Search', 'aft_search'])
    expect(
      await restore(request, ['mcp_Search', 'mcp_Mcp_Search', 'search']),
    ).toEqual(['mcp_Search', 'mcp_Search', 'search'])
  })

  test('leaves a colliding capitalized wire name unresolved without losing exact host names', async () => {
    const request = await prepare(['search', 'Search'])
    expect(
      await restore(request, ['mcp_Search', 'mcp_search', 'search', 'Search']),
    ).toEqual(['mcp_Search', 'mcp_search', 'search', 'Search'])
  })

  test('isolates concurrent requests within a session and across sessions', async () => {
    const requests = await Promise.all([
      prepare(['aft_search'], 'same-session'),
      prepare(['ctx_search'], 'same-session'),
      prepare(['ast_grep_search'], 'other-session'),
      prepare(['bash'], 'other-session'),
    ])
    expect(
      await Promise.all(
        requests.map((request) => restore(request, ['mcp_Search'])),
      ),
    ).toEqual([
      ['aft_search'],
      ['ctx_search'],
      ['ast_grep_search'],
      ['mcp_Search'],
    ])
  })

  test('handles every byte split in names and preserves JSON response mapping', async () => {
    const request = await prepare(['aft_search', 'read'])
    expect(
      await restore(request, ['mcp_Search', 'mcp_Read', 'read'], 1),
    ).toEqual(['aft_search', 'read', 'read'])
    const response = createStrippedStream(
      Response.json({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_json',
            name: 'mcp_Aft_search',
            input: {},
          },
        ],
      }),
      { toolNameMap: request.toolNameMap, responseMode: 'json' },
    )
    expect(await response.json()).toEqual({
      content: [
        { type: 'tool_use', id: 'toolu_json', name: 'aft_search', input: {} },
      ],
    })
  })
})
