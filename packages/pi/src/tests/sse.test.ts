import { expect } from 'bun:test'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { firstStreamingError, parseSse } from '../stream.ts'

const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test

/** A streamed body that hands the parser `size` bytes per read. */
function chunkedResponse(text: string, size = 1) {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close()
          return
        }
        controller.enqueue(bytes.slice(offset, offset + size))
        offset += size
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

async function collect(response: Response) {
  const events: unknown[] = []
  for await (const event of parseSse(response)) events.push(event)
  return events
}

const unicodeText = 'début 🧪 漢字 error text stays content'
const start = {
  type: 'message_start',
  message: { usage: { input_tokens: 1, output_tokens: 0 } },
}
const delta = {
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text: unicodeText },
}
const stop = { type: 'message_stop' }
const frame = (value: { type: string }) =>
  `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
const lf = frame(start) + frame(delta) + frame(stop)

test('Pi SSE parser keeps LF frames and multibyte text split one byte per read', async () => {
  expect(await collect(chunkedResponse(lf))).toEqual([start, delta, stop])
})

test('Pi SSE parser accepts CRLF delimiters split one byte per read', async () => {
  expect(await collect(chunkedResponse(lf.replaceAll('\n', '\r\n')))).toEqual([
    start,
    delta,
    stop,
  ])
})

test('Pi SSE parser accepts LF and CRLF line endings mixed in one stream', async () => {
  const mixed =
    frame(start) +
    `event: content_block_delta\r\ndata: ${JSON.stringify(delta)}\n\r\n` +
    frame(stop).replaceAll('\n', '\r\n')
  expect(await collect(chunkedResponse(mixed, 3))).toEqual([start, delta, stop])
})

test('Pi SSE parser joins multiline data fields before JSON parsing', async () => {
  const multiline = `event: content_block_delta\ndata: {"type":"content_block_delta",\ndata: "index":0,\ndata: "delta":${JSON.stringify(delta.delta)}}\n\n`
  expect(
    await collect(chunkedResponse(frame(start) + multiline + frame(stop), 2)),
  ).toEqual([start, delta, stop])
})

test('Pi SSE parser ignores comments, heartbeats and empty frames', async () => {
  const noisy = `: keepalive\n\n${frame(start)}event: ping\ndata: {"type":"ping"}\n\n\n\n:comment\r\n\r\n${frame(stop)}`
  expect(await collect(chunkedResponse(noisy, 5))).toEqual([
    start,
    { type: 'ping' },
    stop,
  ])
})

test('Pi SSE parser surfaces a multiline CRLF error envelope as one event', async () => {
  const message = 'synthetic overloaded detail'
  const error = `event: error\r\ndata: {"type":"error",\r\ndata: "error":{"type":"overloaded_error",\r\ndata: "message":${JSON.stringify(message)}}}\r\n\r\n`
  expect(await collect(chunkedResponse(frame(start) + error))).toEqual([
    start,
    { type: 'error', error: { type: 'overloaded_error', message } },
  ])
})

test('Pi SSE parser drops a byte-order mark only at the start of the stream', async () => {
  const bom = '\uFEFF'
  const withBomText = {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: `${bom}kept` },
  }
  const body =
    `${bom}data: ${JSON.stringify(start)}\n\n` +
    frame(withBomText) +
    `${bom}data: ${JSON.stringify({ type: 'ping' })}\n\n` +
    frame(stop)
  // Drop a byte-order mark only at stream start. Preserve one inside text;
  // one at a later frame's start becomes part of an unrecognized field name.
  expect(await collect(chunkedResponse(body, 1))).toEqual([
    start,
    withBomText,
    stop,
  ])
})

// The first-event inspection reads the provider body with its own reader and
// replays what it read. That reader must be released once nothing will read
// it again, so the provider body is never left locked behind the replay.

/** A provider body whose reads are scripted, recording a cancellation. */
function scriptedBody(
  chunks: string[],
  end: 'close' | 'error' | 'open',
  record: { cancelled: boolean },
) {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[index++]))
        return
      }
      if (end === 'close') controller.close()
      else if (end === 'error')
        controller.error(new Error('synthetic provider read failure'))
      // 'open': never answers, like a provider that keeps the stream open.
      else return new Promise<void>(() => {})
    },
    cancel() {
      record.cancelled = true
    },
  })
}

const eventStreamOf = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } })

test('Pi first-event inspection releases the provider reader at end of stream', async () => {
  const record = { cancelled: false }
  const body = scriptedBody(
    [frame(start), frame(delta), frame(stop)],
    'close',
    record,
  )
  const { response, preflight } = await firstStreamingError(eventStreamOf(body))
  expect(preflight).toBe(response)
  expect(await collect(response)).toEqual([start, delta, stop])
  expect(body.locked).toBe(false)
  expect(record.cancelled).toBe(false)
})

test('Pi first-event inspection releases the provider reader after a read failure', async () => {
  const record = { cancelled: false }
  const body = scriptedBody([frame(start)], 'error', record)
  const { response } = await firstStreamingError(eventStreamOf(body))
  await expect(response.text()).rejects.toThrow(
    'synthetic provider read failure',
  )
  expect(body.locked).toBe(false)
})

test('Pi first-event inspection forwards a cancellation and then releases the provider reader', async () => {
  const record = { cancelled: false }
  const body = scriptedBody([frame(start)], 'open', record)
  const { response } = await firstStreamingError(eventStreamOf(body))
  await response.body?.cancel()
  expect(record.cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

test('Pi first-event inspection cancels and releases a rate-limited provider body', async () => {
  const record = { cancelled: false }
  const limit = {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'synthetic limit' },
  }
  const body = scriptedBody([frame(limit)], 'open', record)
  const { response, preflight } = await firstStreamingError(eventStreamOf(body))
  expect(preflight).toBe('rate_limit_error')
  expect(record.cancelled).toBe(true)
  expect(body.locked).toBe(false)
  // The error event already read stays readable.
  expect(await collect(response)).toEqual([limit])
})
