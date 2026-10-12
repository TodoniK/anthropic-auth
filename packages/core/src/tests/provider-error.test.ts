import { expect } from 'bun:test'
import * as publicApi from '../index.ts'
import {
  createProviderErrorRedactor,
  createProviderErrorResponseScope,
  createProviderErrorStreamScope,
  PROVIDER_ERROR_MAX_BODY_BYTES,
  PROVIDER_ERROR_MAX_FRAME_BYTES,
  PROVIDER_ERROR_OVERSIZED_MESSAGE,
  PROVIDER_ERROR_REDACTION,
  PROVIDER_ERROR_RESPONSE_SCOPE_USED_MESSAGE,
  PROVIDER_ERROR_SCOPE_CLOSED_MESSAGE,
  PROVIDER_ERROR_WITHHELD_MESSAGE,
  type ProviderErrorRedactor,
  type ProviderResponseMode,
} from '../provider-error.ts'
import { SseFrameTooLargeError } from '../sse.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup, gate } = createTestLifetimeSuite()
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Synthetic credentials shaped like the real ones. The relay credential has no
// recognizable shape, so only exact-value scrubbing can remove it.
const OAUTH_TOKEN = `sk-ant-oat01-${'Qx7_Lm2-Vb9'.repeat(8)}AA`
const API_KEY = `sk-ant-api03-${'Zr4Kp8_Wd1-'.repeat(8)}AA`
const RELAY_CREDENTIAL = 'relay-attempt-credential-7f3e9a1c2b'
const OTHER_ATTEMPT_CREDENTIAL = 'relay-attempt-credential-0d5c8e6f4a'

function ownRedactor(secrets: readonly string[]): ProviderErrorRedactor {
  const redactor = createProviderErrorRedactor(secrets)
  deferCleanup(() => redactor.dispose())
  return redactor
}

/** Narrow an unknown result to a class, failing the test otherwise. */
function instance<T>(
  value: unknown,
  type: abstract new (...args: never[]) => T,
): T {
  if (!(value instanceof type))
    throw new Error(`expected an instance of ${type.name}`)
  return value
}

/** Read an own data property of an unknown value without running getters. */
function own(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== 'object') return undefined
  const field = Object.getOwnPropertyDescriptor(value, key)
  return field && 'value' in field ? field.value : undefined
}

/** Byte source that records pulls and cancellation, delivering the given chunks. */
function ownSource(chunks: Uint8Array[]) {
  const cancelled: unknown[] = []
  const record = { pulls: 0, cancelled }
  let index = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        record.pulls++
        const chunk = chunks[index++]
        if (chunk) controller.enqueue(chunk)
        else controller.close()
      },
      cancel(reason) {
        record.cancelled.push(reason)
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, record }
}

/** Read a body to the end, cancelling it at teardown if the test stops early. */
async function readAll(body: ReadableStream<Uint8Array> | null) {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  deferCleanup(() => reader.cancel().catch(() => {}))
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function eventStream(chunks: Uint8Array[], init?: ResponseInit) {
  const source = ownSource(chunks)
  const response = new Response(source.stream, {
    status: 200,
    ...init,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
  return { response, record: source.record }
}

function splitEvery(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += size)
    chunks.push(bytes.subarray(offset, offset + size))
  return chunks
}

test('constructor rejects non-arrays, proxies, accessors and non-strings without running them', () => {
  // Reflect.apply passes deliberately invalid arguments without a type cast
  // that would make the call look valid to TypeScript.
  const construct = (secrets: unknown) =>
    Reflect.apply(createProviderErrorRedactor, undefined, [secrets])
  for (const secrets of [undefined, null, 'token', { length: 1, 0: 'x' }])
    expect(() => construct(secrets)).toThrow(TypeError)

  let traps = 0
  const proxy = new Proxy([OAUTH_TOKEN], {
    get(target, key, receiver) {
      traps++
      return Reflect.get(target, key, receiver)
    },
    getOwnPropertyDescriptor(target, key) {
      traps++
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  expect(() => createProviderErrorRedactor(proxy)).toThrow(TypeError)
  expect(traps).toBe(0)

  let getterRuns = 0
  const accessor: string[] = []
  Object.defineProperty(accessor, 0, {
    get() {
      getterRuns++
      return OAUTH_TOKEN
    },
    enumerable: true,
  })
  expect(() => createProviderErrorRedactor(accessor)).toThrow(TypeError)
  expect(getterRuns).toBe(0)

  // An explicit hole: index 1 is never assigned.
  const holes: string[] = []
  holes[0] = OAUTH_TOKEN
  holes[2] = API_KEY
  expect(Object.hasOwn(holes, 1)).toBe(false)
  expect(() => createProviderErrorRedactor(holes)).toThrow(TypeError)
  expect(() => construct([OAUTH_TOKEN, 7])).toThrow(TypeError)
})

test('constructor copies the list, ignores empty strings, and exposes no credential', () => {
  const secrets = [RELAY_CREDENTIAL, '']
  const redactor = ownRedactor(secrets)
  secrets[0] = 'something-else'
  expect(redactor.redactText(`echo ${RELAY_CREDENTIAL}`)).toBe(
    `echo ${PROVIDER_ERROR_REDACTION}`,
  )
  expect(redactor.redactText('nothing secret here')).toBe('nothing secret here')
  expect(Object.isFrozen(redactor)).toBe(true)
  expect(JSON.stringify(redactor)).toBe('{}')
  expect(Reflect.ownKeys(redactor).sort()).toEqual([
    'dispose',
    'redactError',
    'redactResponse',
    'redactText',
  ])
  expect(Bun.inspect(redactor)).not.toContain(RELAY_CREDENTIAL)
  expect(() => Reflect.apply(redactor.redactText, redactor, [42])).toThrow(
    TypeError,
  )
  expect(() =>
    Reflect.apply(redactor.redactResponse, redactor, [{ ok: false }]),
  ).toThrow(TypeError)
})

test('redactText scrubs exact credentials and credential shapes but leaves prose alone', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL, `${RELAY_CREDENTIAL}-long`])
  expect(redactor.redactText(`a ${RELAY_CREDENTIAL}-long b`)).toBe(
    `a ${PROVIDER_ERROR_REDACTION} b`,
  )
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl'
  expect(
    redactor.redactText(
      `Authorization: Bearer ${OAUTH_TOKEN}; key=${API_KEY}; jwt=${jwt}`,
    ),
  ).toBe(
    `Authorization: Bearer ${PROVIDER_ERROR_REDACTION}; key=${PROVIDER_ERROR_REDACTION}; jwt=${PROVIDER_ERROR_REDACTION}`,
  )
  const prose =
    'Invalid bearer token; risk-based check; rate_limit_error; overloaded_error'
  expect(redactor.redactText(prose)).toBe(prose)
})

test('each attempt scrubs only its own exact credentials', () => {
  const first = ownRedactor([RELAY_CREDENTIAL])
  const second = ownRedactor([OTHER_ATTEMPT_CREDENTIAL])
  const text = `${RELAY_CREDENTIAL} / ${OTHER_ATTEMPT_CREDENTIAL}`
  expect(first.redactText(text)).toBe(
    `${PROVIDER_ERROR_REDACTION} / ${OTHER_ATTEMPT_CREDENTIAL}`,
  )
  expect(second.redactText(text)).toBe(
    `${RELAY_CREDENTIAL} / ${PROVIDER_ERROR_REDACTION}`,
  )
})

class UsageLimitError extends Error {
  status: number
  code: string
  retryAfterMs: number
  isRetryable: boolean
  constructor(message: string) {
    super(message)
    this.name = 'UsageLimitError'
    this.status = 429
    this.code = 'usage_limit_reached'
    this.retryAfterMs = 30_000
    this.isRetryable = false
  }
  get rerouteKind() {
    // Classifiers may read prototype getters that use safe own fields; the
    // copy keeps the prototype so this still works.
    return this.code === 'usage_limit_reached' ? 'usage-limit' : 'other'
  }
}

test('a credential beside a usage-limit code keeps class, status, code and retry metadata', () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  const original = new UsageLimitError(
    `usage limit reached for token ${OAUTH_TOKEN}`,
  )
  const result = redactor.redactError(original)
  if (!(result instanceof UsageLimitError)) throw new Error('class lost')
  expect(result).not.toBe(original)
  expect(result.message).toBe(
    `usage limit reached for token ${PROVIDER_ERROR_REDACTION}`,
  )
  expect(result.name).toBe('UsageLimitError')
  expect(result.status).toBe(429)
  expect(result.code).toBe('usage_limit_reached')
  expect(result.retryAfterMs).toBe(30_000)
  expect(result.isRetryable).toBe(false)
  expect(result.rerouteKind).toBe('usage-limit')
  expect(result.stack).not.toContain(OAUTH_TOKEN)
  expect(Bun.inspect(result)).not.toContain(OAUTH_TOKEN)
  expect(original.message).toContain(OAUTH_TOKEN)
})

test('an error without credentials is returned as the same object', () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  const original = new UsageLimitError('usage limit reached')
  Object.defineProperty(original, 'cause', {
    value: { status: 529, nested: ['overloaded_error'] },
  })
  expect(redactor.redactError(original)).toBe(original)
  expect(redactor.redactError(42)).toBe(42)
  expect(redactor.redactError(undefined)).toBe(undefined)
  expect(redactor.redactError(`plain ${OAUTH_TOKEN}`)).toBe(
    `plain ${PROVIDER_ERROR_REDACTION}`,
  )
})

test('accessor properties are dropped from the copy without being run', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  let getterRuns = 0
  const original = new Error('transport failed')
  Object.defineProperty(original, 'secretView', {
    get() {
      getterRuns++
      return RELAY_CREDENTIAL
    },
    enumerable: true,
  })
  Object.defineProperty(original, 'status', { value: 502, enumerable: true })
  const result = instance(redactor.redactError(original), Error)
  expect(getterRuns).toBe(0)
  expect(result).not.toBe(original)
  expect(Object.getOwnPropertyDescriptor(result, 'secretView')).toBeUndefined()
  expect(own(result, 'status')).toBe(502)
  expect(result.message).toBe('transport failed')
})

test('a frozen error yields a frozen scrubbed copy and stays untouched', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const original = Object.freeze(
    Object.assign(new TypeError(`fetch ${RELAY_CREDENTIAL}`), {
      code: 'ECONNRESET',
    }),
  )
  const result = instance(redactor.redactError(original), TypeError)
  expect(Object.isFrozen(result)).toBe(true)
  expect(result.message).toBe(`fetch ${PROVIDER_ERROR_REDACTION}`)
  expect(own(result, 'code')).toBe('ECONNRESET')
  expect(original.message).toBe(`fetch ${RELAY_CREDENTIAL}`)
  // A frozen original without credentials needs no copy.
  const clean = Object.freeze(new Error('fine'))
  expect(redactor.redactError(clean)).toBe(clean)
})

test('nested causes, aggregate members, symbols and cycles are scrubbed', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const marker = Symbol('detail')
  const inner = new Error(`inner ${RELAY_CREDENTIAL}`)
  Object.defineProperty(inner, marker, {
    value: `symbol ${RELAY_CREDENTIAL}`,
    enumerable: true,
  })
  const outer = new AggregateError([inner, 'safe'], 'outer', { cause: inner })
  Object.defineProperty(inner, 'parent', { value: outer, enumerable: true })
  const result = instance(redactor.redactError(outer), AggregateError)
  const copiedInner = instance(result.errors[0], Error)
  expect(copiedInner).not.toBe(inner)
  expect(copiedInner.message).toBe(`inner ${PROVIDER_ERROR_REDACTION}`)
  expect(own(copiedInner, marker)).toBe(`symbol ${PROVIDER_ERROR_REDACTION}`)
  expect(result.cause).toBe(copiedInner)
  expect(own(copiedInner, 'parent')).toBe(result)
  expect(result.errors[1]).toBe('safe')
  expect(Bun.inspect(result)).not.toContain(RELAY_CREDENTIAL)
})

test('a cycle through an unchanged object still points at the scrubbed copy', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const holder: { owner?: unknown; note: string } = { note: 'safe' }
  const original = Object.assign(new Error(`x ${RELAY_CREDENTIAL}`), {
    holder,
  })
  holder.owner = original
  const result = redactor.redactError(original)
  const copiedHolder = own(result, 'holder')
  expect(copiedHolder).not.toBe(holder)
  expect(own(copiedHolder, 'owner')).toBe(result)
})

test('proxies and hostile objects are replaced without running traps', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  let traps = 0
  const trap = () => {
    traps++
    throw new Error(RELAY_CREDENTIAL)
  }
  const proxied = new Proxy(new Error(RELAY_CREDENTIAL), {
    get: trap,
    getOwnPropertyDescriptor: trap,
    ownKeys: trap,
    getPrototypeOf: trap,
    has: trap,
  })
  const top = instance(redactor.redactError(proxied), Error)
  expect(top.message).not.toContain(RELAY_CREDENTIAL)
  const nested = redactor.redactError(
    Object.assign(new Error('outer'), { detail: proxied }),
  )
  expect(own(nested, 'detail')).toBe(PROVIDER_ERROR_REDACTION)
  expect(traps).toBe(0)
})

test('responses, headers, requests and byte payloads inside errors are scrubbed', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const original = Object.assign(new Error('upstream'), {
    response: new Response(`denied ${RELAY_CREDENTIAL}`, { status: 401 }),
    headers: new Headers({ 'x-echo': RELAY_CREDENTIAL, 'retry-after': '3' }),
    body: encoder.encode(`raw ${RELAY_CREDENTIAL}`),
    view: new DataView(encoder.encode(`view ${RELAY_CREDENTIAL}`).buffer),
    request: new Request('https://api.example.test/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${RELAY_CREDENTIAL}` },
    }),
  })
  const result = redactor.redactError(original)
  const response = instance(own(result, 'response'), Response)
  expect(response.status).toBe(401)
  expect(await response.text()).toBe(`denied ${PROVIDER_ERROR_REDACTION}`)
  const headers = instance(own(result, 'headers'), Headers)
  expect(headers.get('x-echo')).toBe(PROVIDER_ERROR_REDACTION)
  expect(headers.get('retry-after')).toBe('3')
  expect(decoder.decode(instance(own(result, 'body'), Uint8Array))).toBe(
    `raw ${PROVIDER_ERROR_REDACTION}`,
  )
  expect(decoder.decode(instance(own(result, 'view'), Uint8Array))).toBe(
    `view ${PROVIDER_ERROR_REDACTION}`,
  )
  const request = instance(own(result, 'request'), Request)
  expect(request.method).toBe('POST')
  expect(request.headers.get('authorization')).toBe(
    `Bearer ${PROVIDER_ERROR_REDACTION}`,
  )
})

test('clean platform values inside a changed error keep their identity; bytes are copied', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const headers = new Headers({ 'retry-after': '3' })
  const body = encoder.encode('no credential here')
  const exception = new DOMException('aborted', 'AbortError')
  const response = Response.json({ ok: true })
  const result = redactor.redactError(
    Object.assign(new Error(RELAY_CREDENTIAL), {
      headers,
      body,
      exception,
      response,
    }),
  )
  expect(own(result, 'headers')).toBe(headers)
  expect(own(result, 'exception')).toBe(exception)
  expect(own(result, 'response')).toBe(response)
  // Bytes are always a fresh plain copy so no override can travel with them.
  const copiedBody = instance(own(result, 'body'), Uint8Array)
  expect(copiedBody).not.toBe(body)
  expect([...copiedBody]).toEqual([...body])
})

test('Map, Set and other slot-backed containers in error details are withheld', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const original = Object.assign(new Error('rate limited'), {
    status: 429,
    code: 'rate_limit_error',
    details: {
      byKey: new Map([['token', RELAY_CREDENTIAL]]),
      seen: new Set([RELAY_CREDENTIAL]),
      weak: new WeakMap([[{}, RELAY_CREDENTIAL]]),
      boxed: Object(RELAY_CREDENTIAL),
      pending: Promise.resolve(RELAY_CREDENTIAL),
      retryAfterSeconds: 9,
    },
  })
  const result = instance(redactor.redactError(original), Error)
  expect(own(result, 'status')).toBe(429)
  expect(own(result, 'code')).toBe('rate_limit_error')
  const details = own(result, 'details')
  for (const key of ['byKey', 'seen', 'weak', 'boxed', 'pending'])
    expect(own(details, key)).toBe(PROVIDER_ERROR_REDACTION)
  expect(own(details, 'retryAfterSeconds')).toBe(9)
  expect(Bun.inspect(result)).not.toContain(RELAY_CREDENTIAL)
})

/** Install overriding accessors or methods that count every call. */
function trap(
  target: object,
  names: ReadonlyArray<PropertyKey>,
  kind: 'get' | 'value',
  ran: () => string,
): void {
  for (const name of names)
    Object.defineProperty(
      target,
      name,
      kind === 'get' ? { get: ran, configurable: true } : { value: ran },
    )
}

test('subclass and instance overrides of platform accessors never run while errors are scrubbed', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  let overrides = 0
  const ran = () => {
    overrides++
    return RELAY_CREDENTIAL
  }
  class TrickResponse extends Response {}
  trap(TrickResponse.prototype, ['ok', 'status', 'headers', 'body'], 'get', ran)
  class TrickHeaders extends Headers {}
  trap(
    TrickHeaders.prototype,
    ['forEach', 'entries', 'get', Symbol.iterator],
    'value',
    ran,
  )
  class TrickRequest extends Request {}
  trap(TrickRequest.prototype, ['url', 'method', 'headers'], 'get', ran)
  class TrickException extends DOMException {}
  trap(TrickException.prototype, ['message', 'name'], 'get', ran)
  class TrickBytes extends Uint8Array {}
  trap(TrickBytes.prototype, ['buffer', 'byteOffset', 'byteLength'], 'get', ran)
  // A plain Response whose own instance shadows the prototype accessors.
  const shadowed = new Response(`gone ${RELAY_CREDENTIAL}`, { status: 404 })
  trap(shadowed, ['ok', 'status'], 'get', ran)
  const original = Object.assign(new Error('upstream'), {
    response: new TrickResponse(`denied ${RELAY_CREDENTIAL}`, {
      status: 401,
      headers: { 'x-echo': RELAY_CREDENTIAL },
    }),
    shadowed,
    headers: new TrickHeaders({ 'x-echo': RELAY_CREDENTIAL }),
    request: new TrickRequest(
      `https://api.example.test/v1/messages?key=${RELAY_CREDENTIAL}`,
    ),
    exception: new TrickException(`aborted ${RELAY_CREDENTIAL}`, 'AbortError'),
    bytes: new TrickBytes(encoder.encode(`raw ${RELAY_CREDENTIAL}`)),
  })
  const result = redactor.redactError(original)
  expect(overrides).toBe(0)
  const response = own(result, 'response')
  expect(response).not.toBeInstanceOf(TrickResponse)
  const copied = instance(response, Response)
  expect(copied.status).toBe(401)
  expect(copied.headers.get('x-echo')).toBe(PROVIDER_ERROR_REDACTION)
  expect(await copied.text()).toBe(`denied ${PROVIDER_ERROR_REDACTION}`)
  const copiedShadowed = instance(own(result, 'shadowed'), Response)
  expect(copiedShadowed).not.toBe(shadowed)
  expect(copiedShadowed.status).toBe(404)
  expect(await copiedShadowed.text()).toBe(`gone ${PROVIDER_ERROR_REDACTION}`)
  const headers = instance(own(result, 'headers'), Headers)
  expect(headers).not.toBeInstanceOf(TrickHeaders)
  expect(headers.get('x-echo')).toBe(PROVIDER_ERROR_REDACTION)
  const request = instance(own(result, 'request'), Request)
  expect(request).not.toBeInstanceOf(TrickRequest)
  expect(request.url).not.toContain(RELAY_CREDENTIAL)
  const exception = instance(own(result, 'exception'), DOMException)
  expect(exception).not.toBeInstanceOf(TrickException)
  expect(exception.message).toBe(`aborted ${PROVIDER_ERROR_REDACTION}`)
  const bytes = instance(own(result, 'bytes'), Uint8Array)
  expect(bytes).not.toBeInstanceOf(TrickBytes)
  expect(decoder.decode(bytes)).toBe(`raw ${PROVIDER_ERROR_REDACTION}`)
  expect(overrides).toBe(0)
})

test('redactResponse reads a Response subclass through platform accessors', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  let overrides = 0
  class TrickResponse extends Response {}
  trap(TrickResponse.prototype, ['ok', 'status', 'statusText'], 'get', () => {
    overrides++
    return RELAY_CREDENTIAL
  })
  const result = redactor.redactResponse(
    new TrickResponse(`denied ${RELAY_CREDENTIAL}`, { status: 403 }),
  )
  expect(overrides).toBe(0)
  expect(result).not.toBeInstanceOf(TrickResponse)
  expect(result.status).toBe(403)
  expect(await result.text()).toBe(`denied ${PROVIDER_ERROR_REDACTION}`)
})

test('DOMException messages are scrubbed through the platform type', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const result = instance(
    redactor.redactError(
      new DOMException(`aborted ${RELAY_CREDENTIAL}`, 'AbortError'),
    ),
    DOMException,
  )
  expect(result.name).toBe('AbortError')
  expect(result.message).toBe(`aborted ${PROVIDER_ERROR_REDACTION}`)
})

test('non-2xx JSON bodies keep classification fields and headers while raw credentials are removed', async () => {
  const redactor = ownRedactor([OAUTH_TOKEN, RELAY_CREDENTIAL])
  const body = `{"type":"error","error":{"type":"rate_limit_error","message":"usage limit reached for ${OAUTH_TOKEN} via ${RELAY_CREDENTIAL}"},"request_id":"req_011"}`
  const source = ownSource([encoder.encode(body)])
  const original = new Response(source.stream, {
    status: 429,
    statusText: `Too Many ${RELAY_CREDENTIAL}`,
    headers: {
      'content-type': 'application/json',
      'retry-after': '17',
      'anthropic-ratelimit-unified-status': 'rejected',
      'content-length': String(body.length),
    },
  })
  const result = redactor.redactResponse(original)
  expect(result.status).toBe(429)
  expect(result.ok).toBe(false)
  expect(result.statusText).toBe(`Too Many ${PROVIDER_ERROR_REDACTION}`)
  expect(result.headers.get('retry-after')).toBe('17')
  expect(result.headers.get('anthropic-ratelimit-unified-status')).toBe(
    'rejected',
  )
  expect(result.headers.has('content-length')).toBe(false)
  // Nothing is read until the caller reads the body.
  expect(source.record.pulls).toBe(0)
  const text = decoder.decode(await readAll(result.body))
  expect(text).not.toContain(OAUTH_TOKEN)
  expect(text).not.toContain(RELAY_CREDENTIAL)
  expect(JSON.parse(text)).toEqual({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `usage limit reached for ${PROVIDER_ERROR_REDACTION} via ${PROVIDER_ERROR_REDACTION}`,
    },
    request_id: 'req_011',
  })
})

test('a non-2xx body without credentials keeps its exact bytes', async () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  // Escapes and spacing that a re-serialization would change.
  const body = encoder.encode(
    '{ "type": "error", "error": {"type":"overloaded_error","message":"\\u00e9 busy"} }',
  )
  const result = redactor.redactResponse(
    new Response(body, { status: 529, statusText: 'Overloaded' }),
  )
  expect(result.statusText).toBe('Overloaded')
  expect([...(await readAll(result.body))]).toEqual([...body])
})

test('a non-JSON non-2xx body is scrubbed as text', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const result = redactor.redactResponse(
    new Response(`<html>bad gateway ${RELAY_CREDENTIAL}</html>`, {
      status: 502,
    }),
  )
  expect(decoder.decode(await readAll(result.body))).toBe(
    `<html>bad gateway ${PROVIDER_ERROR_REDACTION}</html>`,
  )
})

test('an oversized non-2xx body is withheld and its source cancelled', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const chunk = encoder.encode(`${RELAY_CREDENTIAL.slice(0, 10)}`.repeat(6554))
  const chunks = Array.from(
    { length: Math.ceil(PROVIDER_ERROR_MAX_BODY_BYTES / chunk.length) + 1 },
    () => chunk,
  )
  const source = ownSource(chunks)
  const result = redactor.redactResponse(
    new Response(source.stream, { status: 500 }),
  )
  const text = decoder.decode(await readAll(result.body))
  expect(JSON.parse(text)).toEqual({
    type: 'error',
    error: { message: PROVIDER_ERROR_OVERSIZED_MESSAGE },
  })
  expect(source.record.cancelled.length).toBe(1)
  expect(source.record.pulls).toBeLessThan(chunks.length + 1)
})

test('cancelling an unread non-2xx body cancels the provider body', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const source = ownSource([encoder.encode('never read')])
  const result = redactor.redactResponse(
    new Response(source.stream, { status: 401 }),
  )
  await result.body?.cancel('caller gave up')
  expect(source.record.cancelled).toEqual(['caller gave up'])
  expect(source.record.pulls).toBe(0)
})

test('a provider body read failure is scrubbed before it reaches the caller', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const failing = new ReadableStream<Uint8Array>({
    pull() {
      throw Object.assign(new Error(`socket reset ${RELAY_CREDENTIAL}`), {
        code: 'ECONNRESET',
      })
    },
  })
  const result = redactor.redactResponse(new Response(failing, { status: 500 }))
  const failure = instance(
    await readAll(result.body).catch((error: unknown) => error),
    Error,
  )
  expect(failure.message).toBe(`socket reset ${PROVIDER_ERROR_REDACTION}`)
  expect(own(failure, 'code')).toBe('ECONNRESET')
})

test('successful non-stream responses are returned untouched', async () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  const json = Response.json({
    content: [{ type: 'text', text: `quoted ${OAUTH_TOKEN} error` }],
  })
  expect(redactor.redactResponse(json)).toBe(json)
  const empty = new Response(null, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
  expect(redactor.redactResponse(empty)).toBe(empty)
  // An instance that shadows a platform member is rebuilt instead, with the
  // same status and body bytes, so the shadowing override is left behind.
  let overrides = 0
  const shadowed = Response.json({ ok: true }, { status: 201 })
  trap(shadowed, ['text'], 'value', () => {
    overrides++
    return OAUTH_TOKEN
  })
  const rebuilt = redactor.redactResponse(shadowed)
  expect(rebuilt).not.toBe(shadowed)
  expect(rebuilt.status).toBe(201)
  expect(await rebuilt.text()).toBe('{"ok":true}')
  expect(overrides).toBe(0)
})

/**
 * Peek the way a host preflight does: clone the response, read one chunk from
 * the clone, release (not cancel) that reader, then read the original fully.
 */
async function peekCloneThenRead(response: Response): Promise<Uint8Array> {
  const clone = response.clone()
  const peeker = clone.body?.getReader()
  if (!peeker) throw new Error('missing clone body')
  await peeker.read()
  peeker.releaseLock()
  deferCleanup(() => clone.body?.cancel().catch(() => {}))
  return readAll(response.body)
}

test('successful responses survive a clone peek and release before the original is read', async () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  const text =
    'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
  const bytes = encoder.encode(text)
  const sse = { 'content-type': 'text/event-stream' }
  // Baseline: an unredacted string-backed response keeps its events.
  expect([...(await peekCloneThenRead(new Response(text)))]).toEqual([...bytes])

  // Passed through untouched: the same object, body slot never read.
  const plain = new Response(text)
  const passed = redactor.redactResponse(plain)
  expect(passed).toBe(plain)
  expect([...(await peekCloneThenRead(passed))]).toEqual([...bytes])
  const json = Response.json({ type: 'message' })
  expect(
    decoder.decode(await peekCloneThenRead(redactor.redactResponse(json))),
  ).toBe('{"type":"message"}')

  // Inside an error, a clean successful response is also left untouched.
  const nested = new Response(text)
  const result = redactor.redactError(
    Object.assign(new Error(`failed ${OAUTH_TOKEN}`), { response: nested }),
  )
  expect(own(result, 'response')).toBe(nested)
  expect([...(await peekCloneThenRead(nested))]).toEqual([...bytes])

  // Event streams are wrapped; the wrapper survives the same peek.
  const wrappedString = redactor.redactResponse(
    new Response(text, { headers: sse }),
  )
  expect([...(await peekCloneThenRead(wrappedString))]).toEqual([...bytes])
  const wrappedStream = redactor.redactResponse(
    eventStream(splitEvery(bytes, 9)).response,
  )
  expect([...(await peekCloneThenRead(wrappedStream))]).toEqual([...bytes])
})

function unicodeEscape(text: string): string {
  return [...text]
    .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('')
}

/** A successful stream exercising every framing feature, with error frames between. */
function streamFixture() {
  const success = [
    'event: message_start\r\ndata: {"type":"message_start","message":{"id":"msg_1"}}\r\n\r\n',
    ': ping comment\n\n',
    ':\n\n',
    'event: ping\ndata: {"type": "ping"}\n\n',
    // Model output quoting a credential and the word error is not error
    // material and must pass unchanged.
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"error: ${OAUTH_TOKEN} quoted"}}\n\n`,
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"\\u4e2d\\u6587 \\ud83d\\ude42 \\u0065rror"}}\r\n\r\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"中文 🙂"}}\r\r',
    'data: {"type":"content_block_delta",\ndata: "delta":{"type":"text_delta","text":"multi"}}\n\n',
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
  ]
  const errors = {
    escapedKeys: {
      input: `event: error\r\ndata: {"\\u0074ype":"\\u0065rror","\\u0065rror":{"type":"overloaded_error","message":"retry later ${RELAY_CREDENTIAL}"}}\r\n\r\n`,
      output: `event: error\r\ndata: {"type":"error","error":{"type":"overloaded_error","message":"retry later ${PROVIDER_ERROR_REDACTION}"}}\r\n\r\n`,
    },
    // The word "error" appears only as \u0065 escapes, so the raw gate must
    // admit this frame through its JSON-escape check, not the literal match.
    multilineEscaped: {
      input: `data: {"type":"\\u0065rror",\ndata: "\\u0065rror":{"type":"rate_limit_\\u0065rror","message":"usage limit for ${unicodeEscape(RELAY_CREDENTIAL)}"}}\n\n`,
      output: `data: {"type":"error","error":{"type":"rate_limit_error","message":"usage limit for ${PROVIDER_ERROR_REDACTION}"}}\n\n`,
    },
    plainText: {
      input: `event: error\ndata: upstream failure ${RELAY_CREDENTIAL}\n\n`,
      output: `event: error\ndata: upstream failure ${PROVIDER_ERROR_REDACTION}\n\n`,
    },
    tail: {
      input: `event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"Bearer ${OAUTH_TOKEN}"}}`,
      output: `event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"Bearer ${PROVIDER_ERROR_REDACTION}"}}`,
    },
  }
  const order = [
    success[0],
    success[1],
    errors.escapedKeys,
    success[2],
    success[3],
    success[4],
    errors.multilineEscaped,
    success[5],
    success[6],
    errors.plainText,
    success[7],
    success[8],
    errors.tail,
  ]
  const input = order
    .map((part) => (typeof part === 'string' ? part : part?.input))
    .join('')
  const output = order
    .map((part) => (typeof part === 'string' ? part : part?.output))
    .join('')
  return { input: encoder.encode(input), output: encoder.encode(output) }
}

async function redactStream(
  redactor: ProviderErrorRedactor,
  chunks: Uint8Array[],
) {
  const { response, record } = eventStream(chunks)
  const result = redactor.redactResponse(response)
  return { bytes: await readAll(result.body), record, result }
}

test('event streams keep success bytes exactly and rewrite only error envelopes at every split', async () => {
  const redactor = ownRedactor([OAUTH_TOKEN, RELAY_CREDENTIAL])
  const { input, output } = streamFixture()
  const whole = await redactStream(redactor, [input])
  expect(decoder.decode(whole.bytes)).toBe(decoder.decode(output))
  expect([...whole.bytes]).toEqual([...output])
  expect(whole.result.status).toBe(200)
  expect(whole.result.headers.get('content-type')).toContain(
    'text/event-stream',
  )
  for (const size of [1, 2, 3, 7, 64])
    expect([
      ...(await redactStream(redactor, splitEvery(input, size))).bytes,
    ]).toEqual([...output])
  for (let split = 1; split < input.length; split += 1) {
    const { bytes } = await redactStream(redactor, [
      input.subarray(0, split),
      input.subarray(split),
    ])
    if (
      bytes.length !== output.length ||
      !bytes.every((b, i) => b === output[i])
    )
      throw new Error(`split at ${split} changed the stream`)
  }
})

test('a stream without error envelopes is byte-identical even with credential-shaped content', async () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  const input = encoder.encode(
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Bearer ${OAUTH_TOKEN} error"}}\n\ndata: {"type":"message_stop"}\n\n`,
  )
  const { bytes } = await redactStream(redactor, splitEvery(input, 5))
  expect([...bytes]).toEqual([...input])
})

test('error frames keep their classification fields after rewriting', async () => {
  const redactor = ownRedactor([OAUTH_TOKEN, RELAY_CREDENTIAL])
  const { input } = streamFixture()
  const { bytes } = await redactStream(redactor, [input])
  const classify = (text: string) =>
    text
      .split(/\r\n\r\n|\n\n|\r\r/)
      .flatMap((frame) =>
        frame
          .split(/\r\n|\r|\n/)
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n'),
      )
      .flatMap((data) => {
        try {
          const event = JSON.parse(data)
          return event.type === 'error' ? [event.error.type] : []
        } catch {
          return []
        }
      })
  expect(classify(decoder.decode(bytes))).toEqual(
    classify(decoder.decode(input)),
  )
  expect(classify(decoder.decode(bytes))).toEqual([
    'overloaded_error',
    'rate_limit_error',
    'overloaded_error',
    'invalid_request_error',
  ])
})

test('an oversized complete frame in one chunk errors the stream without forwarding it', async () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  const head = encoder.encode('data: {"type":"message_start"}\n\n')
  const prefix = encoder.encode('data: ')
  const huge = new Uint8Array(PROVIDER_ERROR_MAX_FRAME_BYTES + 2).fill(0x61)
  huge.set(prefix, 0)
  huge.set(encoder.encode('\n\n'), huge.length - 2)
  const { response, record } = eventStream([head, huge])
  const reader = redactor.redactResponse(response).body?.getReader()
  if (!reader) throw new Error('missing body')
  deferCleanup(() => reader.cancel().catch(() => {}))
  expect([...((await reader.read()).value ?? [])]).toEqual([...head])
  const failure = await reader.read().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(SseFrameTooLargeError)
  expect(record.cancelled.length).toBe(1)
})

test('successful comments, heartbeats and plaintext data stay byte-identical before and after dispose', async () => {
  const redactor = createProviderErrorRedactor([RELAY_CREDENTIAL])
  // Each frame mentions "error" and quotes the credential but is not an
  // error envelope: no `event: error`, and no JSON error payload.
  const input = encoder.encode(
    [
      `: proxy error ${RELAY_CREDENTIAL}\n\n`,
      `:heartbeat error ${RELAY_CREDENTIAL}\r\n\r\n`,
      `event: ping\n: error note ${RELAY_CREDENTIAL}\n\n`,
      `data: plain text error ${RELAY_CREDENTIAL}\n\n`,
      `event: notice\ndata: not json, error ${RELAY_CREDENTIAL}\r\r`,
    ].join(''),
  )
  const before = await redactStream(redactor, splitEvery(input, 7))
  expect([...before.bytes]).toEqual([...input])
  const pending = eventStream(splitEvery(input, 7))
  const late = redactor.redactResponse(pending.response)
  redactor.dispose()
  expect([...(await readAll(late.body))]).toEqual([...input])
  const after = await redactStream(redactor, [input])
  expect([...after.bytes]).toEqual([...input])
})

test('after dispose an error type that is not a known Anthropic type is withheld', async () => {
  const redactor = createProviderErrorRedactor([RELAY_CREDENTIAL])
  const streamed = redactor.redactResponse(
    eventStream([
      encoder.encode(
        `data: {"type":"error","error":{"type":"${RELAY_CREDENTIAL.replaceAll('-', '_')}","message":"x"}}\n\ndata: {"type":"error","error":{"type":"overloaded_error","message":"x"}}\n\n`,
      ),
    ]).response,
  )
  const body = redactor.redactResponse(
    new Response(
      `{"type":"error","error":{"type":"${RELAY_CREDENTIAL.replaceAll('-', '_')}","message":"x"}}`,
      { status: 400 },
    ),
  )
  redactor.dispose()
  const frames = decoder
    .decode(await readAll(streamed.body))
    .split('\n\n')
    .filter((frame) => frame !== '')
    .map((frame) => JSON.parse(frame.slice('data: '.length)))
  expect(frames).toEqual([
    { type: 'error', error: { message: PROVIDER_ERROR_WITHHELD_MESSAGE } },
    {
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: PROVIDER_ERROR_WITHHELD_MESSAGE,
      },
    },
  ])
  expect(JSON.parse(decoder.decode(await readAll(body.body)))).toEqual({
    type: 'error',
    error: { message: PROVIDER_ERROR_WITHHELD_MESSAGE },
  })
})

/** Serve one canned non-2xx response on loopback and fetch it with the credential in the URL. */
async function fetchLoopbackFailure(
  status: number,
  headers: Record<string, string>,
): Promise<Response> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
        status,
        headers,
      }),
  })
  deferCleanup(() => server.stop(true))
  const response = await fetch(
    `http://127.0.0.1:${server.port}/v1/messages?key=${RELAY_CREDENTIAL}`,
  )
  // The credential sits in the URL the platform recorded for the fetch,
  // not in an own property that a plain read would also see.
  expect(response.url).toContain(RELAY_CREDENTIAL)
  expect(Reflect.ownKeys(response)).toEqual([])
  return response
}

test('after dispose non-2xx headers and url keep only verifiable retry and quota fields', async () => {
  const redactor = createProviderErrorRedactor([RELAY_CREDENTIAL])
  const original = await fetchLoopbackFailure(429, {
    'content-type': 'text/html',
    'x-echo': RELAY_CREDENTIAL,
    'request-id': RELAY_CREDENTIAL,
    'retry-after': '17',
    'x-should-retry': 'true',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '0.98',
    'anthropic-ratelimit-unified-5h-reset': '1790000000',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-fallback': RELAY_CREDENTIAL,
    'anthropic-ratelimit-unified-7d-status': RELAY_CREDENTIAL,
    'anthropic-ratelimit-unified-7d-utilization': RELAY_CREDENTIAL,
  })
  redactor.dispose()
  const result = redactor.redactResponse(original)
  expect(result.status).toBe(429)
  expect(result.statusText).toBe('')
  expect(result.url).toBe('')
  expect([...result.headers].sort()).toEqual([
    ['anthropic-ratelimit-unified-5h-reset', '1790000000'],
    ['anthropic-ratelimit-unified-5h-utilization', '0.98'],
    ['anthropic-ratelimit-unified-representative-claim', 'five_hour'],
    ['anthropic-ratelimit-unified-status', 'rejected'],
    ['content-type', 'application/json'],
    ['retry-after', '17'],
    ['x-should-retry', 'true'],
  ])
  expect(JSON.parse(decoder.decode(await readAll(result.body)))).toEqual({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: PROVIDER_ERROR_WITHHELD_MESSAGE,
    },
  })
})

test('before dispose non-2xx headers and url are scrubbed and otherwise kept', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const result = redactor.redactResponse(
    await fetchLoopbackFailure(503, {
      'x-echo': `seen ${RELAY_CREDENTIAL}`,
      'request-id': 'req_011',
      'retry-after': '5',
    }),
  )
  expect(result.status).toBe(503)
  expect(result.url).toContain('/v1/messages?key=')
  expect(result.url).not.toContain(RELAY_CREDENTIAL)
  expect(result.headers.get('x-echo')).toBe(`seen ${PROVIDER_ERROR_REDACTION}`)
  expect(result.headers.get('request-id')).toBe('req_011')
  expect(result.headers.get('retry-after')).toBe('5')
  expect(JSON.parse(decoder.decode(await readAll(result.body)))).toEqual({
    type: 'error',
    error: { type: 'rate_limit_error' },
  })
})

test('the wrapped stream pulls only on demand and forwards cancellation', async () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  const frames = Array.from({ length: 4 }, (_, index) =>
    encoder.encode(`data: {"type":"ping","n":${index}}\n\n`),
  )
  const { response, record } = eventStream(frames)
  const result = redactor.redactResponse(response)
  await Promise.resolve()
  expect(record.pulls).toBe(0)
  const reader = result.body?.getReader()
  if (!reader) throw new Error('missing body')
  deferCleanup(() => reader.cancel().catch(() => {}))
  const first = await reader.read()
  expect(decoder.decode(first.value)).toBe('data: {"type":"ping","n":0}\n\n')
  expect(record.pulls).toBeLessThanOrEqual(2)
  await reader.cancel('consumer stopped')
  expect(record.cancelled).toEqual(['consumer stopped'])
})

test('an oversized frame errors the stream after delivering earlier frames intact', async () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  const head = encoder.encode('data: {"type":"message_start"}\n\n')
  const huge = new Uint8Array(PROVIDER_ERROR_MAX_FRAME_BYTES + 1).fill(0x61)
  const { response, record } = eventStream([head, huge])
  const reader = redactor.redactResponse(response).body?.getReader()
  if (!reader) throw new Error('missing body')
  deferCleanup(() => reader.cancel().catch(() => {}))
  const first = await reader.read()
  expect([...(first.value ?? [])]).toEqual([...head])
  const failure = await reader.read().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(SseFrameTooLargeError)
  expect(record.cancelled.length).toBe(1)
})

test('a mid-stream transport failure is scrubbed before it reaches the reader', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  let sent = false
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent) throw new Error(`relay socket closed for ${RELAY_CREDENTIAL}`)
        sent = true
        controller.enqueue(encoder.encode('data: {"type":"ping"}\n\n'))
      },
    },
    { highWaterMark: 0 },
  )
  const result = redactor.redactResponse(
    new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
  )
  const failure = instance(
    await readAll(result.body).catch((error: unknown) => error),
    Error,
  )
  expect(failure.message).toBe(
    `relay socket closed for ${PROVIDER_ERROR_REDACTION}`,
  )
})

test('after dispose, late error reads fail closed while success bytes stay exact', async () => {
  const redactor = createProviderErrorRedactor([RELAY_CREDENTIAL])
  const success =
    'data: {"type":"content_block_delta","delta":{"text":"fine"}}\n\n'
  const failureFrame = `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"${RELAY_CREDENTIAL}"}}\n\n`
  const stream = eventStream([encoder.encode(success + failureFrame)])
  const streamed = redactor.redactResponse(stream.response)
  const body = redactor.redactResponse(
    new Response(
      `{"type":"error","error":{"type":"rate_limit_error","message":"${RELAY_CREDENTIAL}"}}`,
      { status: 429 },
    ),
  )
  redactor.dispose()

  expect(decoder.decode(await readAll(streamed.body))).toBe(
    `${success}event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"${PROVIDER_ERROR_WITHHELD_MESSAGE}"}}\n\n`,
  )
  expect(JSON.parse(decoder.decode(await readAll(body.body)))).toEqual({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: PROVIDER_ERROR_WITHHELD_MESSAGE,
    },
  })
  expect(redactor.redactText(RELAY_CREDENTIAL)).toBe(
    PROVIDER_ERROR_WITHHELD_MESSAGE,
  )
  expect(redactor.redactError(`x ${RELAY_CREDENTIAL}`)).toBe(
    PROVIDER_ERROR_WITHHELD_MESSAGE,
  )
  const late = instance(
    redactor.redactError(
      Object.assign(new Error(RELAY_CREDENTIAL), { status: 401 }),
    ),
    Error,
  )
  expect(late.message).toBe(PROVIDER_ERROR_WITHHELD_MESSAGE)
  expect(own(late, 'status')).toBe(401)
  const lateResponse = redactor.redactResponse(
    new Response('x', { status: 500, statusText: RELAY_CREDENTIAL }),
  )
  expect(lateResponse.statusText).toBe('')
})

test('a non-2xx JSON message that spells the sent token only as Unicode escapes is scrubbed after decoding', async () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  const escaped = unicodeEscape(OAUTH_TOKEN)
  const body = `{"type":"error","error":{"type":"rate_limit_error","message":"usage limit reached for ${escaped}"}}`
  // The raw bytes never contain the token, so text replacement alone finds
  // nothing; a host JSON decoder would still expose it.
  expect(body).not.toContain(OAUTH_TOKEN)
  expect(JSON.parse(body).error.message).toContain(OAUTH_TOKEN)
  const result = redactor.redactResponse(
    new Response(body, {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '42' },
    }),
  )
  expect(result.status).toBe(429)
  expect(result.headers.get('retry-after')).toBe('42')
  const decoded = JSON.parse(decoder.decode(await readAll(result.body)))
  expect(decoded).toEqual({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `usage limit reached for ${PROVIDER_ERROR_REDACTION}`,
    },
  })
})

test('a stream disposed mid-read withholds later error frames and transport failures', async () => {
  const redactor = createProviderErrorRedactor([RELAY_CREDENTIAL])
  const success = encoder.encode('data: {"type":"ping"}\n\n')
  const errorFrame = encoder.encode(
    `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"${RELAY_CREDENTIAL}"}}\n\n`,
  )
  let step = 0
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        step++
        if (step === 1) controller.enqueue(success)
        else if (step === 2) controller.enqueue(errorFrame)
        else throw new Error(`socket closed for ${RELAY_CREDENTIAL}`)
      },
    },
    { highWaterMark: 0 },
  )
  const reader = redactor
    .redactResponse(
      new Response(source, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    .body?.getReader()
  if (!reader) throw new Error('missing body')
  deferCleanup(() => reader.cancel().catch(() => {}))
  expect([...((await reader.read()).value ?? [])]).toEqual([...success])
  redactor.dispose()
  const late = decoder.decode((await reader.read()).value)
  expect(late).not.toContain(RELAY_CREDENTIAL)
  expect(JSON.parse(late.split('\n')[1]?.slice(6) ?? '')).toEqual({
    type: 'error',
    error: { type: 'api_error', message: PROVIDER_ERROR_WITHHELD_MESSAGE },
  })
  const failure = instance(
    await reader.read().catch((error: unknown) => error),
    Error,
  )
  expect(failure.message).toBe(PROVIDER_ERROR_WITHHELD_MESSAGE)
})

test('a non-2xx body whose read fails after dispose rejects with a generic error', async () => {
  const redactor = createProviderErrorRedactor([RELAY_CREDENTIAL])
  const failing = new ReadableStream<Uint8Array>({
    pull() {
      throw Object.assign(new Error(`reset ${RELAY_CREDENTIAL}`), {
        status: 503,
      })
    },
  })
  const result = redactor.redactResponse(new Response(failing, { status: 503 }))
  redactor.dispose()
  const failure = instance(
    await readAll(result.body).catch((error: unknown) => error),
    Error,
  )
  expect(failure.message).toBe(PROVIDER_ERROR_WITHHELD_MESSAGE)
  expect(own(failure, 'status')).toBe(503)
  expect(Bun.inspect(failure)).not.toContain(RELAY_CREDENTIAL)
})

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Feed chunks through a stream scope the way a relay forwards socket bytes. */
function feedScope(
  secrets: readonly string[],
  chunks: readonly Uint8Array[],
): Uint8Array {
  const scope = createProviderErrorStreamScope(secrets)
  deferCleanup(() => scope.dispose())
  const out: Uint8Array[] = []
  for (const chunk of chunks) out.push(...scope.push(chunk))
  out.push(...scope.finish())
  return joinBytes(out)
}

test('a stream scope forwards success bytes exactly and rewrites only error envelopes at every split', () => {
  const { input, output } = streamFixture()
  const secrets = [OAUTH_TOKEN, RELAY_CREDENTIAL]
  expect([...feedScope(secrets, [input])]).toEqual([...output])
  for (const size of [1, 3, 64])
    expect([...feedScope(secrets, splitEvery(input, size))]).toEqual([
      ...output,
    ])
  for (let split = 1; split < input.length; split += 1) {
    const bytes = feedScope(secrets, [
      input.subarray(0, split),
      input.subarray(split),
    ])
    if (
      bytes.length !== output.length ||
      !bytes.every((byte, index) => byte === output[index])
    )
      throw new Error(`split at ${split} changed the stream`)
  }
})

test('a stream scope returns unchanged frames as views of the pushed chunk', () => {
  const scope = createProviderErrorStreamScope([OAUTH_TOKEN])
  deferCleanup(() => scope.dispose())
  const chunk = encoder.encode(
    'data: {"type":"ping"}\n\ndata: {"type":"message_stop"}\n\ndata: {"partial"',
  )
  const out = scope.push(chunk)
  expect(out.length).toBe(1)
  expect(out[0]?.buffer).toBe(chunk.buffer)
  expect(decoder.decode(out[0])).toBe(
    'data: {"type":"ping"}\n\ndata: {"type":"message_stop"}\n\n',
  )
  // The incomplete frame is held, not forwarded early.
  expect(decoder.decode(joinBytes(scope.finish()))).toBe('data: {"partial"')
})

test('each relay attempt scope scrubs only the credential it was created with', () => {
  const frame = (credential: string) =>
    encoder.encode(
      `event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"bad ${credential}"}}\n\n`,
    )
  const first = decoder.decode(
    feedScope([RELAY_CREDENTIAL], [frame(RELAY_CREDENTIAL)]),
  )
  const reconnect = decoder.decode(
    feedScope([OTHER_ATTEMPT_CREDENTIAL], [frame(OTHER_ATTEMPT_CREDENTIAL)]),
  )
  expect(first).toContain(`bad ${PROVIDER_ERROR_REDACTION}`)
  expect(reconnect).toContain(`bad ${PROVIDER_ERROR_REDACTION}`)
  // A scope never learns another attempt's credential.
  expect(
    decoder.decode(
      feedScope([RELAY_CREDENTIAL], [frame(OTHER_ATTEMPT_CREDENTIAL)]),
    ),
  ).toContain(`bad ${OTHER_ATTEMPT_CREDENTIAL}`)
})

test('finish flushes exactly once and closes the scope', () => {
  const scope = createProviderErrorStreamScope([RELAY_CREDENTIAL])
  deferCleanup(() => scope.dispose())
  expect(
    scope.push(encoder.encode(`event: error\ndata: x ${RELAY_CREDENTIAL}`)),
  ).toEqual([])
  expect(decoder.decode(joinBytes(scope.finish()))).toBe(
    `event: error\ndata: x ${PROVIDER_ERROR_REDACTION}`,
  )
  expect(() => scope.finish()).toThrow(PROVIDER_ERROR_SCOPE_CLOSED_MESSAGE)
  expect(() => scope.push(encoder.encode('data: {}\n\n'))).toThrow(
    PROVIDER_ERROR_SCOPE_CLOSED_MESSAGE,
  )
  const late = instance(
    scope.redactError(
      Object.assign(new Error(RELAY_CREDENTIAL), { status: 401 }),
    ),
    Error,
  )
  expect(late.message).toBe(PROVIDER_ERROR_WITHHELD_MESSAGE)
  expect(own(late, 'status')).toBe(401)
})

test('dispose on cancel drops the held partial frame and the credentials', () => {
  const scope = createProviderErrorStreamScope([RELAY_CREDENTIAL])
  // A partial error frame quoting the credential is held, not forwarded.
  expect(
    scope.push(
      encoder.encode(`event: error\ndata: {"message":"${RELAY_CREDENTIAL}"`),
    ),
  ).toEqual([])
  const live = instance(scope.redactError(new Error(RELAY_CREDENTIAL)), Error)
  expect(live.message).toBe(PROVIDER_ERROR_REDACTION)
  scope.dispose()
  scope.dispose()
  expect(() => scope.finish()).toThrow(PROVIDER_ERROR_SCOPE_CLOSED_MESSAGE)
  expect(scope.redactError(`late ${RELAY_CREDENTIAL}`)).toBe(
    PROVIDER_ERROR_WITHHELD_MESSAGE,
  )
})

test('an oversized frame closes the stream scope', () => {
  const scope = createProviderErrorStreamScope([RELAY_CREDENTIAL])
  deferCleanup(() => scope.dispose())
  const huge = new Uint8Array(PROVIDER_ERROR_MAX_FRAME_BYTES + 1).fill(0x61)
  expect(() => scope.push(huge)).toThrow(SseFrameTooLargeError)
  expect(() => scope.push(encoder.encode('data: {}\n\n'))).toThrow(
    PROVIDER_ERROR_SCOPE_CLOSED_MESSAGE,
  )
  expect(scope.redactError(RELAY_CREDENTIAL)).toBe(
    PROVIDER_ERROR_WITHHELD_MESSAGE,
  )
})

test('a stream scope narrows its credentials and exposes only methods', () => {
  const create = (secrets: unknown) =>
    Reflect.apply(createProviderErrorStreamScope, undefined, [secrets])
  for (const secrets of [undefined, 'token', [7]])
    expect(() => create(secrets)).toThrow(TypeError)
  const scope = createProviderErrorStreamScope([RELAY_CREDENTIAL])
  deferCleanup(() => scope.dispose())
  expect(Object.isFrozen(scope)).toBe(true)
  expect(JSON.stringify(scope)).toBe('{}')
  expect(Bun.inspect(scope)).not.toContain(RELAY_CREDENTIAL)
  expect(() => Reflect.apply(scope.push, scope, ['data: x\n\n'])).toThrow(
    TypeError,
  )
  // A rejected chunk closes the scope rather than leaving it half-fed.
  expect(() => scope.push(encoder.encode('data: {}\n\n'))).toThrow(
    PROVIDER_ERROR_SCOPE_CLOSED_MESSAGE,
  )
})

function ownResponseScope(
  secrets: readonly string[],
  mode: ProviderResponseMode,
) {
  const scope = createProviderErrorResponseScope(secrets, mode)
  deferCleanup(() => scope.dispose())
  return scope
}

/**
 * The scope's settlement now, or 'pending' if it has not settled yet. Tests
 * never wait on `settled` itself, so a missing settlement fails an assertion
 * instead of hanging the test.
 */
function settlementNow(scope: {
  readonly settled: Promise<string>
}): Promise<string> {
  // An already-resolved `settled` wins because it is subscribed first.
  return Promise.race([scope.settled, Promise.resolve('pending')])
}

/** Event-stream source whose cancel stays pending until the gate opens. */
function heldCancelSource(chunks: Uint8Array[]) {
  const held = gate()
  const cancelled: unknown[] = []
  let index = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index++]
        if (chunk) controller.enqueue(chunk)
      },
      cancel(reason) {
        cancelled.push(reason)
        return held.wait
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, cancelled, release: held.open }
}

const SUCCESS_FRAME = 'data: {"type":"message_start"}\n\n'
const errorFrame = (credential: string) =>
  `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy ${credential}"}}\n\n`

test('the response scope is exported by name through the Core barrel; the relay scope is not', () => {
  expect(publicApi.createProviderErrorResponseScope).toBe(
    createProviderErrorResponseScope,
  )
  expect(publicApi.createProviderErrorRedactor).toBe(
    createProviderErrorRedactor,
  )
  expect(Object.hasOwn(publicApi, 'createProviderErrorStreamScope')).toBe(false)
})

test('an untouched successful response settles untouched at once without reading its body', async () => {
  const scope = ownResponseScope([OAUTH_TOKEN], 'http')
  const original = new Response(SUCCESS_FRAME)
  const result = scope.redactResponse(original)
  expect(result).toBe(original)
  expect(await settlementNow(scope)).toBe('untouched')
  expect(original.bodyUsed).toBe(false)
  // The body slot was never read, so a host clone/peek still sees every byte.
  expect(decoder.decode(await peekCloneThenRead(result))).toBe(SUCCESS_FRAME)
  expect(scope.redactError(`late ${OAUTH_TOKEN}`)).toBe(
    PROVIDER_ERROR_WITHHELD_MESSAGE,
  )
  expect(() => scope.redactResponse(new Response('again'))).toThrow(
    PROVIDER_ERROR_RESPONSE_SCOPE_USED_MESSAGE,
  )
})

test('responses without a body to wrap settle untouched, with non-2xx metadata scrubbed while live', async () => {
  const nullStream = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
  const emptyStream = new Response(null, {
    headers: { 'content-type': 'text/event-stream' },
  })
  expect(nullStream.redactResponse(emptyStream)).toBe(emptyStream)
  expect(await settlementNow(nullStream)).toBe('untouched')

  const failure = ownResponseScope([RELAY_CREDENTIAL], 'http')
  const original = new Response(null, {
    status: 503,
    statusText: `Down ${RELAY_CREDENTIAL}`,
    headers: { 'x-echo': RELAY_CREDENTIAL, 'retry-after': '4' },
  })
  const result = failure.redactResponse(original)
  expect(result).not.toBe(original)
  expect(result.status).toBe(503)
  expect(result.statusText).toBe(`Down ${PROVIDER_ERROR_REDACTION}`)
  expect(result.headers.get('x-echo')).toBe(PROVIDER_ERROR_REDACTION)
  expect(result.headers.get('retry-after')).toBe('4')
  expect(await settlementNow(failure)).toBe('untouched')

  // A shadowing subclass is still rebuilt, never handed back as-is.
  const shadow = ownResponseScope([RELAY_CREDENTIAL], 'http')
  class TrickResponse extends Response {}
  const trick = new TrickResponse('{"ok":true}', { status: 200 })
  const rebuilt = shadow.redactResponse(trick)
  expect(rebuilt).not.toBe(trick)
  expect(rebuilt).not.toBeInstanceOf(TrickResponse)
  expect(await rebuilt.text()).toBe('{"ok":true}')
  expect(await settlementNow(shadow)).toBe('untouched')
})

test('a wrapped event stream settles eof after its last error frame is scrubbed with live credentials', async () => {
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
  const { response } = eventStream([
    encoder.encode(SUCCESS_FRAME),
    encoder.encode(errorFrame(RELAY_CREDENTIAL)),
  ])
  const result = scope.redactResponse(response)
  expect(await settlementNow(scope)).toBe('pending')
  const text = decoder.decode(await readAll(result.body))
  expect(text).toBe(SUCCESS_FRAME + errorFrame(PROVIDER_ERROR_REDACTION))
  expect(await settlementNow(scope)).toBe('eof')
  // Settlement happens once; a later dispose does not change it.
  scope.dispose()
  expect(await settlementNow(scope)).toBe('eof')
  expect(scope.redactError(RELAY_CREDENTIAL)).toBe(
    PROVIDER_ERROR_WITHHELD_MESSAGE,
  )
})

test('cancelling a wrapped event stream retires credentials while the source cancel is still pending', async () => {
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
  const source = heldCancelSource([encoder.encode(SUCCESS_FRAME)])
  const result = scope.redactResponse(
    new Response(source.stream, {
      headers: { 'content-type': 'text/event-stream' },
    }),
  )
  const reader = result.body?.getReader()
  if (!reader) throw new Error('missing body')
  expect(decoder.decode((await reader.read()).value)).toBe(SUCCESS_FRAME)
  let cancelSettled = false
  const cancelling = reader.cancel('consumer stopped').then(() => {
    cancelSettled = true
  })
  expect(await settlementNow(scope)).toBe('cancel')
  expect(scope.redactError(RELAY_CREDENTIAL)).toBe(
    PROVIDER_ERROR_WITHHELD_MESSAGE,
  )
  expect(source.cancelled).toEqual(['consumer stopped'])
  expect(cancelSettled).toBe(false)
  source.release()
  await cancelling
  expect(cancelSettled).toBe(true)
})

test('an oversized frame retires credentials and errors the reader while the source cancel is held', async () => {
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
  const source = heldCancelSource([
    new Uint8Array(PROVIDER_ERROR_MAX_FRAME_BYTES + 1).fill(0x61),
  ])
  const result = scope.redactResponse(
    new Response(source.stream, {
      headers: { 'content-type': 'text/event-stream' },
    }),
  )
  const reader = result.body?.getReader()
  if (!reader) throw new Error('missing body')
  deferCleanup(() => reader.cancel().catch(() => {}))
  const failure = await reader.read().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(SseFrameTooLargeError)
  expect(await settlementNow(scope)).toBe('error')
  expect(source.cancelled.length).toBe(1)
  source.release()
})

test('a source read error is scrubbed with live credentials before the scope settles', async () => {
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
  const failing = new ReadableStream<Uint8Array>({
    pull() {
      throw Object.assign(new Error(`reset ${RELAY_CREDENTIAL}`), {
        code: 'ECONNRESET',
      })
    },
  })
  const result = scope.redactResponse(
    new Response(failing, { headers: { 'content-type': 'text/event-stream' } }),
  )
  const failure = instance(
    await readAll(result.body).catch((error: unknown) => error),
    Error,
  )
  // Scrubbed with the exact credential, not replaced by the generic message.
  expect(failure.message).toBe(`reset ${PROVIDER_ERROR_REDACTION}`)
  expect(own(failure, 'code')).toBe('ECONNRESET')
  expect(await settlementNow(scope)).toBe('error')
})

test('a non-2xx body settles eof after being scrubbed with live credentials', async () => {
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'http')
  const result = scope.redactResponse(
    new Response(
      `{"type":"error","error":{"type":"rate_limit_error","message":"limit for ${RELAY_CREDENTIAL}"}}`,
      { status: 429, headers: { 'retry-after': '9' } },
    ),
  )
  expect(result.headers.get('retry-after')).toBe('9')
  expect(await settlementNow(scope)).toBe('pending')
  expect(JSON.parse(decoder.decode(await readAll(result.body)))).toEqual({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `limit for ${PROVIDER_ERROR_REDACTION}`,
    },
  })
  expect(await settlementNow(scope)).toBe('eof')
})

test('cancelling an unread non-2xx body retires credentials while the source cancel is held', async () => {
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'http')
  const source = heldCancelSource([encoder.encode(RELAY_CREDENTIAL)])
  const result = scope.redactResponse(
    new Response(source.stream, { status: 401 }),
  )
  let cancelSettled = false
  const cancelling = result.body?.cancel('gave up').then(() => {
    cancelSettled = true
  })
  expect(await settlementNow(scope)).toBe('cancel')
  expect(cancelSettled).toBe(false)
  expect(source.cancelled).toEqual(['gave up'])
  source.release()
  await cancelling
  expect(cancelSettled).toBe(true)
})

test('dispose before reading settles disposed and later reads fail closed with exact success bytes', async () => {
  const scope = createProviderErrorResponseScope(
    [RELAY_CREDENTIAL],
    'event-stream',
  )
  const { response } = eventStream([
    encoder.encode(SUCCESS_FRAME + errorFrame(RELAY_CREDENTIAL)),
  ])
  const result = scope.redactResponse(response)
  scope.dispose()
  scope.dispose()
  expect(await settlementNow(scope)).toBe('disposed')
  expect(decoder.decode(await readAll(result.body))).toBe(
    `${SUCCESS_FRAME}event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"${PROVIDER_ERROR_WITHHELD_MESSAGE}"}}\n\n`,
  )
  expect(await settlementNow(scope)).toBe('disposed')
  expect(() => scope.redactResponse(new Response('x'))).toThrow(
    PROVIDER_ERROR_RESPONSE_SCOPE_USED_MESSAGE,
  )
})

test('a response scope narrows inputs, exposes only methods and is not consumed by a rejected call', async () => {
  const create = (...args: unknown[]) =>
    Reflect.apply(createProviderErrorResponseScope, undefined, args)
  for (const secrets of [undefined, 'token', [7]])
    expect(() => create(secrets, 'http')).toThrow(TypeError)
  // The mode is required and closed: no default, no near-miss spellings.
  for (const mode of [undefined, 'sse', 'HTTP', 'text/event-stream', {}])
    expect(() => create([RELAY_CREDENTIAL], mode)).toThrow(TypeError)
  expect(() => create([RELAY_CREDENTIAL])).toThrow(TypeError)
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'http')
  expect(Object.isFrozen(scope)).toBe(true)
  expect(JSON.stringify(scope)).toBe('{}')
  expect(Bun.inspect(scope)).not.toContain(RELAY_CREDENTIAL)
  expect(() =>
    Reflect.apply(scope.redactResponse, scope, [{ status: 200 }]),
  ).toThrow(TypeError)
  expect(await settlementNow(scope)).toBe('pending')
  const live = instance(scope.redactError(new Error(RELAY_CREDENTIAL)), Error)
  expect(live.message).toBe(PROVIDER_ERROR_REDACTION)
  // The rejected call did not use up the scope's one response.
  const ok = new Response('fine')
  expect(scope.redactResponse(ok)).toBe(ok)
  expect(await settlementNow(scope)).toBe('untouched')
})

/** A Response whose body another reader already holds, released at teardown. */
function lockedResponse(init: ResponseInit) {
  const original = new Response(
    `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"${RELAY_CREDENTIAL}"}}\n\n`,
    init,
  )
  const holder = original.body?.getReader()
  if (!holder) throw new Error('missing body')
  deferCleanup(() => holder.releaseLock())
  expect(original.body?.locked).toBe(true)
  return original
}

test('a locked event-stream body fails the wrapped read and settles error instead of staying live', async () => {
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
  const result = scope.redactResponse(
    lockedResponse({ headers: { 'content-type': 'text/event-stream' } }),
  )
  expect(await settlementNow(scope)).toBe('pending')
  const failure = await result.text().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(TypeError)
  expect(Bun.inspect(failure)).not.toContain(RELAY_CREDENTIAL)
  expect(await settlementNow(scope)).toBe('error')
  expect(scope.redactError(RELAY_CREDENTIAL)).toBe(
    PROVIDER_ERROR_WITHHELD_MESSAGE,
  )
})

test('a locked non-2xx body fails the scrubbed read and settles error instead of staying live', async () => {
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'http')
  const result = scope.redactResponse(lockedResponse({ status: 500 }))
  expect(result.status).toBe(500)
  expect(await settlementNow(scope)).toBe('pending')
  const failure = await result.text().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(TypeError)
  expect(Bun.inspect(failure)).not.toContain(RELAY_CREDENTIAL)
  expect(await settlementNow(scope)).toBe('error')
  expect(scope.redactError(RELAY_CREDENTIAL)).toBe(
    PROVIDER_ERROR_WITHHELD_MESSAGE,
  )
})

test('the same bodies unlocked read through and settle eof', async () => {
  const body = `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"${RELAY_CREDENTIAL}"}}\n\n`
  const streamScope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
  const streamed = streamScope.redactResponse(
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  )
  expect(await streamed.text()).toBe(
    `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"${PROVIDER_ERROR_REDACTION}"}}\n\n`,
  )
  expect(await settlementNow(streamScope)).toBe('eof')
  const failureScope = ownResponseScope([RELAY_CREDENTIAL], 'http')
  const failed = failureScope.redactResponse(
    new Response(body, { status: 500 }),
  )
  expect(await failed.text()).not.toContain(RELAY_CREDENTIAL)
  expect(await settlementNow(failureScope)).toBe('eof')
})

/** A successful stream body with no content type at all. */
function untypedStream(bytes: Uint8Array): Response {
  const response = new Response(ownSource(splitEvery(bytes, 11)).stream)
  expect(response.headers.has('content-type')).toBe(false)
  return response
}

/** A successful stream body that claims to be plain text. */
function plainTextStream(bytes: Uint8Array): Response {
  return new Response(ownSource(splitEvery(bytes, 11)).stream, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

test('event-stream mode scrubs an error envelope echoing the credential when the content type is missing or text/plain', async () => {
  const input = encoder.encode(SUCCESS_FRAME + errorFrame(RELAY_CREDENTIAL))
  const expected = SUCCESS_FRAME + errorFrame(PROVIDER_ERROR_REDACTION)
  for (const response of [untypedStream(input), plainTextStream(input)]) {
    const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
    const result = scope.redactResponse(response)
    const text = decoder.decode(await readAll(result.body))
    expect(text).not.toContain(RELAY_CREDENTIAL)
    expect(text).toBe(expected)
    expect(await settlementNow(scope)).toBe('eof')
  }
})

test('event-stream mode keeps successful bytes identical whatever the response content type says', async () => {
  // Successful frames that mention "error", escape letters, quote the
  // credential and mix line endings: all must pass byte for byte.
  const success = encoder.encode(
    [
      ': keep-alive error\n\n',
      'event: message_start\r\ndata: {"type":"message_start"}\r\n\r\n',
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"error ${RELAY_CREDENTIAL}"}}\n\n`,
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"\\u4e2d \\u0065rror 中文 🙂"}}\r\r',
      'data: {"type":"message_stop"}\n\n',
    ].join(''),
  )
  for (const response of [untypedStream(success), plainTextStream(success)]) {
    const scope = ownResponseScope(
      [OAUTH_TOKEN, RELAY_CREDENTIAL],
      'event-stream',
    )
    const bytes = await readAll(scope.redactResponse(response).body)
    expect([...bytes]).toEqual([...success])
    expect(await settlementNow(scope)).toBe('eof')
  }
})

test('event-stream mode wrappers survive a host clone peek with missing or text/plain content type', async () => {
  const bytes = encoder.encode(
    `${SUCCESS_FRAME}data: {"type":"message_stop"}\n\n`,
  )
  for (const response of [
    untypedStream(bytes),
    plainTextStream(bytes),
    new Response(decoder.decode(bytes), {
      headers: { 'content-type': 'text/plain' },
    }),
  ]) {
    const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
    const wrapped = scope.redactResponse(response)
    expect(wrapped).not.toBe(response)
    expect([...(await peekCloneThenRead(wrapped))]).toEqual([...bytes])
  }
})

test('http mode leaves ordinary successful responses untouched and unread, even when labelled as a stream', async () => {
  for (const headers of [
    {},
    { 'content-type': 'application/json' },
    { 'content-type': 'text/event-stream' },
  ]) {
    const scope = ownResponseScope([RELAY_CREDENTIAL], 'http')
    const original = new Response(SUCCESS_FRAME, { headers })
    expect(scope.redactResponse(original)).toBe(original)
    expect(original.bodyUsed).toBe(false)
    expect(await settlementNow(scope)).toBe('untouched')
    expect(decoder.decode(await peekCloneThenRead(original))).toBe(
      SUCCESS_FRAME,
    )
  }
})
