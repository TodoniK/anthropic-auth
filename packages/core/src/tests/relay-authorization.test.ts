import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type RelayConfig, sendViaRelay } from '../relay.ts'

const body = (suffix: string) =>
  JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: 'x'.repeat(8000) + suffix }],
  })
/** A model request asking for a streamed response, needed for an optimistic relay response. */
const streamingBody = (suffix: string) =>
  JSON.stringify({
    model: 'test-model',
    stream: true,
    messages: [{ role: 'user', content: 'x'.repeat(8000) + suffix }],
  })
const config = (
  url: string,
  transport: 'http' | 'websocket' = 'http',
): RelayConfig => ({
  enabled: true,
  url,
  transport,
  token: 'test-relay-secret',
  fallbackToDirect: true,
})

test('HTTP patch recovery reauthorizes and binds status to the final upstream attempt', async () => {
  const sent: Array<{
    mode: string
    upstream: { headers: Record<string, string> }
  }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const payload = (await request.json()) as {
        mode: string
        upstream: { headers: Record<string, string> }
      }
      sent.push(payload)
      if (sent.length === 2) return new Response('', { status: 409 })
      return new Response('response', {
        status: sent.length === 1 ? 200 : 401,
        headers: { 'request-id': 'req_test' },
      })
    },
  })
  let authorizations = 0,
    fallbacks = 0
  const observed: number[][] = []
  const affinity = randomUUID()
  const send = (text: string) =>
    sendViaRelay({
      config: config(server.url.href),
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers: new Headers(),
      body: body(text),
      affinity,
      fallback: async () => {
        fallbacks++
        return new Response('unexpected direct')
      },
      authorizeAttempt: async () => {
        const attempt = ++authorizations
        return {
          headers: new Headers({ authorization: `Bearer test-${attempt}` }),
          onUpstreamStatus: (status) => {
            observed.push([attempt, status])
          },
        }
      },
    })
  try {
    await (await send('first')).text()
    const response = await send('second')
    expect(response.status).toBe(401)
    await response.text()
    expect(sent.map((entry) => entry.mode)).toEqual([
      'full_sync',
      'patch',
      'full_sync',
    ])
    expect(sent.map((entry) => entry.upstream.headers.authorization)).toEqual([
      'Bearer test-1',
      'Bearer test-2',
      'Bearer test-3',
    ])
    expect(observed).toEqual([
      [1, 200],
      [3, 401],
    ])
    expect(fallbacks).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test('revocation before a retry cannot fall through to HTTP or direct dispatch', async () => {
  let posts = 0,
    gets = 0,
    fallbacks = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('', { status: ++posts === 1 ? 200 : 409 }),
  })
  const affinity = randomUUID()
  const send = (text: string) =>
    sendViaRelay({
      config: config(server.url.href),
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers: new Headers(),
      body: body(text),
      affinity,
      fallback: async () => {
        fallbacks++
        return new Response('unauthorized fallback')
      },
      authorizeAttempt: async () => {
        if (++gets === 3) throw new Error('enrollment revoked')
        return {
          headers: new Headers({ authorization: `Bearer test-${gets}` }),
        }
      },
    })
  try {
    await (await send('first')).text()
    await expect(send('second')).rejects.toThrow('enrollment revoked')
    expect(posts).toBe(2)
    expect(gets).toBe(3)
    expect(fallbacks).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test('a relay transport 401 without upstream provenance falls back direct without blaming OAuth', async () => {
  let observed = 0
  let direct = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('wrong relay secret', { status: 401 }),
  })
  try {
    const response = await sendViaRelay({
      config: config(server.url.href),
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers: new Headers(),
      body: body('first'),
      affinity: randomUUID(),
      fallback: async () => {
        direct++
        return new Response('direct-ok', { status: 200 })
      },
      authorizeAttempt: async () => ({
        headers: new Headers({ authorization: 'Bearer test-access' }),
        onUpstreamStatus: () => {
          observed++
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('direct-ok')
    expect(direct).toBe(1)
    expect(observed).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test('optimistic WebSocket reconnect uses a fresh receipt without reporting its synthetic 200', async () => {
  const sent: Array<{
    id: string
    upstream: { headers: Record<string, string> }
  }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request)
        ? undefined
        : new Response('unexpected HTTP', { status: 500 }),
    websocket: {
      open: (socket) => {
        socket.send(JSON.stringify({ type: 'ready', protocol: 2, state: null }))
      },
      message: (socket, data) => {
        const payload = JSON.parse(String(data)) as {
          id: string
          upstream: { headers: Record<string, string> }
        }
        sent.push(payload)
        if (sent.length === 1) {
          socket.close(1011, 'interrupted before upstream')
          return
        }
        socket.send(
          JSON.stringify({
            type: 'response_start',
            id: payload.id,
            status: 401,
            headers: { 'content-type': 'text/event-stream' },
          }),
        )
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    },
  })
  let gets = 0,
    fallbacks = 0
  const observed: number[][] = []
  try {
    const response = await sendViaRelay({
      config: config(server.url.href, 'websocket'),
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers: new Headers(),
      body: streamingBody('first'),
      affinity: randomUUID(),
      optimisticResponse: true,
      fallback: async () => {
        fallbacks++
        throw new Error('unexpected direct fallback')
      },
      authorizeAttempt: async () => {
        const attempt = ++gets
        return {
          headers: new Headers({ authorization: `Bearer test-${attempt}` }),
          onUpstreamStatus: (status) => {
            observed.push([attempt, status])
          },
        }
      },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe('true')
    expect(await response.text()).toContain('Relay upstream returned HTTP 401')
    expect(sent.map((entry) => entry.upstream.headers.authorization)).toEqual([
      'Bearer test-1',
      'Bearer test-2',
    ])
    expect(observed).toEqual([[2, 401]])
    expect(fallbacks).toBe(0)
  } finally {
    // Bun closes the upgraded socket but its stop() promise remains pending
    // for an idle persistent relay session; don't hold the test on that waiter.
    server.stop(true)
  }
})

test('a relay-only transport 401 without upstream provenance is not surfaced as an account 401', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('wrong relay secret', { status: 401 }),
  })
  let direct = 0,
    observed = 0
  try {
    const response = await sendViaRelay({
      config: { ...config(server.url.href), fallbackToDirect: false },
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers: new Headers(),
      body: body('relay-only'),
      affinity: randomUUID(),
      fallback: async () => {
        direct++
        return new Response('unexpected')
      },
      authorizeAttempt: async () => ({
        headers: new Headers({ authorization: 'Bearer valid-account' }),
        onUpstreamStatus: () => {
          observed++
        },
      }),
    })
    expect(response.status).toBe(502)
    expect((await response.text()).toLowerCase()).toContain('relay')
    expect(direct).toBe(0)
    expect(observed).toBe(0)
  } finally {
    await server.stop(true)
  }
})
