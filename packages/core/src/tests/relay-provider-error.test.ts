import { expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import {
  createProviderErrorRedactor,
  PROVIDER_ERROR_REDACTION,
} from '../provider-error.ts'
import {
  type RelayAttemptAuthorization,
  type RelayConfig,
  sendViaRelay,
} from '../relay.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, gate, trackDetached, deferCleanup } = createTestLifetimeSuite()

// Opaque credentials: none of them has a shape (Bearer prefix, sk- key, JWT)
// that the redactor's generic patterns would catch, so only exact
// per-attempt matching can remove them from echoed provider errors.
const RELAY_TOKEN = 'opaqueRelayTransportToken0123456789'
const V0 = 'opaqueAttemptCredentialV0yzabcdefghij'
const V1 = 'opaqueAttemptCredentialV1abcdefghijkl'
const V2 = 'opaqueAttemptCredentialV2mnopqrstuvwx'
const sessionOf = (token: string) => `opaqueSessionBinding${token.slice(-12)}`

const encoder = new TextEncoder()

type SentPayload = {
  id?: string
  mode: string
  body?: string
  upstream: { headers: Record<string, string> }
}

function readPayload(text: string): SentPayload {
  return JSON.parse(text) as SentPayload
}

function config(url: string, transport: 'http' | 'websocket'): RelayConfig {
  return {
    enabled: true,
    url,
    token: RELAY_TOKEN,
    fallbackToDirect: false,
    transport,
  }
}

const requestBody = (suffix: string) =>
  JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: `${'x'.repeat(2000)}${suffix}` }],
  })
/** A model request asking for a streamed (event-stream) response. */
const streamingBody = (suffix: string) =>
  JSON.stringify({
    model: 'test-model',
    stream: true,
    messages: [{ role: 'user', content: `${'x'.repeat(2000)}${suffix}` }],
  })

type WsScript = (
  socket: ServerWebSocket<undefined>,
  payload: SentPayload,
  index: number,
) => void
type HttpScript = (
  payload: SentPayload,
  index: number,
) => Response | Promise<Response>

/**
 * Loopback relay owned by the calling test body. Its shutdown waits on a
 * gate created inside the body before the body awaits any relay I/O. Test
 * teardown opens every such gate, so if the body hangs on the relay, the
 * shutdown closes the relay's sockets and the hung read in the body settles.
 * Each socket's close callback is awaited individually.
 */
function startRelay(script: { ws?: WsScript; http?: HttpScript }) {
  const sent: SentPayload[] = []
  const sockets = new Map<ServerWebSocket<undefined>, Promise<void>>()
  const closers = new Map<ServerWebSocket<undefined>, () => void>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request, owner) => {
      if (request.headers.get('upgrade') === 'websocket')
        return owner.upgrade(request)
          ? undefined
          : new Response('upgrade failed', { status: 500 })
      const payload = readPayload(await request.text())
      sent.push(payload)
      if (!script.http)
        return new Response('unexpected HTTP relay', { status: 500 })
      return script.http(payload, sent.length - 1)
    },
    websocket: {
      open(socket) {
        sockets.set(
          socket,
          new Promise<void>((resolve) => closers.set(socket, resolve)),
        )
        socket.send(JSON.stringify({ type: 'ready', protocol: 2, state: null }))
      },
      message(socket, data) {
        const payload = readPayload(String(data))
        sent.push(payload)
        script.ws?.(socket, payload, sent.length - 1)
      },
      close(socket) {
        closers.get(socket)?.()
      },
    },
  })
  let stopping: Promise<void> | undefined
  const stop = () => {
    stopping ??= (async () => {
      // A forced stop closes every relay socket; each socket's close callback
      // is joined separately. The stop promise itself is not joined: Bun can
      // leave it pending after upgraded sockets close (see the same note in
      // relay-authorization.test.ts), so shutdown is joined through every
      // socket's close callback.
      const closes = [...sockets.values()]
      void server.stop(true)
      const results = await Promise.allSettled(closes)
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (failures.length)
        throw new AggregateError(failures, 'Loopback relay shutdown failed')
    })()
    return stopping
  }
  const shutdown = gate()
  trackDetached(shutdown.wait.then(stop))
  return { url: server.url.href, sent }
}

function sseFrame(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } }
}

/** Send bytes alternately as binary frames and base64 `chunk` messages. */
function sendChunks(
  socket: ServerWebSocket<undefined>,
  id: string | undefined,
  pieces: Uint8Array[],
) {
  pieces.forEach((piece, index) => {
    if (index % 2 === 0) socket.send(piece)
    else
      socket.send(
        JSON.stringify({
          type: 'chunk',
          id,
          base64: Buffer.from(piece).toString('base64'),
        }),
      )
  })
}

function splitAt(bytes: Uint8Array, offsets: number[]) {
  const pieces: Uint8Array[] = []
  let start = 0
  for (const offset of [...offsets, bytes.byteLength]) {
    pieces.push(bytes.slice(start, offset))
    start = offset
  }
  return pieces
}

function startResponse(
  socket: ServerWebSocket<undefined>,
  id: string | undefined,
  status: number,
  headers: Record<string, string>,
) {
  socket.send(JSON.stringify({ type: 'response_start', id, status, headers }))
}

function authorizer(tokens: string[], withErrorSecrets: boolean) {
  const observed: Array<[number, number]> = []
  let calls = 0
  const authorize = async (): Promise<RelayAttemptAuthorization> => {
    const attempt = ++calls
    const token = tokens[attempt - 1]
    if (token === undefined) throw new Error('Unexpected relay authorization')
    return {
      headers: new Headers({
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      }),
      ...(withErrorSecrets ? { errorSecrets: [token, sessionOf(token)] } : {}),
      onUpstreamStatus: (status) => {
        observed.push([attempt, status])
      },
    }
  }
  return { authorize, observed, calls: () => calls }
}

async function send(options: {
  relay: { url: string }
  transport: 'http' | 'websocket'
  authorize: () => Promise<RelayAttemptAuthorization>
  optimistic?: boolean
  affinity?: string
  suffix?: string
  body?: string
  onResponseHeaders?: (headers: Headers) => void
}) {
  return sendViaRelay({
    config: config(options.relay.url, options.transport),
    input: 'https://api.anthropic.com/v1/messages',
    init: { method: 'POST' },
    headers: new Headers(),
    body: options.body ?? requestBody(options.suffix ?? 'first'),
    affinity: options.affinity ?? randomUUID(),
    optimisticResponse: options.optimistic === true,
    fallback: async () => {
      throw new Error('Unexpected direct fallback')
    },
    authorizeAttempt: options.authorize,
    onResponseHeaders: options.onResponseHeaders,
  })
}

/**
 * Precondition for optimistic tests: the relay really answered with its
 * synthetic event stream rather than waiting for the upstream response.
 */
function expectOptimistic(response: Response) {
  expect(response.status).toBe(200)
  expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe('true')
}

const REQUEST_ID_V2 = 'req_relay_reconnected'
const successPrefix = sseFrame('message_start', {
  type: 'message_start',
  message: { id: 'msg_relay', content: [] },
})
const echoFor = (token: string) =>
  anthropicError(
    'authentication_error',
    `invalid credential ${token} via relay ${RELAY_TOKEN}`,
  )
const scrubbedEcho = anthropicError(
  'authentication_error',
  `invalid credential ${PROVIDER_ERROR_REDACTION} via relay ${PROVIDER_ERROR_REDACTION}`,
)

for (const [name, tokens, withErrorSecrets] of [
  ['v1 then v2 from errorSecrets', [V1, V2], true],
  ['v1 then v1 from the protocol header', [V1, V1], false],
] as const) {
  test(`optimistic WebSocket reconnect scrubs the terminal error with the credential the retry sent (${name})`, async () => {
    const reconnected = tokens[1]
    const errorFrame = sseFrame('error', echoFor(reconnected))
    const relay = startRelay({
      ws: (socket, payload, index) => {
        // The first physical attempt dies before any upstream byte.
        if (index === 0) return socket.close(1011, 'interrupted')
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
          'request-id': REQUEST_ID_V2,
        })
        const bytes = encoder.encode(successPrefix + errorFrame)
        // Cut inside the echoed credential, once as a binary frame and once
        // as a base64 chunk, so the scope must join both chunk kinds.
        const cut = successPrefix.length + errorFrame.indexOf(reconnected) + 7
        sendChunks(socket, payload.id, splitAt(bytes, [9, cut]))
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([...tokens], withErrorSecrets)
    const harvested: Array<string | null> = []
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic: true,
      body: streamingBody('first'),
      authorize: auth.authorize,
      onResponseHeaders: (headers) => harvested.push(headers.get('request-id')),
    })
    expectOptimistic(response)
    const text = await response.text()

    expect(text).toBe(successPrefix + sseFrame('error', scrubbedEcho))
    expect(text).not.toContain(V1)
    expect(text).not.toContain(V2)
    expect(text).not.toContain(RELAY_TOKEN)
    expect(
      relay.sent.map((payload) => payload.upstream.headers.authorization),
    ).toEqual(tokens.map((token) => `Bearer ${token}`))
    expect(auth.calls()).toBe(2)
    expect(auth.observed).toEqual([[2, 200]])
    expect(harvested).toEqual([REQUEST_ID_V2])
    // A host-side redactor snapshotted with the first credential cannot
    // recognize what the reconnect sent.
    const hostSnapshot = createProviderErrorRedactor([tokens[0], RELAY_TOKEN])
    const snapshotView = hostSnapshot.redactText(errorFrame)
    hostSnapshot.dispose()
    if (tokens[0] === tokens[1]) expect(snapshotView).not.toContain(V1)
    else expect(snapshotView).toContain(V2)
  })
}

for (const optimistic of [true, false]) {
  test(`successful WebSocket stream bytes pass through exactly (optimistic=${optimistic})`, async () => {
    const upstream = encoder.encode(
      successPrefix +
        sseFrame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: `an error about ${V1} in ünïcødé text`,
          },
        }) +
        `: heartbeat mentioning error ${V1}\r\n\r\n` +
        sseFrame('message_stop', { type: 'message_stop' }) +
        // Unterminated tail: only an end-of-stream flush delivers it.
        `event: ping\ndata: {"type":"ping"}`,
    )
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
        })
        const multibyte = Buffer.from(upstream).indexOf('ü') + 1
        sendChunks(
          socket,
          payload.id,
          splitAt(upstream, [3, 40, multibyte, multibyte + 30, multibyte + 90]),
        )
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic,
      body: streamingBody('first'),
      authorize: auth.authorize,
    })
    if (optimistic) expectOptimistic(response)
    expect(response.status).toBe(200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(Buffer.from(bytes).equals(Buffer.from(upstream))).toBe(true)
    expect(auth.observed).toEqual([[1, 200]])
  })
}

test('HTTP patch recovery scrubs the final response with exactly the reauthorized credential', async () => {
  const relay = startRelay({
    http: (payload, index) => {
      if (index === 0)
        return new Response('ok', {
          headers: { 'request-id': 'req_first', 'content-type': 'text/plain' },
        })
      if (index === 1)
        return new Response(`state mismatch for ${V1}`, { status: 409 })
      return Response.json(
        anthropicError(
          'authentication_error',
          `rejected ${V2} session ${sessionOf(V2)} relay ${RELAY_TOKEN} earlier ${V1}`,
        ),
        {
          status: 401,
          headers: { 'request-id': 'req_final', 'x-echo': `credential ${V2}` },
        },
      )
    },
  })
  const auth = authorizer([V0, V1, V2], true)
  const harvested: Array<string | null> = []
  const affinity = randomUUID()
  const sendHttp = (suffix: string) =>
    send({
      relay,
      transport: 'http',
      affinity,
      suffix,
      authorize: auth.authorize,
      onResponseHeaders: (headers) => harvested.push(headers.get('request-id')),
    })
  expect(await (await sendHttp('first')).text()).toBe('ok')
  const response = await sendHttp('second')
  expect(response.status).toBe(401)
  expect(response.headers.get('request-id')).toBe('req_final')
  expect(response.headers.get('x-echo')).toBe(
    `credential ${PROVIDER_ERROR_REDACTION}`,
  )
  // The final attempt sent only V2 (plus its session binding and the relay
  // token). V1 belonged to the abandoned patch attempt, so the final
  // attempt's scope does not know it: there is no cache of earlier
  // credentials, only the exact physical attempt.
  expect(await response.text()).toBe(
    JSON.stringify(
      anthropicError(
        'authentication_error',
        `rejected ${PROVIDER_ERROR_REDACTION} session ${PROVIDER_ERROR_REDACTION} relay ${PROVIDER_ERROR_REDACTION} earlier ${V1}`,
      ),
    ),
  )
  expect(relay.sent.map((payload) => payload.mode)).toEqual([
    'full_sync',
    'patch',
    'full_sync',
  ])
  expect(
    relay.sent.map((payload) => payload.upstream.headers.authorization),
  ).toEqual([`Bearer ${V0}`, `Bearer ${V1}`, `Bearer ${V2}`])
  expect(auth.observed).toEqual([
    [1, 200],
    [3, 401],
  ])
  expect(harvested).toEqual(['req_first', 'req_final'])
})

test('a successful non-stream HTTP relay body is passed through untouched', async () => {
  const body = `{"id":"msg_ok","content":[{"type":"text","text":"error ${V1}"}]}`
  const relay = startRelay({
    http: () =>
      new Response(body, {
        headers: { 'content-type': 'application/json', 'request-id': 'req_ok' },
      }),
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'http',
    authorize: auth.authorize,
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('request-id')).toBe('req_ok')
  expect(await response.text()).toBe(body)
})

test('non-optimistic WebSocket error responses are scrubbed with the live attempt', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 401, {
        'content-type': 'application/json',
        'request-id': 'req_ws_401',
        'x-echo': `credential ${V1}`,
      })
      const bytes = encoder.encode(JSON.stringify(echoFor(V1)))
      sendChunks(socket, payload.id, splitAt(bytes, [30]))
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    authorize: auth.authorize,
  })
  expect(response.status).toBe(401)
  expect(response.headers.get('request-id')).toBe('req_ws_401')
  expect(response.headers.get('x-echo')).toBe(
    `credential ${PROVIDER_ERROR_REDACTION}`,
  )
  expect(await response.text()).toBe(JSON.stringify(scrubbedEcho))
  expect(auth.observed).toEqual([[1, 401]])
})

test('a relay control error before upstream bytes errors the stream with a scrubbed reason', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      socket.send(
        JSON.stringify({
          type: 'error',
          id: payload.id,
          status: 500,
          message: `upstream rejected ${V1} via ${RELAY_TOKEN}`,
        }),
      )
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expectOptimistic(response)
  const failure = await response.text().then(
    () => new Error('Stream unexpectedly succeeded'),
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(failure instanceof Error ? failure.message : '').toBe(
    `relay websocket error 500: upstream rejected ${PROVIDER_ERROR_REDACTION} via ${PROVIDER_ERROR_REDACTION}`,
  )
})

test('a relay control error while an optimistic stream is open is delivered as a scrubbed SSE error', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 200, {
        'content-type': 'text/event-stream',
      })
      sendChunks(socket, payload.id, [encoder.encode(successPrefix)])
      socket.send(
        JSON.stringify({
          type: 'error',
          id: payload.id,
          status: 500,
          message: `stream failed for ${V1}`,
        }),
      )
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expectOptimistic(response)
  expect(await response.text()).toBe(
    successPrefix +
      sseFrame(
        'error',
        anthropicError(
          'relay_error',
          `stream failed for ${PROVIDER_ERROR_REDACTION}`,
        ),
      ),
  )
})

const relayPath = new URL('../relay.ts', import.meta.url).href
const dumpPath = new URL('../dump.ts', import.meta.url).href

/** Run a script against the real relay logger in a child process. */
async function loggedChild(script: string) {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-relay-redaction-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const log = join(root, 'relay.log')
  const child = Bun.spawn([process.execPath, '-e', script], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TMPDIR: root,
      OPENCODE_ANTHROPIC_AUTH_LOG_FILE: log,
      OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL: 'debug',
      OPENCODE_ANTHROPIC_AUTH_DUMP_DIR: join(root, 'dumps'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let exited = false
  const cancellation = gate()
  trackDetached(
    cancellation.wait.then(() => {
      if (!exited) child.kill()
    }),
  )
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  try {
    const [exit, out, err] = await Promise.allSettled([
      child.exited,
      stdout,
      stderr,
    ])
    exited = true
    if (
      exit.status !== 'fulfilled' ||
      out.status !== 'fulfilled' ||
      err.status !== 'fulfilled'
    )
      throw new AggregateError(
        [exit, out, err].flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        ),
        'Relay log fixture drainage failed',
      )
    expect(err.value).toBe('')
    expect(exit.value).toBe(0)
    return { stdout: out.value, log: await readFile(log, 'utf8') }
  } finally {
    cancellation.open()
  }
}

test('real WebSocket state-mismatch and done logs keep only fixed metadata', async () => {
  const result = await loggedChild(`
    import { sendViaRelay } from ${JSON.stringify(relayPath)}
    import { setDumpEnabled } from ${JSON.stringify(dumpPath)}
    setDumpEnabled(false)
    const token = ${JSON.stringify(V1)}, relayToken = ${JSON.stringify(RELAY_TOKEN)}
    let messages = 0
    const sockets = new Set()
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, owner) => owner.upgrade(request) ? undefined : new Response('unexpected HTTP', { status: 500 }),
      websocket: {
        open(socket) { sockets.add(socket); socket.send(JSON.stringify({ type: 'ready', protocol: 2, state: null })) },
        message(socket, data) {
          const payload = JSON.parse(String(data))
          if (++messages === 1) {
            socket.send(JSON.stringify({ type: 'error', id: payload.id, status: 409, message: 'state mismatch ' + token + ' relay ' + relayToken }))
            return
          }
          socket.send(JSON.stringify({ type: 'response_start', id: payload.id, status: 200, headers: { 'content-type': 'text/event-stream' } }))
          socket.send(JSON.stringify({ type: 'done', id: payload.id, upstreamChunks: 'chunks ' + token, upstreamBytes: 0, frames: 'frames ' + relayToken, frameBytes: 0 }))
        },
        close(socket) { sockets.delete(socket) },
      },
    })
    try {
      const response = await sendViaRelay({ config: { enabled: true, url: server.url.href, token: relayToken, transport: 'websocket', fallbackToDirect: false }, input: 'https://api.anthropic.com/v1/messages', init: { method: 'POST' }, headers: new Headers({ authorization: 'Bearer ' + token }), body: JSON.stringify({ messages: [] }), affinity: 'synthetic-log-control', fallback: async () => { throw new Error('Unexpected fallback') } })
      if (messages !== 2 || response.status !== 200 || (await response.text()) !== '') throw new Error('Relay did not retry the state mismatch')
    } finally {
      for (const socket of sockets) socket.close()
      server.stop(true)
    }
    console.log('PHYSICAL_RELAY_ATTEMPTS=2; EXTERNAL_HTTP=0')
  `)
  expect(result.stdout).toContain('PHYSICAL_RELAY_ATTEMPTS=2; EXTERNAL_HTTP=0')
  expect(result.log).toContain(
    'websocket state mismatch; reconnecting and retrying full_sync session=synthetic-lo',
  )
  expect(result.log).toContain('perf websocket done session=synthetic-lo')
  expect(result.log).toContain('upstreamChunks=unknown')
  expect(result.log).not.toContain(V1)
  expect(result.log).not.toContain(RELAY_TOKEN)
})

/**
 * Collect garbage until every tracked object is gone or the rounds run out.
 * Each round yields a macrotask first, so objects kept alive for the
 * current job by `WeakRef.deref` are released before the collection.
 */
async function collected(refs: WeakRef<object>[]) {
  for (let round = 0; round < 20; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    Bun.gc(true)
    if (refs.every((ref) => ref.deref() === undefined)) return true
  }
  return false
}

for (const ending of ['done', 'cancel', 'error'] as const) {
  test(`a WebSocket attempt releases its authorization at ${ending} while the host still holds the response`, async () => {
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
        })
        sendChunks(socket, payload.id, [encoder.encode(successPrefix)])
        if (ending === 'done')
          socket.send(JSON.stringify({ type: 'done', id: payload.id }))
        if (ending === 'error')
          socket.send(
            JSON.stringify({
              type: 'error',
              id: payload.id,
              status: 500,
              message: `failed for ${V1}`,
            }),
          )
      },
    })
    const refs: WeakRef<object>[] = []
    const response = await send({
      relay,
      transport: 'websocket',
      authorize: async () => {
        const authorization: RelayAttemptAuthorization = {
          headers: new Headers({ authorization: `Bearer ${V1}` }),
          errorSecrets: [V1],
        }
        refs.push(new WeakRef(authorization))
        return authorization
      },
    })
    const body = response.body
    if (!body) throw new Error('Relay response has no body')
    const reader = body.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    if (ending === 'cancel') await reader.cancel()
    else {
      const rest = await reader.read().then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      )
      if (ending === 'done') expect(rest.result?.done).toBe(true)
      else
        expect(rest.error instanceof Error ? rest.error.message : '').toBe(
          `relay websocket error 500: failed for ${PROVIDER_ERROR_REDACTION}`,
        )
    }
    expect(refs).toHaveLength(1)
    expect(await collected(refs)).toBe(true)
    // The host still holds the response and its reader here.
    expect(response.bodyUsed).toBe(true)
    reader.releaseLock()
  })
}

test('cancelling an optimistic stream before upstream bytes spends no further authorization', async () => {
  const relay = startRelay({
    ws: (socket, payload, index) => {
      // The first physical attempt is held open so the host cancels it
      // before any upstream byte; every later payload completes at once.
      if (index === 0) return
      startResponse(socket, payload.id, 200, {
        'content-type': 'text/event-stream',
      })
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1, V2, V0], true)
  const affinity = randomUUID()
  const cancelled = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    affinity,
    body: streamingBody('cancelled-first'),
    authorize: auth.authorize,
  })
  expectOptimistic(cancelled)
  await cancelled.body?.cancel()
  // Both requests use the same affinity, so the relay session queues this
  // one behind the cancelled request; it starts only after that one ended.
  const next = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    affinity,
    body: streamingBody('second'),
    authorize: auth.authorize,
  })
  expectOptimistic(next)
  expect(await next.text()).toBe('')
  expect(
    relay.sent.map((payload) => payload.body?.endsWith('second"}]}')),
  ).toEqual([false, true])
  expect(
    relay.sent.map((payload) => payload.upstream.headers.authorization),
  ).toEqual([`Bearer ${V1}`, `Bearer ${V2}`])
  expect(auth.calls()).toBe(2)
})

const echoedStream = (token: string) =>
  successPrefix + sseFrame('error', echoFor(token))
const scrubbedStream = successPrefix + sseFrame('error', scrubbedEcho)

/** Missing content type (bytes body) or an explicit text/plain one. */
function untypedResponse(text: string, mime: 'missing' | 'text/plain') {
  return mime === 'missing'
    ? new Response(encoder.encode(text))
    : new Response(text, { headers: { 'content-type': 'text/plain' } })
}

for (const mime of ['missing', 'text/plain'] as const) {
  test(`a streaming HTTP request is scrubbed as an event stream whatever its content type (${mime})`, async () => {
    const relay = startRelay({
      http: () => untypedResponse(echoedStream(V1), mime),
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'http',
      body: streamingBody('first'),
      authorize: auth.authorize,
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(scrubbedStream)
  })

  test(`successful streaming HTTP bytes stay identical whatever the content type (${mime})`, async () => {
    const upstream =
      successPrefix +
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: `an error about ${V1}` },
      }) +
      sseFrame('message_stop', { type: 'message_stop' })
    const relay = startRelay({ http: () => untypedResponse(upstream, mime) })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'http',
      body: streamingBody('first'),
      authorize: auth.authorize,
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(Buffer.from(bytes).equals(Buffer.from(upstream))).toBe(true)
  })
}

for (const [name, body] of [
  ['no stream field', requestBody('first')],
  ['stream false', JSON.stringify({ stream: false, messages: [] })],
  ['stream as the string "true"', JSON.stringify({ stream: 'true' })],
  ['stream as an array', JSON.stringify({ stream: [true] })],
  ['a JSON array body', JSON.stringify([{ stream: true }])],
  ['a malformed JSON body', '{"stream":true,"messages":['],
] as const) {
  test(`a non-streaming HTTP request (${name}) keeps a successful body untouched`, async () => {
    const relay = startRelay({
      http: () => untypedResponse(echoedStream(V1), 'text/plain'),
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'http',
      body,
      authorize: auth.authorize,
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(echoedStream(V1))
    expect(relay.sent).toHaveLength(1)
  })
}

test('a malformed request body is still relayed once and its error response scrubbed', async () => {
  const relay = startRelay({
    http: () =>
      Response.json(echoFor(V1), {
        status: 401,
        headers: { 'request-id': 'req_malformed' },
      }),
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'http',
    body: '{"stream":true,"messages":[',
    authorize: auth.authorize,
  })
  expect(response.status).toBe(401)
  expect(await response.text()).toBe(JSON.stringify(scrubbedEcho))
  expect(relay.sent).toHaveLength(1)
  expect(auth.observed).toEqual([[1, 401]])
})

test('the request protocol survives the 409 full-sync re-authorization', async () => {
  const relay = startRelay({
    http: (_payload, index) => {
      if (index === 0) return untypedResponse(successPrefix, 'missing')
      if (index === 1) return new Response('', { status: 409 })
      return untypedResponse(echoedStream(V2), 'text/plain')
    },
  })
  const auth = authorizer([V0, V1, V2], true)
  const affinity = randomUUID()
  const sendStreaming = (suffix: string) =>
    send({
      relay,
      transport: 'http',
      affinity,
      body: streamingBody(suffix),
      authorize: auth.authorize,
    })
  expect(await (await sendStreaming('first')).text()).toBe(successPrefix)
  const response = await sendStreaming('second')
  expect(await response.text()).toBe(scrubbedStream)
  expect(relay.sent.map((payload) => payload.mode)).toEqual([
    'full_sync',
    'patch',
    'full_sync',
  ])
  expect(
    relay.sent.map((payload) => payload.upstream.headers.authorization),
  ).toEqual([`Bearer ${V0}`, `Bearer ${V1}`, `Bearer ${V2}`])
})

test('a non-optimistic streaming WebSocket response is scrubbed as an event stream under text/plain', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 200, { 'content-type': 'text/plain' })
      const bytes = encoder.encode(echoedStream(V1))
      sendChunks(socket, payload.id, splitAt(bytes, [20]))
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(scrubbedStream)
})

for (const [extrasName, extras] of [
  ['empty', []],
  ['stale', [V1]],
] as const) {
  test(`the outgoing v2 header is scrubbed even when errorSecrets is ${extrasName} (WebSocket reconnect)`, async () => {
    const relay = startRelay({
      ws: (socket, payload, index) => {
        if (index === 0) return socket.close(1011, 'interrupted')
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
        })
        sendChunks(socket, payload.id, [encoder.encode(echoedStream(V2))])
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    let calls = 0
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic: true,
      body: streamingBody('first'),
      authorize: async () => {
        const token = ++calls === 1 ? V1 : V2
        return {
          headers: new Headers({ authorization: `Bearer ${token}` }),
          errorSecrets: token === V2 ? extras : [token],
        }
      },
    })
    expectOptimistic(response)
    expect(await response.text()).toBe(scrubbedStream)
    expect(
      relay.sent.map((payload) => payload.upstream.headers.authorization),
    ).toEqual([`Bearer ${V1}`, `Bearer ${V2}`])
  })

  test(`the outgoing v2 header is scrubbed even when errorSecrets is ${extrasName} (HTTP)`, async () => {
    const relay = startRelay({
      http: () =>
        Response.json(echoFor(V2), {
          status: 401,
          headers: { 'request-id': 'req_extras', 'x-echo': `Bearer ${V2}` },
        }),
    })
    const response = await send({
      relay,
      transport: 'http',
      authorize: async () => ({
        headers: new Headers({ authorization: `Bearer ${V2}` }),
        errorSecrets: extras,
      }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('x-echo')).toBe(PROVIDER_ERROR_REDACTION)
    expect(await response.text()).toBe(JSON.stringify(scrubbedEcho))
  })
}

test('each HTTP request scrubs only its own attempt credentials and extras', async () => {
  const relay = startRelay({
    http: (_payload, index) =>
      index === 0
        ? new Response('ok')
        : Response.json(
            anthropicError(
              'authentication_error',
              `now ${V2} bound ${sessionOf(V2)} before ${V1} bound ${sessionOf(V1)}`,
            ),
            { status: 401, headers: { 'request-id': 'req_isolated' } },
          ),
  })
  const auth = authorizer([V1, V2], true)
  expect(
    await (
      await send({ relay, transport: 'http', authorize: auth.authorize })
    ).text(),
  ).toBe('ok')
  const response = await send({
    relay,
    transport: 'http',
    authorize: auth.authorize,
  })
  // The second request never sent V1 or its binding, so nothing from the
  // first request's attempt is inherited.
  expect(await response.text()).toBe(
    JSON.stringify(
      anthropicError(
        'authentication_error',
        `now ${PROVIDER_ERROR_REDACTION} bound ${PROVIDER_ERROR_REDACTION} before ${V1} bound ${sessionOf(V1)}`,
      ),
    ),
  )
})

for (const [name, body] of [
  ['no stream field', requestBody('first')],
  ['stream false', JSON.stringify({ stream: false, messages: [] })],
] as const) {
  test(`a non-optimistic non-streaming WebSocket success labelled text/event-stream stays byte-identical (${name})`, async () => {
    const upstream = echoedStream(V1)
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
        })
        sendChunks(socket, payload.id, splitAt(encoder.encode(upstream), [25]))
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'websocket',
      body,
      authorize: auth.authorize,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(Buffer.from(bytes).equals(Buffer.from(upstream))).toBe(true)
  })
}

test('a non-optimistic streaming WebSocket response without a content type is scrubbed as an event stream', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 200, {})
      sendChunks(
        socket,
        payload.id,
        splitAt(encoder.encode(echoedStream(V1)), [40]),
      )
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(scrubbedStream)
})

test('a non-optimistic non-streaming WebSocket error response is still scrubbed', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 401, {
        'content-type': 'text/event-stream',
        'request-id': 'req_ws_http_401',
      })
      sendChunks(socket, payload.id, [
        encoder.encode(JSON.stringify(echoFor(V1))),
      ])
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    authorize: auth.authorize,
  })
  expect(response.status).toBe(401)
  expect(await response.text()).toBe(JSON.stringify(scrubbedEcho))
})

/** Larger than the stream scope's 8 MiB SSE frame bound, with no blank line. */
function largeJsonBody() {
  const text = `an error about ${V1} `
  return JSON.stringify({
    id: 'msg_large',
    type: 'message',
    content: [{ type: 'text', text: text + 'a'.repeat(8.5 * 1024 * 1024) }],
  })
}

for (const [name, body] of [
  ['no stream field', requestBody('first')],
  ['stream false', JSON.stringify({ stream: false, messages: [] })],
] as const) {
  test(`an optimistic caller's non-streaming request waits for the real response (${name}): large JSON stays byte-identical`, async () => {
    const upstream = encoder.encode(largeJsonBody())
    expect(upstream.byteLength).toBeGreaterThan(8 * 1024 * 1024)
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 200, {
          'content-type': 'application/json',
          'request-id': 'req_large',
        })
        const mib = 1024 * 1024
        const offsets: number[] = []
        for (let at = mib; at < upstream.byteLength; at += mib) offsets.push(at)
        sendChunks(socket, payload.id, splitAt(upstream, offsets))
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic: true,
      body,
      authorize: auth.authorize,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-cortexkit-relay-optimistic')).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/json')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(Buffer.from(bytes).equals(Buffer.from(upstream))).toBe(true)
    expect(auth.observed).toEqual([[1, 200]])
  })

  test(`an optimistic caller's non-streaming request keeps an error-looking success untouched (${name})`, async () => {
    const upstream = echoedStream(V1)
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
        })
        sendChunks(socket, payload.id, splitAt(encoder.encode(upstream), [33]))
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic: true,
      body,
      authorize: auth.authorize,
    })
    expect(response.headers.get('x-cortexkit-relay-optimistic')).toBeNull()
    expect(await response.text()).toBe(upstream)
  })

  test(`an optimistic caller's non-streaming request gets the genuine upstream error status, scrubbed (${name})`, async () => {
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 401, {
          'content-type': 'application/json',
          'request-id': 'req_ws_optimistic_401',
          'x-echo': `credential ${V1}`,
        })
        sendChunks(socket, payload.id, [
          encoder.encode(JSON.stringify(echoFor(V1))),
        ])
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic: true,
      body,
      authorize: auth.authorize,
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('x-cortexkit-relay-optimistic')).toBeNull()
    expect(response.headers.get('request-id')).toBe('req_ws_optimistic_401')
    expect(response.headers.get('x-echo')).toBe(
      `credential ${PROVIDER_ERROR_REDACTION}`,
    )
    expect(await response.text()).toBe(JSON.stringify(scrubbedEcho))
    expect(auth.observed).toEqual([[1, 401]])
  })
}

test('a streaming optimistic attempt that already received a partial upstream frame is not replayed', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 200, {
        'content-type': 'text/event-stream',
      })
      // An unterminated frame: the scope holds it, but the bytes arrived.
      sendChunks(socket, payload.id, [
        encoder.encode(`event: content_block_delta\ndata: {"partial":"${V1}`),
      ])
      socket.close(1011, 'interrupted after bytes')
    },
  })
  const auth = authorizer([V1, V2], true)
  const response = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expectOptimistic(response)
  const failure = await response.text().then(
    (text) => new Error(`Stream unexpectedly succeeded: ${text.length}`),
    (error: unknown) => error,
  )
  expect(failure instanceof Error ? failure.message : '').toBe(
    'relay websocket closed during response stream',
  )
  expect(relay.sent).toHaveLength(1)
  expect(auth.calls()).toBe(1)
})

for (const [name, body] of [
  ['non-streaming', requestBody('first')],
  ['streaming', streamingBody('first')],
] as const) {
  test(`a non-optimistic ${name} response is not replayed after its real response_start`, async () => {
    const relay = startRelay({
      ws: (socket, payload, index) => {
        if (index === 0) {
          // The real status and headers reach the host, then the socket
          // dies before any body byte.
          startResponse(socket, payload.id, 401, {
            'content-type': 'application/json',
            'request-id': 'req_first_attempt',
          })
          return socket.close(1011, 'interrupted after response_start')
        }
        startResponse(socket, payload.id, 500, {
          'content-type': 'application/json',
          'request-id': 'req_second_attempt',
        })
        sendChunks(socket, payload.id, [
          encoder.encode(JSON.stringify(echoFor(V2))),
        ])
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1, V2], true)
    const response = await send({
      relay,
      transport: 'websocket',
      body,
      authorize: auth.authorize,
    })
    const outcome = await response.text().then(
      (text) => ({ body: text }),
      (error: unknown) => ({
        failure: error instanceof Error ? error.message : String(error),
      }),
    )
    expect({
      status: response.status,
      requestId: response.headers.get('request-id'),
      outcome,
      physicalAttempts: relay.sent.length,
      authorizations: auth.calls(),
      upstreamStatuses: auth.observed,
    }).toEqual({
      status: 401,
      requestId: 'req_first_attempt',
      outcome: { failure: 'relay websocket closed during response stream' },
      physicalAttempts: 1,
      authorizations: 1,
      upstreamStatuses: [[1, 401]],
    })
  })
}

test('an optimistic streaming attempt that closes after response_start but before bytes is still retried with the new credential', async () => {
  const relay = startRelay({
    ws: (socket, payload, index) => {
      startResponse(socket, payload.id, 200, {
        'content-type': 'text/event-stream',
      })
      if (index === 0) return socket.close(1011, 'interrupted before bytes')
      sendChunks(socket, payload.id, [encoder.encode(echoedStream(V2))])
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1, V2], true)
  const response = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expectOptimistic(response)
  expect(await response.text()).toBe(scrubbedStream)
  expect(relay.sent).toHaveLength(2)
  expect(auth.observed).toEqual([
    [1, 200],
    [2, 200],
  ])
})
