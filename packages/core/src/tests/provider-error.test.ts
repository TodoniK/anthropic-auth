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
  ProviderErrorSourceOversizedError,
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
  retryAfter: number
  isRetryable: boolean
  constructor(message: string) {
    super(message)
    this.name = 'UsageLimitError'
    this.status = 429
    this.code = 'usage_limit_reached'
    this.retryAfter = 30
    this.isRetryable = false
  }
  get rerouteKind() {
    return this.code === 'usage_limit_reached' ? 'usage-limit' : 'other'
  }
}

// Thrown values are projected, not copied: classification fields survive as
// own data on a fresh Error or plain record, while the original's prototype
// (and so its getters and private state) never comes back.

test('a credential beside a usage-limit code keeps name, status, code and retry metadata in a fresh projection', () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  const original = new UsageLimitError(
    `usage limit reached for token ${OAUTH_TOKEN}`,
  )
  const result = instance(redactor.redactError(original), Error)
  expect(result).not.toBe(original)
  expect(result).not.toBeInstanceOf(UsageLimitError)
  expect(Object.getPrototypeOf(result)).toBe(Error.prototype)
  expect(result.message).toBe(
    `usage limit reached for token ${PROVIDER_ERROR_REDACTION}`,
  )
  expect(result.name).toBe('UsageLimitError')
  expect(own(result, 'status')).toBe(429)
  expect(own(result, 'code')).toBe('usage_limit_reached')
  expect(own(result, 'retryAfter')).toBe(30)
  expect(own(result, 'isRetryable')).toBe(false)
  // A prototype getter is not part of the projection.
  expect('rerouteKind' in result).toBe(false)
  expect(result.stack).not.toContain(OAUTH_TOKEN)
  expect(Bun.inspect(result)).not.toContain(OAUTH_TOKEN)
  expect(original.message).toContain(OAUTH_TOKEN)
})

test('an error without credentials is still a fresh projection with the same classification', () => {
  const redactor = ownRedactor([OAUTH_TOKEN])
  const original = new UsageLimitError('usage limit reached')
  Object.defineProperty(original, 'cause', {
    value: { status: 529, nested: ['overloaded_error'] },
  })
  const result = instance(redactor.redactError(original), Error)
  expect(result).not.toBe(original)
  expect(result.message).toBe('usage limit reached')
  expect(own(result, 'status')).toBe(429)
  expect(own(result, 'code')).toBe('usage_limit_reached')
  expect(own(result, 'cause')).toEqual({ status: 529 })
  expect(redactor.redactError(42)).toBe(42)
  expect(redactor.redactError(undefined)).toBe(undefined)
  expect(redactor.redactError(`plain ${OAUTH_TOKEN}`)).toBe(
    `plain ${PROVIDER_ERROR_REDACTION}`,
  )
})

test('accessor properties are dropped from the projection without being run', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  let getterRuns = 0
  const original = new Error('transport failed')
  for (const key of ['code', 'secretView'])
    Object.defineProperty(original, key, {
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
  expect(Object.getOwnPropertyDescriptor(result, 'code')).toBeUndefined()
  expect(Object.getOwnPropertyDescriptor(result, 'secretView')).toBeUndefined()
  expect(own(result, 'status')).toBe(502)
  expect(result.message).toBe('transport failed')
})

test('a frozen built-in error is projected to a fresh error of the same built-in type and stays untouched', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const original = Object.freeze(
    Object.assign(new TypeError(`fetch ${RELAY_CREDENTIAL}`), {
      code: 'ECONNRESET',
    }),
  )
  const result = instance(redactor.redactError(original), TypeError)
  expect(result).not.toBe(original)
  expect(result.message).toBe(`fetch ${PROVIDER_ERROR_REDACTION}`)
  expect(own(result, 'code')).toBe('ECONNRESET')
  expect(original.message).toBe(`fetch ${RELAY_CREDENTIAL}`)
  // The built-in type comes from a closed list of names, and only for
  // values that really are native errors; a plain record claiming the name
  // stays a plain record.
  const pretender = redactor.redactError({ name: 'TypeError', message: 'x' })
  expect(pretender).not.toBeInstanceOf(Error)
  expect(pretender).toEqual({ name: 'TypeError', message: 'x' })
})

test('nested causes and aggregate members are projected; symbols and unknown fields are dropped', () => {
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
  expect(result.message).toBe('outer')
  const copiedInner = instance(result.errors[0], Error)
  expect(copiedInner).not.toBe(inner)
  expect(copiedInner.message).toBe(`inner ${PROVIDER_ERROR_REDACTION}`)
  expect(Reflect.ownKeys(copiedInner)).not.toContain(marker)
  expect(Object.hasOwn(copiedInner, 'parent')).toBe(false)
  expect(result.cause).toBe(copiedInner)
  expect(result.errors[1]).toBe('safe')
  expect(Bun.inspect(result)).not.toContain(RELAY_CREDENTIAL)
})

test('a cycle through cause points at the projection', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const holder: { cause?: unknown; message: string } = { message: 'safe' }
  const original = Object.assign(new Error(`x ${RELAY_CREDENTIAL}`), {
    cause: holder,
  })
  holder.cause = original
  const result = redactor.redactError(original)
  const copiedHolder = own(result, 'cause')
  expect(copiedHolder).not.toBe(holder)
  expect(own(copiedHolder, 'message')).toBe('safe')
  expect(own(copiedHolder, 'cause')).toBe(result)
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
    Object.assign(new Error('outer'), { cause: proxied }),
  )
  expect(own(nested, 'cause')).toBe(PROVIDER_ERROR_REDACTION)
  expect(traps).toBe(0)
})

test('responses and headers inside errors become status and header records; bodies, requests and bytes are dropped', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const nested = new Response(`denied ${RELAY_CREDENTIAL}`, {
    status: 401,
    statusText: `No ${RELAY_CREDENTIAL}`,
    headers: {
      'content-type': 'text/plain',
      'retry-after': '7',
      'x-echo': RELAY_CREDENTIAL,
    },
  })
  const original = Object.assign(new Error('upstream'), {
    response: nested,
    headers: new Headers({ 'x-echo': RELAY_CREDENTIAL, 'retry-after': '3' }),
    responseHeaders: {
      'retry-after': '5',
      [`x-${RELAY_CREDENTIAL}`]: 'named after the credential',
    },
    body: encoder.encode(`raw ${RELAY_CREDENTIAL}`),
    request: new Request('https://api.example.test/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${RELAY_CREDENTIAL}` },
    }),
  })
  const result = redactor.redactError(original)
  expect(own(result, 'response')).toEqual({
    status: 401,
    statusText: `No ${PROVIDER_ERROR_REDACTION}`,
    headers: {
      'content-type': 'text/plain',
      'retry-after': '7',
      'x-echo': PROVIDER_ERROR_REDACTION,
    },
  })
  expect(nested.bodyUsed).toBe(false)
  expect(own(result, 'headers')).toEqual({
    'retry-after': '3',
    'x-echo': PROVIDER_ERROR_REDACTION,
  })
  expect(own(result, 'responseHeaders')).toEqual({ 'retry-after': '5' })
  expect(Object.hasOwn(Object(result), 'body')).toBe(false)
  expect(Object.hasOwn(Object(result), 'request')).toBe(false)
})

test('platform values inside an error never keep their identity, even without credentials', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const headers = new Headers({ 'retry-after': '3' })
  const exception = new DOMException('aborted', 'AbortError')
  const response = Response.json({ ok: true })
  const result = redactor.redactError(
    Object.assign(new Error(RELAY_CREDENTIAL), {
      headers,
      cause: exception,
      response,
    }),
  )
  expect(own(result, 'headers')).toEqual({ 'retry-after': '3' })
  const cause = instance(own(result, 'cause'), Error)
  expect(cause).not.toBeInstanceOf(DOMException)
  expect(cause.name).toBe('AbortError')
  expect(own(result, 'response')).not.toBe(response)
  expect(own(own(result, 'response'), 'status')).toBe(200)
  expect(response.bodyUsed).toBe(false)
})

test('Map, Set and other slot-backed containers in error fields contribute nothing', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const original = Object.assign(new Error('rate limited'), {
    status: 429,
    code: 'rate_limit_error',
    headers: new Map([['token', RELAY_CREDENTIAL]]),
    cause: new Set([RELAY_CREDENTIAL]),
    error: Promise.resolve(RELAY_CREDENTIAL),
    responseHeaders: new WeakMap([[{}, RELAY_CREDENTIAL]]),
    retryAfter: Object(RELAY_CREDENTIAL),
  })
  const result = instance(redactor.redactError(original), Error)
  expect(own(result, 'status')).toBe(429)
  expect(own(result, 'code')).toBe('rate_limit_error')
  expect(own(result, 'headers')).toEqual({})
  expect(own(result, 'cause')).toEqual({})
  expect(own(result, 'error')).toEqual({})
  expect(Object.hasOwn(result, 'retryAfter')).toBe(false)
  expect(await exposes(result, RELAY_CREDENTIAL)).toBe(false)
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
    error: { response: shadowed },
    headers: new TrickHeaders({ 'x-echo': RELAY_CREDENTIAL }),
    request: new TrickRequest(
      `https://api.example.test/v1/messages?key=${RELAY_CREDENTIAL}`,
    ),
    cause: new TrickException(`aborted ${RELAY_CREDENTIAL}`, 'AbortError'),
    bytes: new TrickBytes(encoder.encode(`raw ${RELAY_CREDENTIAL}`)),
  })
  const result = redactor.redactError(original)
  expect(overrides).toBe(0)
  const response = own(result, 'response')
  expect(response).not.toBeInstanceOf(Response)
  expect(own(response, 'status')).toBe(401)
  expect(own(own(response, 'headers'), 'x-echo')).toBe(PROVIDER_ERROR_REDACTION)
  expect(own(own(own(result, 'error'), 'response'), 'status')).toBe(404)
  expect(own(result, 'headers')).toEqual({ 'x-echo': PROVIDER_ERROR_REDACTION })
  expect(Object.hasOwn(Object(result), 'request')).toBe(false)
  expect(Object.hasOwn(Object(result), 'bytes')).toBe(false)
  const exception = instance(own(result, 'cause'), Error)
  expect(exception).not.toBeInstanceOf(DOMException)
  expect(exception.name).toBe('AbortError')
  expect(exception.message).toBe(`aborted ${PROVIDER_ERROR_REDACTION}`)
  expect(await exposes(result, RELAY_CREDENTIAL)).toBe(false)
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

test('DOMException name and message are read through the platform type into a fresh error', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const result = instance(
    redactor.redactError(
      new DOMException(`aborted ${RELAY_CREDENTIAL}`, 'AbortError'),
    ),
    Error,
  )
  expect(result).not.toBeInstanceOf(DOMException)
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

  // Inside an error, a successful response is projected without its body
  // ever being read, so its owner can still peek and read it.
  const nested = new Response(text)
  const result = redactor.redactError(
    Object.assign(new Error(`failed ${OAUTH_TOKEN}`), { response: nested }),
  )
  expect(own(own(result, 'response'), 'status')).toBe(200)
  expect(nested.bodyUsed).toBe(false)
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

// Cover credential echoes in encoded data, error metadata and stream failures.
// Most cases pass the credentials associated with the response's physical request.

/** Decode JSON \uXXXX escapes the way any JSON decoder downstream would. */
function decodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
}

/**
 * True when `secret` can be read back out of `value` by an ordinary consumer:
 * own and inherited properties (getters included), symbol descriptions,
 * header names and values, URL text, and stream or response body bytes.
 */
async function exposes(value: unknown, secret: string): Promise<boolean> {
  const seen = new Set<unknown>()
  const visit = async (current: unknown, depth: number): Promise<boolean> => {
    if (typeof current === 'string')
      return current.includes(secret) || decodeEscapes(current).includes(secret)
    if (typeof current === 'symbol')
      return (current.description ?? '').includes(secret)
    if (current === null || depth > 8) return false
    if (typeof current !== 'object' && typeof current !== 'function')
      return false
    if (seen.has(current)) return false
    seen.add(current)
    if (current instanceof Headers)
      for (const [name, entry] of current)
        if (name.includes(secret) || entry.includes(secret)) return true
    if (current instanceof URL && current.href.includes(secret)) return true
    if (current instanceof Response) {
      if (current.url.includes(secret)) return true
      if (!current.bodyUsed && (await current.clone().text()).includes(secret))
        return true
    }
    if (current instanceof ReadableStream && !current.locked)
      return (await new Response(current).text()).includes(secret)
    const keys = new Set<PropertyKey>(Reflect.ownKeys(current))
    for (const key in current) keys.add(key)
    for (const key of keys) {
      if (typeof key === 'symbol' && (await visit(key, depth))) return true
      if (typeof key === 'string' && key.includes(secret)) return true
      let entry: unknown
      try {
        entry = Reflect.get(current, key)
      } catch {
        continue
      }
      if (await visit(entry, depth + 1)) return true
    }
    return false
  }
  return visit(value, 0)
}

test('a non-2xx JSON body cannot hide a credential in an earlier duplicate key, literal or escaped', async () => {
  for (const body of [
    `{"type":"error","error":{"type":"rate_limit_error","message":"${RELAY_CREDENTIAL}"},"error":{"type":"rate_limit_error","message":"ok"}}`,
    `{"m":"${unicodeEscape(RELAY_CREDENTIAL)}","m":"ok"}`,
  ])
    for (const mode of ['http', 'event-stream'] as const) {
      const scope = ownResponseScope([RELAY_CREDENTIAL], mode)
      const result = scope.redactResponse(new Response(body, { status: 429 }))
      const text = decoder.decode(await readAll(result.body))
      expect(text).not.toContain(RELAY_CREDENTIAL)
      expect(decodeEscapes(text)).not.toContain(RELAY_CREDENTIAL)
      expect(await settlementNow(scope)).toBe('eof')
    }
})

test('a non-JSON non-2xx body that spells the credential only as escapes is scrubbed', async () => {
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'http')
  const body = `event: error\ndata: {"error":"${unicodeEscape(RELAY_CREDENTIAL)}"}\n\n`
  const text = decoder.decode(
    await readAll(
      scope.redactResponse(new Response(body, { status: 401 })).body,
    ),
  )
  expect(decodeEscapes(text)).not.toContain(RELAY_CREDENTIAL)
  expect(text).toContain('event: error')
})

test('an SSE error frame cannot hide an escaped credential in an earlier duplicate key', async () => {
  const frame = `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"${unicodeEscape(RELAY_CREDENTIAL)}"},"error":{"type":"api_error","message":"ok"}}\n\n`
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
  const text = decoder.decode(
    await readAll(
      scope.redactResponse(eventStream([encoder.encode(frame)]).response).body,
    ),
  )
  expect(decodeEscapes(text)).not.toContain(RELAY_CREDENTIAL)
  // The error event retains its api_error type.
  expect(text.startsWith('event: error\n')).toBe(true)
  expect(text).toContain('"type":"api_error"')
  const relay = decoder.decode(
    feedScope([RELAY_CREDENTIAL], [encoder.encode(frame)]),
  )
  expect(decodeEscapes(relay)).not.toContain(RELAY_CREDENTIAL)
})

test('non-2xx header entries whose name carries the credential are dropped while retry headers keep their values', () => {
  const headers = {
    [`x-${RELAY_CREDENTIAL}`]: '1',
    [RELAY_CREDENTIAL]: 'x',
    'retry-after': '4',
    'anthropic-ratelimit-unified-status': 'rejected',
  }
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'http')
  for (const result of [
    redactor.redactResponse(new Response(null, { status: 401, headers })),
    scope.redactResponse(new Response('denied', { status: 429, headers })),
  ]) {
    const names = [...result.headers.keys()]
    expect(names.some((name) => name.includes(RELAY_CREDENTIAL))).toBe(false)
    expect(result.headers.get('retry-after')).toBe('4')
    expect(result.headers.get('anthropic-ratelimit-unified-status')).toBe(
      'rejected',
    )
  }
})

test('thrown values never carry the credential through expandos, callables, inherited data, URL, symbol or stream slots', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const body = () =>
    new Response(`denied ${RELAY_CREDENTIAL}`, { status: 401 }).body
  const inputs: Array<[string, unknown]> = [
    [
      'headers expando',
      Object.assign(new Headers(), { token: RELAY_CREDENTIAL }),
    ],
    ['callable', Object.assign(() => 0, { token: RELAY_CREDENTIAL })],
    ['inherited data', Object.create({ token: RELAY_CREDENTIAL })],
    ['url', new URL(`https://example.invalid/?key=${RELAY_CREDENTIAL}`)],
    ['symbol', Symbol(RELAY_CREDENTIAL)],
    ['stream slot', { body: body() }],
    ['error with stream', Object.assign(new Error('x'), { body: body() })],
    [
      'error with url and symbol',
      Object.assign(new Error('x'), {
        url: new URL(`https://example.invalid/?key=${RELAY_CREDENTIAL}`),
        marker: Symbol(RELAY_CREDENTIAL),
        cause: Object.create({ token: RELAY_CREDENTIAL }),
      }),
    ],
    [
      'request',
      {
        request: new Request(
          `https://example.invalid/?key=${RELAY_CREDENTIAL}`,
          { method: 'POST', body: RELAY_CREDENTIAL },
        ),
      },
    ],
    [
      'domexception expando',
      Object.assign(new DOMException('aborted', 'AbortError'), {
        token: RELAY_CREDENTIAL,
      }),
    ],
  ]
  for (const [label, input] of inputs) {
    const result = redactor.redactError(input)
    if (await exposes(result, RELAY_CREDENTIAL))
      throw new Error(`${label} exposed the credential`)
  }
})

test('an ok Response nested in a thrown error keeps no URL, headers or body that could carry the credential', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const nested = new Response(`echo ${RELAY_CREDENTIAL}`, {
    headers: { 'x-echo': RELAY_CREDENTIAL },
  })
  const result = redactor.redactError(
    Object.assign(new Error('failed'), { response: nested }),
  )
  expect(await exposes(result, RELAY_CREDENTIAL)).toBe(false)
  // The original body was never read, so its owner can still consume it.
  expect(nested.bodyUsed).toBe(false)
})

test('thrown values are projected without running proxy traps on their prototype chain', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  let ran = 0
  const hostile = new Proxy(Error.prototype, {
    getPrototypeOf() {
      ran++
      return null
    },
    getOwnPropertyDescriptor(target, key) {
      ran++
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
    get(target, key, receiver) {
      ran++
      return Reflect.get(target, key, receiver)
    },
  })
  const viaCreate = Object.create(hostile)
  const viaError = new Error(`failed ${RELAY_CREDENTIAL}`)
  Object.setPrototypeOf(viaError, hostile)
  for (const input of [
    viaCreate,
    viaError,
    Object.assign(new Error('outer'), { cause: viaError }),
  ]) {
    const result = redactor.redactError(input)
    expect(await exposes(result, RELAY_CREDENTIAL)).toBe(false)
  }
  expect(ran).toBe(0)
})

test('redactError never wraps a nested Response body, so it cannot change the scope settlement', async () => {
  const http = ownResponseScope([RELAY_CREDENTIAL], 'http')
  http.redactError({ r: new Response('x', { status: 500 }) })
  http.redactResponse(new Response('ok'))
  expect(await settlementNow(http)).toBe('untouched')

  // Reading the nested failure body to the end must not change the live stream's settlement.
  const stream = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
  const result = stream.redactResponse(
    eventStream([encoder.encode(errorFrame(RELAY_CREDENTIAL))]).response,
  )
  const nested = own(
    stream.redactError({
      response: new Response(`x ${RELAY_CREDENTIAL}`, { status: 500 }),
    }),
    'response',
  )
  expect(nested instanceof Response).toBe(false)
  expect(await settlementNow(stream)).toBe('pending')
  expect(decoder.decode(await readAll(result.body))).toBe(
    errorFrame(PROVIDER_ERROR_REDACTION),
  )
  expect(await settlementNow(stream)).toBe('eof')
})

/** A source whose cancel rejects with the credential in its message. */
function rejectingCancelSource() {
  return new ReadableStream<Uint8Array>({
    cancel() {
      throw new Error(`cancel failed for ${RELAY_CREDENTIAL}`)
    },
  })
}

test('a source cancel rejection after retirement reaches the consumer only as a generic error', async () => {
  for (const [mode, status] of [
    ['event-stream', 200],
    ['http', 401],
  ] as const) {
    const scope = ownResponseScope([RELAY_CREDENTIAL], mode)
    const result = scope.redactResponse(
      new Response(rejectingCancelSource(), { status }),
    )
    const rejection = await result.body?.cancel('stop').then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(await exposes(rejection, RELAY_CREDENTIAL)).toBe(false)
    expect(await settlementNow(scope)).toBe('cancel')
  }
  // The public redactor must also replace a source cancellation rejection
  // with a fixed error that cannot repeat the source's credential.
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const rejection = await redactor
    .redactResponse(
      new Response(rejectingCancelSource(), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    .body?.cancel()
    .then(
      () => undefined,
      (error: unknown) => error,
    )
  expect(await exposes(rejection, RELAY_CREDENTIAL)).toBe(false)
})

test('a byte-order mark is stripped only at the start of the stream', async () => {
  // Mid-stream, U+FEFF is part of the field name, so this frame is an
  // ordinary message event and must pass byte for byte.
  const later = encoder.encode(
    `:\n\n\uFEFFevent: error\ndata: ${RELAY_CREDENTIAL}\n\n`,
  )
  // At the very start one BOM is ignored, so this frame is a real error
  // event, even when the BOM bytes arrive split across chunks.
  const first = encoder.encode(`\uFEFF${errorFrame(RELAY_CREDENTIAL)}`)
  const firstExpected = encoder.encode(
    `\uFEFF${errorFrame(PROVIDER_ERROR_REDACTION)}`,
  )
  for (const chunks of [[later], splitEvery(later, 1)]) {
    const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
    const bytes = await readAll(
      scope.redactResponse(eventStream(chunks).response).body,
    )
    expect([...bytes]).toEqual([...later])
    expect([...feedScope([RELAY_CREDENTIAL], chunks)]).toEqual([...later])
  }
  for (const chunks of [[first], splitEvery(first, 1), splitEvery(first, 2)]) {
    const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
    const bytes = await readAll(
      scope.redactResponse(eventStream(chunks).response).body,
    )
    expect([...bytes]).toEqual([...firstExpected])
    expect([...feedScope([RELAY_CREDENTIAL], chunks)]).toEqual([
      ...firstExpected,
    ])
  }
})

test('the JWT shape scan removes real JWTs, plain or escaped', () => {
  const redactor = ownRedactor([])
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl'
  expect(redactor.redactText(`token=${jwt};`)).toBe(
    `token=${PROVIDER_ERROR_REDACTION};`,
  )
  expect(redactor.redactText(`x-${jwt}`)).toBe(`x-${PROVIDER_ERROR_REDACTION}`)
  expect(redactor.redactText(unicodeEscape(jwt))).toBe(PROVIDER_ERROR_REDACTION)
})

test('the JWT shape scan stays linear on a long run of JWT-like starts', () => {
  const redactor = ownRedactor([])
  // Each 'eyJ' is a possible token start, but the input has no dot delimiter.
  // An unbounded regular expression can scan the entire remaining suffix at
  // each start before rejecting it, causing quadratic work. The scanner must
  // advance once through this long input instead of revisiting each suffix.
  const pathological = 'eyJ-'.repeat(64 * 1024)
  const start = performance.now()
  expect(redactor.redactText(pathological)).toBe(pathological)
  expect(performance.now() - start).toBeLessThan(1000)
})

test('zero-length chunks in a non-2xx body do not stop the body from completing', async () => {
  let pulls = 0
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++
        if (pulls <= 100_000) controller.enqueue(new Uint8Array(0))
        else if (pulls === 100_001)
          controller.enqueue(encoder.encode(`late ${RELAY_CREDENTIAL}`))
        else controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'http')
  const text = decoder.decode(
    await readAll(
      scope.redactResponse(new Response(source, { status: 500 })).body,
    ),
  )
  expect(text).toBe(`late ${PROVIDER_ERROR_REDACTION}`)
})

test('one merged span covers a credential found inside a longer credential shape', () => {
  // The exact key is a piece of the JWT; replacing it first would leave the
  // rest of the token behind.
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl'
  const redactor = ownRedactor(['OiJzeW50'])
  expect(redactor.redactText(`a ${jwt} b`)).toBe(
    `a ${PROVIDER_ERROR_REDACTION} b`,
  )
  expect(redactor.redactText(`Bearer ${jwt}`)).toBe(
    `Bearer ${PROVIDER_ERROR_REDACTION}`,
  )
})

test('escape-decoded matches replace exactly the escapes that spell the credential', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const half = RELAY_CREDENTIAL.length / 2
  const mixed = `${RELAY_CREDENTIAL.slice(0, half)}${unicodeEscape(RELAY_CREDENTIAL.slice(half))}`
  expect(
    redactor.redactText(`{"a":"x\\n${mixed}\\u00e9","b":"\\\\u0041"}`),
  ).toBe(`{"a":"x\\n${PROVIDER_ERROR_REDACTION}\\u00e9","b":"\\\\u0041"}`)
  // An escaped backslash is not an escape introducer for what follows.
  expect(redactor.redactText(`\\\\${unicodeEscape(RELAY_CREDENTIAL)}`)).toBe(
    `\\\\${PROVIDER_ERROR_REDACTION}`,
  )
})

test('projections keep what fetch and AI SDK classifiers read: built-in TypeError, cause codes, APICallError markers', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  // The AI SDK's handleFetchError treats a failure as a retryable network
  // error only when it is `instanceof TypeError` with the exact message
  // 'fetch failed', or when its cause chain holds an Error with a network
  // code, so the projection must keep all three.
  const fetchFailure = new TypeError('fetch failed', {
    cause: Object.assign(new Error(`connect ${RELAY_CREDENTIAL}`), {
      code: 'ECONNRESET',
    }),
  })
  const fetchResult = instance(redactor.redactError(fetchFailure), TypeError)
  expect(fetchResult.message).toBe('fetch failed')
  const cause = instance(fetchResult.cause, Error)
  expect(own(cause, 'code')).toBe('ECONNRESET')
  expect(cause.message).toBe(`connect ${PROVIDER_ERROR_REDACTION}`)

  // APICallError.isInstance recognizes an error by an own property keyed by
  // Symbol.for('vercel.ai.error.AI_APICallError') holding true; the
  // projection must keep that marker (and the base AI SDK one) for retries
  // to classify it, while dropping URL, request and response bodies.
  const marker = Symbol.for('vercel.ai.error.AI_APICallError')
  const base = Symbol.for('vercel.ai.error')
  const apiCall = Object.assign(new Error(`limited ${RELAY_CREDENTIAL}`), {
    name: 'AI_APICallError',
    statusCode: 429,
    isRetryable: true,
    responseHeaders: { 'retry-after': '2', 'x-echo': RELAY_CREDENTIAL },
    url: `https://api.example.test/?key=${RELAY_CREDENTIAL}`,
    requestBodyValues: { token: RELAY_CREDENTIAL },
    responseBody: `{"error":"${RELAY_CREDENTIAL}"}`,
    data: { token: RELAY_CREDENTIAL },
    [marker]: true,
    [base]: true,
    [Symbol.for('vercel.ai.error.Other')]: true,
  })
  const result = instance(redactor.redactError(apiCall), Error)
  expect(own(result, marker)).toBe(true)
  expect(own(result, base)).toBe(true)
  expect(result.name).toBe('AI_APICallError')
  expect(own(result, 'statusCode')).toBe(429)
  expect(own(result, 'isRetryable')).toBe(true)
  expect(own(result, 'responseHeaders')).toEqual({
    'retry-after': '2',
    'x-echo': PROVIDER_ERROR_REDACTION,
  })
  for (const key of ['url', 'requestBodyValues', 'responseBody', 'data'])
    expect(Object.hasOwn(result, key)).toBe(false)
  expect(
    Object.getOwnPropertySymbols(result).map((symbol) => symbol.description),
  ).toEqual(['vercel.ai.error', 'vercel.ai.error.AI_APICallError'].sort())

  // The marker is copied only from an own data property holding exactly
  // true: a getter is never run, and a string 'true' does not count.
  let ran = 0
  const lying = new Error('x')
  Object.defineProperty(lying, marker, {
    get() {
      ran++
      return true
    },
  })
  Object.defineProperty(lying, base, { value: 'true' })
  const lyingResult = instance(redactor.redactError(lying), Error)
  expect(ran).toBe(0)
  expect(Object.getOwnPropertySymbols(lyingResult)).toEqual([])
})

test('projections keep 429, overload and context-overflow envelopes and retry hints', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const overflow = {
    status: 400,
    error: {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `prompt is too long: 250000 tokens > 200000 maximum (${RELAY_CREDENTIAL})`,
      },
    },
  }
  expect(redactor.redactError(overflow)).toEqual({
    status: 400,
    error: {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `prompt is too long: 250000 tokens > 200000 maximum (${PROVIDER_ERROR_REDACTION})`,
      },
    },
  })
  const limited = Object.assign(new Error('rate limited'), {
    status: 429,
    retryAfter: 17,
    headers: new Headers({
      'retry-after': '17',
      'anthropic-ratelimit-unified-status': 'rejected',
    }),
    error: { type: 'error', error: { type: 'rate_limit_error' } },
  })
  const result = instance(redactor.redactError(limited), Error)
  expect(own(result, 'status')).toBe(429)
  expect(own(result, 'retryAfter')).toBe(17)
  expect(own(result, 'headers')).toEqual({
    'anthropic-ratelimit-unified-status': 'rejected',
    'retry-after': '17',
  })
  expect(own(result, 'error')).toEqual({
    type: 'error',
    error: { type: 'rate_limit_error' },
  })
  // Keep only numeric integer statuses in the supported 0–999 range.
  for (const status of [Number.NaN, 4e3, '429', 429.5])
    expect(
      Object.hasOwn(Object(redactor.redactError({ status })), 'status'),
    ).toBe(false)
})

/**
 * The error has own fields for the failed WebSocket operation and close
 * code, beside a close reason that may echo the credential.
 */
class WebSocketResetError extends Error {
  readonly code = 'ECONNRESET'
  readonly syscall = 'websocket'
  readonly closeCode?: number
  readonly closeReason?: string
  readonly wasClean?: boolean
  constructor(message: string, event?: CloseEvent) {
    super(message)
    this.name = 'RelayWebSocketConnectionResetError'
    this.closeCode = event?.code
    this.closeReason = event?.reason
    this.wasClean = event?.wasClean
  }
}

test('a websocket reset failing a wrapped stream keeps its closed transport metadata, not the close reason', async () => {
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
  let sent = false
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(encoder.encode(SUCCESS_FRAME))
          return
        }
        throw new WebSocketResetError(
          'relay websocket closed during response stream',
          new CloseEvent('close', {
            code: 1006,
            reason: `peer said ${RELAY_CREDENTIAL}`,
            wasClean: false,
          }),
        )
      },
    },
    { highWaterMark: 0 },
  )
  const reader = scope
    .redactResponse(new Response(source, { status: 200 }))
    .body?.getReader()
  if (!reader) throw new Error('missing body')
  deferCleanup(() => reader.cancel().catch(() => {}))
  expect(decoder.decode((await reader.read()).value)).toBe(SUCCESS_FRAME)
  const failure = instance(
    await reader.read().catch((error: unknown) => error),
    Error,
  )
  // Each field checked on its own descriptor: printing the error does not
  // show own properties, so a missing field would otherwise go unnoticed.
  expect(own(failure, 'code')).toBe('ECONNRESET')
  expect(own(failure, 'syscall')).toBe('websocket')
  expect(own(failure, 'closeCode')).toBe(1006)
  expect(own(failure, 'wasClean')).toBe(false)
  expect(failure.message).toBe('relay websocket closed during response stream')
  expect(failure.name).toBe('RelayWebSocketConnectionResetError')
  expect(failure).toMatchObject({
    code: 'ECONNRESET',
    syscall: 'websocket',
    closeCode: 1006,
  })
  // No consumer reads the close reason, and it is provider text.
  expect(Object.hasOwn(failure, 'closeReason')).toBe(false)
  expect(await exposes(failure, RELAY_CREDENTIAL)).toBe(false)
  expect(await settlementNow(scope)).toBe('error')
})

test('transport metadata outside its closed form is dropped without running getters', async () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  let ran = 0
  const hostile = new Error('closed')
  Object.defineProperty(hostile, 'closeCode', {
    get() {
      ran++
      return 1006
    },
  })
  Object.defineProperty(hostile, 'wasClean', {
    get() {
      ran++
      return true
    },
  })
  Object.assign(hostile, { syscall: 'websocket', code: 'ECONNRESET' })
  const fromGetters = instance(redactor.redactError(hostile), Error)
  expect(ran).toBe(0)
  expect(own(fromGetters, 'syscall')).toBe('websocket')
  expect(Object.hasOwn(fromGetters, 'closeCode')).toBe(false)
  expect(Object.hasOwn(fromGetters, 'wasClean')).toBe(false)

  for (const [field, value] of [
    ['syscall', RELAY_CREDENTIAL],
    ['syscall', `websocket ${RELAY_CREDENTIAL}`],
    ['syscall', 'websocket-extra'],
    ['syscall', 42],
    ['closeCode', 999],
    ['closeCode', 5000],
    ['closeCode', 1006.5],
    ['closeCode', '1006'],
    ['wasClean', 'false'],
    ['wasClean', 0],
  ] as const) {
    const result = instance(
      redactor.redactError(
        Object.assign(new Error('closed'), { [field]: value }),
      ),
      Error,
    )
    if (Object.hasOwn(result, field))
      throw new Error(`${field}=${String(value)} survived the projection`)
    expect(await exposes(result, RELAY_CREDENTIAL)).toBe(false)
  }
  // Withhold WebSocket transport fields when the error is backed by a proxy.
  let traps = 0
  const proxied = Object.assign(new Error('closed'), {
    syscall: 'websocket',
    closeCode: 1006,
  })
  Object.setPrototypeOf(
    proxied,
    new Proxy(Error.prototype, {
      getPrototypeOf() {
        traps++
        return null
      },
    }),
  )
  const withheld = instance(redactor.redactError(proxied), Error)
  expect(traps).toBe(0)
  expect(Object.hasOwn(withheld, 'syscall')).toBe(false)
  expect(Object.hasOwn(withheld, 'closeCode')).toBe(false)
})

/** A Bearer-shaped credential not included in the current scope's credentials. */
const OLDER_TOKEN = 'Qx7Lm2Vb9Kr4Wd1Zp8Hs6Ta3'

test('an error frame cannot split an unknown Bearer token from its scheme across data lines', async () => {
  const frame = `event: error\ndata: Bearer\ndata: ${OLDER_TOKEN}\n\n`
  const scope = ownResponseScope([RELAY_CREDENTIAL], 'event-stream')
  const text = decoder.decode(
    await readAll(
      scope.redactResponse(eventStream([encoder.encode(frame)]).response).body,
    ),
  )
  expect(text).toBe(
    `event: error\ndata: Bearer\ndata: ${PROVIDER_ERROR_REDACTION}\n\n`,
  )
  expect(await settlementNow(scope)).toBe('eof')
  const relay = decoder.decode(
    feedScope([RELAY_CREDENTIAL], [encoder.encode(frame)]),
  )
  expect(relay).not.toContain(OLDER_TOKEN)
  // The same lines in a successful frame are model output and stay exact.
  const success = encoder.encode(
    `event: content_block_delta\ndata: {"type":"content_block_delta",\ndata: "delta":{"type":"text_delta","text":"Bearer ${OLDER_TOKEN}"}}\n\ndata: Bearer\ndata: ${OLDER_TOKEN}\n\n`,
  )
  expect([...feedScope([RELAY_CREDENTIAL], [success])]).toEqual([...success])
})

test('an exact numeric credential in an error JSON body or frame is not re-emitted as a JSON number', async () => {
  const secret = '4242424242424242'
  const data = `{"type":"error","error":{"type":"api_error","message":"x"},"acct":${secret}}`
  const http = ownResponseScope([secret], 'http')
  const body = decoder.decode(
    await readAll(
      http.redactResponse(new Response(data, { status: 400 })).body,
    ),
  )
  expect(body).not.toContain(secret)
  expect(JSON.parse(body)).toEqual({
    type: 'error',
    error: { type: 'api_error', message: 'x' },
    acct: PROVIDER_ERROR_REDACTION,
  })
  const stream = ownResponseScope([secret], 'event-stream')
  const frame = decoder.decode(
    await readAll(
      stream.redactResponse(
        eventStream([encoder.encode(`event: error\ndata: ${data}\n\n`)])
          .response,
      ).body,
    ),
  )
  expect(frame).not.toContain(secret)
  expect(frame).toContain('"type":"api_error"')
  // In a thrown value, a number equal to the credential is left out of the
  // projection; other numbers are kept.
  const redactor = ownRedactor([secret])
  const projected = redactor.redactError({
    status: 429,
    code: Number(secret),
    retryAfter: Number(secret),
  })
  expect(projected).toEqual({ status: 429 })
})

test('own request id strings survive the projection; accessors, proxies, credentials and free text do not', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  expect(
    redactor.redactError({
      status: 429,
      request_id: 'req_011',
      requestID: 'req_012',
      error: { type: 'rate_limit_error', message: 'busy' },
    }),
  ).toEqual({
    status: 429,
    request_id: 'req_011',
    requestID: 'req_012',
    error: { type: 'rate_limit_error', message: 'busy' },
  })
  const sdkStyle = instance(
    redactor.redactError(
      Object.assign(new Error('limited'), { requestID: 'req_013' }),
    ),
    Error,
  )
  expect(own(sdkStyle, 'requestID')).toBe('req_013')

  let ran = 0
  const accessor = new Error('x')
  Object.defineProperty(accessor, 'request_id', {
    get() {
      ran++
      return 'req_014'
    },
  })
  expect(
    Object.hasOwn(Object(redactor.redactError(accessor)), 'request_id'),
  ).toBe(false)
  expect(ran).toBe(0)
  for (const value of [
    RELAY_CREDENTIAL,
    `req_${RELAY_CREDENTIAL}`,
    'req 011',
    'r'.repeat(129),
    42,
  ])
    for (const key of ['request_id', 'requestID'])
      expect(
        Object.hasOwn(Object(redactor.redactError({ [key]: value })), key),
      ).toBe(false)
  const proxied = { request_id: 'req_015' }
  Object.setPrototypeOf(
    proxied,
    new Proxy(Object.prototype, {
      getPrototypeOf() {
        ran++
        return null
      },
    }),
  )
  const withheld = redactor.redactError(proxied)
  expect(ran).toBe(0)
  expect(Object.hasOwn(Object(withheld), 'request_id')).toBe(false)
})

test('a credential that only appears across JSON structure falls back to the known error type', async () => {
  // Each JSON value is clean on its own, so scrubbing the values cannot
  // remove this credential; the redactor checks the re-serialized body text
  // for it again before returning that text.
  const secret = '1,"retry'
  const body =
    '{"type":"error","error":{"type":"overloaded_error"},"a":1,"retry":2}'
  const scope = ownResponseScope([secret], 'http')
  const result = scope.redactResponse(new Response(body, { status: 529 }))
  const text = decoder.decode(await readAll(result.body))
  expect(text).not.toContain(secret)
  expect(result.status).toBe(529)
  expect(JSON.parse(text)).toEqual({
    type: 'error',
    error: {
      type: 'overloaded_error',
      message: 'Provider error could not be inspected safely',
    },
  })
})

/** Rewrite one SSE frame through a fresh event-stream scope and the relay scope. */
async function rewriteBoth(
  secrets: readonly string[],
  frame: string,
): Promise<string> {
  const scope = ownResponseScope(secrets, 'event-stream')
  const wrapped = decoder.decode(
    await readAll(
      scope.redactResponse(eventStream([encoder.encode(frame)]).response).body,
    ),
  )
  const relay = decoder.decode(feedScope(secrets, [encoder.encode(frame)]))
  expect(relay).toBe(wrapped)
  return wrapped
}

test('a rebuilt error frame never copies a retry value that spells the credential', async () => {
  const secret = '4242424242424242'
  const data = '{"type":"error","error":{"type":"api_error","message":"busy"}}'
  for (const retry of [secret, `0${secret}`, `${secret}0`]) {
    const out = await rewriteBoth(
      [secret],
      `event: error\nretry: ${retry}\ndata: ${data}\n\n`,
    )
    expect(out).not.toContain(secret)
    // Only the retry line goes; the event and its classification stay.
    expect(out).toBe(`event: error\ndata: ${data}\n\n`)
  }
  // A valid retry next to a scrubbed credential is kept as it was.
  expect(
    await rewriteBoth(
      [RELAY_CREDENTIAL],
      `event: error\nretry: 1500\ndata: {"type":"error","error":{"type":"api_error","message":"${RELAY_CREDENTIAL}"}}\n\n`,
    ),
  ).toBe(
    `event: error\nretry: 1500\ndata: {"type":"error","error":{"type":"api_error","message":"${PROVIDER_ERROR_REDACTION}"}}\n\n`,
  )
  // A clean error frame with a retry is not rebuilt at all.
  const clean = `event: error\r\nretry: 1500\r\n: note\r\ndata: ${data}\r\n\r\n`
  expect(await rewriteBoth([secret], clean)).toBe(clean)
})

test('event and id values of a rebuilt error frame are scrubbed, escaped spellings included', async () => {
  const data = '{"type":"error","error":{"type":"api_error","message":"busy"}}'
  for (const [field, value] of [
    ['id', RELAY_CREDENTIAL],
    ['id', unicodeEscape(RELAY_CREDENTIAL)],
    ['event', `error ${RELAY_CREDENTIAL}`],
    ['event', `error ${unicodeEscape(RELAY_CREDENTIAL)}`],
  ] as const) {
    const out = await rewriteBoth(
      [RELAY_CREDENTIAL],
      `${field}: ${value}\ndata: ${data}\n\n`,
    )
    expect(decodeEscapes(out)).not.toContain(RELAY_CREDENTIAL)
    expect(out).toContain(`data: ${data}`)
  }
})

test('a rebuilt error frame that still spells a credential across its lines is replaced by a generic error', async () => {
  // A contrived credential that spans the event and id lines: each field is
  // clean on its own, so only a check of the rebuilt bytes can catch it.
  const secret = 'error\nid: 7'
  const out = await rewriteBoth(
    [secret],
    'event: error\nid: 7\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
  )
  expect(out).not.toContain(secret)
  expect(out.startsWith('event: error\n')).toBe(true)
  const payload = JSON.parse(out.split('\n')[1]?.slice('data: '.length) ?? '')
  expect(payload).toEqual({
    type: 'error',
    error: {
      type: 'overloaded_error',
      message: 'Provider error could not be inspected safely',
    },
  })
})

test('after dispose only the closed list of retry and quota header names survives; a name embedding the credential does not', async () => {
  const redactor = createProviderErrorRedactor([RELAY_CREDENTIAL])
  redactor.dispose()
  const kept: Array<[string, string]> = [
    ['anthropic-ratelimit-unified-5h-reset', '1790000000'],
    ['anthropic-ratelimit-unified-5h-status', 'allowed_warning'],
    ['anthropic-ratelimit-unified-5h-utilization', '0.98'],
    ['anthropic-ratelimit-unified-7d-reset', '1790500000'],
    ['anthropic-ratelimit-unified-7d-status', 'allowed'],
    ['anthropic-ratelimit-unified-7d-utilization', '0.4'],
    ['anthropic-ratelimit-unified-fallback', 'available'],
    ['anthropic-ratelimit-unified-representative-claim', 'five_hour'],
    ['anthropic-ratelimit-unified-status', 'rejected'],
    ['retry-after', '7'],
    ['x-should-retry', 'true'],
  ]
  const original = new Response('failure', {
    status: 429,
    headers: [
      ...kept,
      // The credential can sit in the middle of a name whose prefix and
      // suffix look like a quota field, with a value that passes the check.
      [`anthropic-ratelimit-unified-${RELAY_CREDENTIAL}-reset`, '1'],
      [`anthropic-ratelimit-unified-${RELAY_CREDENTIAL}-status`, 'allowed'],
      [`anthropic-ratelimit-unified-${RELAY_CREDENTIAL}-utilization`, '0.5'],
      [`anthropic-ratelimit-unified-${RELAY_CREDENTIAL}-percentage`, '0.5'],
      // Names outside the verifiable retry/quota allowlist are withheld,
      // even when they are valid HTTP header names.
      ['anthropic-ratelimit-unified-reset', '1790000000'],
      ['anthropic-ratelimit-unified-fallback-percentage', '0.5'],
      ['anthropic-ratelimit-unified-overage-status', 'rejected'],
      ['request-id', 'req_011'],
    ],
  })
  const result = redactor.redactResponse(original)
  expect(result.status).toBe(429)
  expect(JSON.stringify([...result.headers])).not.toContain(RELAY_CREDENTIAL)
  expect([...result.headers].sort()).toEqual(
    [...kept, ['content-type', 'application/json'] as [string, string]].sort(),
  )
  expect(JSON.parse(decoder.decode(await readAll(result.body)))).toEqual({
    type: 'error',
    error: { message: PROVIDER_ERROR_WITHHELD_MESSAGE },
  })

  // Successful responses are still handed back untouched after dispose.
  const success = new Response('normal model output', {
    headers: {
      [`anthropic-ratelimit-unified-${RELAY_CREDENTIAL}-reset`]: '1',
      'request-id': 'req_011',
    },
  })
  expect(redactor.redactResponse(success)).toBe(success)
  expect(await success.text()).toBe('normal model output')
})

test('after dispose a real HTTP failure echoing the sent token in a quota header name keeps only status and retry hints', async () => {
  // The server copies the bearer token it received into a header name
  // shaped like a quota reset field, as a hostile or broken relay could.
  let requests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests += 1
      const sent = (request.headers.get('authorization') ?? '').slice(
        'Bearer '.length,
      )
      return new Response('failure', {
        status: 400,
        headers: {
          [`anthropic-ratelimit-unified-${sent}-reset`]: '1',
          'retry-after': '7',
        },
      })
    },
  })
  deferCleanup(() => server.stop(true))
  const redactor = createProviderErrorRedactor([OAUTH_TOKEN])
  const original = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
    headers: { authorization: `Bearer ${OAUTH_TOKEN}` },
  })
  // Header names reach the client lower-cased.
  const echoed = OAUTH_TOKEN.toLowerCase()
  expect(JSON.stringify([...original.headers])).toContain(echoed)
  redactor.dispose()
  const result = redactor.redactResponse(original)
  expect(requests).toBe(1)
  expect(result.status).toBe(400)
  expect(result.headers.get('retry-after')).toBe('7')
  expect(JSON.stringify([...result.headers]).toLowerCase()).not.toContain(
    echoed,
  )
  expect(decoder.decode(await readAll(result.body))).not.toContain(OAUTH_TOKEN)
})

/** The fixed text that replaces a projected text field over the byte budget. */
const OVERSIZED_DETAIL =
  'Provider error details exceeded the redaction size limit and were withheld'

/**
 * Own keys Bun adds to every Error object it constructs, recording the
 * line, column and source file of the `new Error()` call. Their size does
 * not depend on the projected data, so `projectedTextBytes` excludes them.
 */
const RUNTIME_ERROR_KEYS: ReadonlySet<PropertyKey> = new Set([
  'line',
  'column',
  'sourceURL',
  'originalLine',
  'originalColumn',
])

/**
 * UTF-8 bytes of every string key and string value reachable through own
 * data properties of a projection, `message` and `stack` included. Array
 * index keys and `length` are not text the projection chose, so only array
 * values are counted.
 */
function projectedTextBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return encoder.encode(value).length
  if (value === null || typeof value !== 'object' || seen.has(value)) return 0
  seen.add(value)
  let total = 0
  const array = Array.isArray(value)
  for (const key of Reflect.ownKeys(value)) {
    if (RUNTIME_ERROR_KEYS.has(key)) continue
    if (typeof key === 'string' && !array) total += encoder.encode(key).length
    total += projectedTextBytes(own(value, key), seen)
  }
  return total
}

/** Read the projected error's own stack value without invoking an accessor. */
function ownStack(value: unknown): unknown {
  return own(value, 'stack')
}

test('a 2 MiB thrown message becomes a fixed generic message while type and classification fields stay', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const marker = Symbol.for('vercel.ai.error.AI_APICallError')
  const base = Symbol.for('vercel.ai.error')
  const huge = Object.assign(
    new TypeError(`${'x'.repeat(2 * 1024 * 1024)} ${RELAY_CREDENTIAL}`),
    {
      statusCode: 429,
      isRetryable: true,
      code: 'ECONNRESET',
      responseHeaders: { 'retry-after': '2' },
      cause: Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
      [marker]: true,
      [base]: true,
    },
  )
  const result = instance(redactor.redactError(huge), TypeError)
  expect(Object.getOwnPropertyDescriptor(result, 'message')?.value).toBe(
    OVERSIZED_DETAIL,
  )
  expect(own(result, 'statusCode')).toBe(429)
  expect(own(result, 'isRetryable')).toBe(true)
  expect(own(result, 'code')).toBe('ECONNRESET')
  expect(own(result, 'responseHeaders')).toEqual({ 'retry-after': '2' })
  expect(own(instance(result.cause, Error), 'code')).toBe('ECONNRESET')
  expect(own(result, marker)).toBe(true)
  expect(own(result, base)).toBe(true)
  expect(ownStack(result)).toBe(`TypeError: ${OVERSIZED_DETAIL}`)
  expect(projectedTextBytes(result)).toBeLessThanOrEqual(
    PROVIDER_ERROR_MAX_BODY_BYTES,
  )

  // A thrown string and a string cause are bounded the same way.
  expect(redactor.redactError('y'.repeat(2 * 1024 * 1024))).toBe(
    OVERSIZED_DETAIL,
  )
  // Multi-byte text is measured in UTF-8 bytes, not UTF-16 units.
  const wide = instance(
    redactor.redactError(new Error('é'.repeat(600 * 1024))),
    Error,
  )
  expect(wide.message).toBe(OVERSIZED_DETAIL)
})

test('a message that fits the byte budget is kept, scrubbed and exact up to the limit', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const half = `${'z'.repeat(512 * 1024)} ${RELAY_CREDENTIAL}`
  const halfResult = instance(redactor.redactError(new Error(half)), Error)
  expect(halfResult.message).toBe(
    `${'z'.repeat(512 * 1024)} ${PROVIDER_ERROR_REDACTION}`,
  )
  // Repeating the message in the stack exceeds the budget, so only
  // the error name remains.
  expect(ownStack(halfResult)).toBe('Error')
  // The `message` and `stack` keys are charged first (12 bytes); a message
  // of exactly the rest is kept, with no room left for any stack text.
  const exact = 'a'.repeat(PROVIDER_ERROR_MAX_BODY_BYTES - 12)
  const exactResult = instance(redactor.redactError(new Error(exact)), Error)
  expect(exactResult.message).toBe(exact)
  expect(ownStack(exactResult)).toBe('')
  expect(projectedTextBytes(exactResult)).toBe(PROVIDER_ERROR_MAX_BODY_BYTES)
  const over = instance(redactor.redactError(new Error(`${exact}a`)), Error)
  expect(over.message).toBe(OVERSIZED_DETAIL)
  expect(ownStack(over)).toBe(`Error: ${OVERSIZED_DETAIL}`)
})

test('large and aggregate header values in a projection share the byte budget', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const value = 'h'.repeat(300 * 1024)
  // One oversized header is dropped; the retry hint beside it stays.
  const single = redactor.redactError(
    Object.assign(new Error('limited'), {
      status: 429,
      headers: { 'x-huge': 'v'.repeat(2 * 1024 * 1024), 'retry-after': '3' },
    }),
  )
  expect(own(single, 'headers')).toEqual({ 'retry-after': '3' })
  expect(own(single, 'status')).toBe(429)

  // Many large headers, in a record and in platform Headers, together never
  // exceed the budget; the entries that do not fit are dropped whole.
  const aggregate = redactor.redactError(
    Object.assign(new Error('limited'), {
      responseHeaders: Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [`x-big-${index}`, value]),
      ),
      headers: new Headers(
        Array.from({ length: 6 }, (_, index) => [`x-platform-${index}`, value]),
      ),
    }),
  )
  const headers = own(aggregate, 'headers')
  expect(Object.keys(headers as object)).toEqual([
    'x-platform-0',
    'x-platform-1',
    'x-platform-2',
  ])
  expect(own(headers, 'x-platform-0')).toBe(value)
  expect(own(aggregate, 'responseHeaders')).toEqual({})
  expect(projectedTextBytes(aggregate)).toBeLessThanOrEqual(
    PROVIDER_ERROR_MAX_BODY_BYTES,
  )

  // Nested causes and aggregate members draw on the same budget, and each
  // member's stack line is charged too: the first member keeps its message
  // and full stack, the second its message with the name as stack, and the
  // rest get the fixed generic message.
  const members = Array.from(
    { length: 5 },
    (_, index) => new Error(`${index}${'m'.repeat(300 * 1024)}`),
  )
  const many = instance(
    redactor.redactError(new AggregateError(members, 'all failed')),
    AggregateError,
  )
  const kept = many.errors.map((error) => instance(error, Error))
  const messages = kept.map((error) => error.message)
  expect(messages[0]?.length).toBe(300 * 1024 + 1)
  expect(messages[1]?.length).toBe(300 * 1024 + 1)
  expect(messages.slice(2)).toEqual([
    OVERSIZED_DETAIL,
    OVERSIZED_DETAIL,
    OVERSIZED_DETAIL,
  ])
  expect(ownStack(kept[0])).toBe(`Error: ${messages[0]}`)
  expect(ownStack(kept[1])).toBe('Error')
  expect(ownStack(many)).toBe('AggregateError: all failed')
  expect(projectedTextBytes(many)).toBeLessThanOrEqual(
    PROVIDER_ERROR_MAX_BODY_BYTES,
  )
})

test('a real Headers object with many fields is walked only up to the key limit and keeps its retry metadata', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const headers = new Headers({
    'retry-after': '17',
    'anthropic-ratelimit-unified-status': 'rejected',
  })
  for (let index = 0; index < 5000; index += 1)
    headers.append(`x-fill-${String(index).padStart(4, '0')}`, 'f')
  const response = new Response(null, { status: 429, headers })
  const result = redactor.redactError(
    Object.assign(new Error('limited'), {
      status: 429,
      headers,
      response,
    }),
  )
  expect(own(result, 'status')).toBe(429)
  // The Fetch API's Headers iterator sorts names. Retry and quota names
  // precede the filler names, so they survive the 1000-entry limit.
  for (const record of [
    own(result, 'headers'),
    own(own(result, 'response'), 'headers'),
  ]) {
    expect(Object.keys(record as object).length).toBe(1000)
    expect(own(record, 'retry-after')).toBe('17')
    expect(own(record, 'anthropic-ratelimit-unified-status')).toBe('rejected')
    expect(own(record, 'x-fill-0997')).toBe('f')
    expect(Object.hasOwn(record as object, 'x-fill-0998')).toBe(false)
  }
  expect(own(own(result, 'response'), 'status')).toBe(429)
  expect(projectedTextBytes(result)).toBeLessThanOrEqual(
    PROVIDER_ERROR_MAX_BODY_BYTES,
  )
})

test('header names that are scanned and dropped for carrying the credential still use up the budget', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const filler = 'n'.repeat(330 * 1024)
  const result = redactor.redactError(
    Object.assign(new Error('limited'), {
      headers: new Headers(
        Array.from({ length: 3 }, (_, index) => [
          `x-${RELAY_CREDENTIAL}-${filler}-${index}`,
          'v',
        ]),
      ),
      responseHeaders: {
        'retry-after': '3',
        'x-later': 'l'.repeat(100 * 1024),
      },
    }),
  )
  expect(own(result, 'headers')).toEqual({})
  // Scanning the three credential-bearing header names consumes about
  // 990 KiB of the byte budget. The later 100 KiB value cannot fit, but
  // the short retry hint can.
  expect(own(result, 'responseHeaders')).toEqual({ 'retry-after': '3' })
  expect(JSON.stringify(result)).not.toContain(RELAY_CREDENTIAL)
})

test('a projected error stack is one fresh line inside the budget, never the runtime stack', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const fetchFailure = instance(
    redactor.redactError(new TypeError(`fetch failed ${RELAY_CREDENTIAL}`)),
    TypeError,
  )
  expect(ownStack(fetchFailure)).toBe(
    `TypeError: fetch failed ${PROVIDER_ERROR_REDACTION}`,
  )
  const bare = instance(redactor.redactError(new RangeError()), RangeError)
  expect(ownStack(bare)).toBe('RangeError')
  const dom = instance(
    redactor.redactError(new DOMException('aborted', 'AbortError')),
    Error,
  )
  expect(dom.name).toBe('AbortError')
  expect(ownStack(dom)).toBe('Error: aborted')

  // Repeating the 700 KiB message in the stack exceeds the 1 MiB projection
  // limit. Keep the message once and only the error name in the stack.
  const large = 's'.repeat(700 * 1024)
  const kept = instance(redactor.redactError(new Error(large)), Error)
  expect(kept.message).toBe(large)
  expect(ownStack(kept)).toBe('Error')
  expect(projectedTextBytes(kept)).toBeLessThanOrEqual(
    PROVIDER_ERROR_MAX_BODY_BYTES,
  )
})

/** An AI SDK APICallError-shaped error: own classification fields and markers. */
function apiCallError(message: string): Error {
  return Object.assign(new Error(message), {
    name: 'AI_APICallError',
    statusCode: 429,
    isRetryable: true,
    code: 'ECONNRESET',
    [Symbol.for('vercel.ai.error')]: true,
    [Symbol.for('vercel.ai.error.AI_APICallError')]: true,
  })
}

/** Check the APICallError name, status, retry flag, transport code and SDK markers. */
function expectApiCallClassification(value: unknown): void {
  expect(own(value, 'name')).toBe('AI_APICallError')
  expect(own(value, 'statusCode')).toBe(429)
  expect(own(value, 'isRetryable')).toBe(true)
  expect(own(value, 'code')).toBe('ECONNRESET')
  expect(own(value, Symbol.for('vercel.ai.error'))).toBe(true)
  expect(own(value, Symbol.for('vercel.ai.error.AI_APICallError'))).toBe(true)
}

test('an APICallError with a message at or near the byte limit keeps its status, retry flag, code and markers', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  // Near the limit: the short fields are charged first and the message
  // still fits after them, so it is kept whole.
  const near = 'x'.repeat(PROVIDER_ERROR_MAX_BODY_BYTES - 400)
  const nearResult = instance(redactor.redactError(apiCallError(near)), Error)
  expectApiCallClassification(nearResult)
  expect(nearResult.message).toBe(near)
  expect(projectedTextBytes(nearResult)).toBeLessThanOrEqual(
    PROVIDER_ERROR_MAX_BODY_BYTES,
  )
  // A message within 100 bytes of the limit leaves no room for classification
  // fields if copied first. Keep those fields and replace the message with
  // the fixed oversized-detail text.
  for (const length of [
    PROVIDER_ERROR_MAX_BODY_BYTES - 100,
    PROVIDER_ERROR_MAX_BODY_BYTES - 12,
    PROVIDER_ERROR_MAX_BODY_BYTES,
  ]) {
    const result = instance(
      redactor.redactError(apiCallError('x'.repeat(length))),
      Error,
    )
    expectApiCallClassification(result)
    expect(result.message).toBe(OVERSIZED_DETAIL)
    expect(ownStack(result)).toBe(`Error: ${OVERSIZED_DETAIL}`)
  }
})

test('aggregate members each keep their classification while their large messages share the budget', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const members = Array.from({ length: 4 }, (_, index) =>
    apiCallError(`${index}${'m'.repeat(400 * 1024)}`),
  )
  const result = instance(
    redactor.redactError(
      Object.assign(new AggregateError(members, 'all attempts failed'), {
        status: 429,
      }),
    ),
    AggregateError,
  )
  expect(own(result, 'status')).toBe(429)
  const kept = result.errors.map((error) => instance(error, Error))
  for (const member of kept) expectApiCallClassification(member)
  expect(kept[0]?.message.length).toBe(400 * 1024 + 1)
  expect(kept.slice(1).map((member) => member.message)).toEqual([
    OVERSIZED_DETAIL,
    OVERSIZED_DETAIL,
    OVERSIZED_DETAIL,
  ])
  expect(projectedTextBytes(result)).toBeLessThanOrEqual(
    PROVIDER_ERROR_MAX_BODY_BYTES,
  )
})

/**
 * Queue a credential-bearing chunk, then error the stream after reading
 * starts. `failure` can be the relay's oversized-source sentinel or a forged
 * look-alike; the reader must recognize only the constructor-owned sentinel.
 */
function erroredSource(failure: unknown) {
  let control: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller
      controller.enqueue(encoder.encode(`{"leak":"${RELAY_CREDENTIAL}"}`))
    },
  })
  return {
    stream,
    fail: () => control?.error(failure),
  }
}

const OVERSIZED_JSON = {
  type: 'error',
  error: { message: PROVIDER_ERROR_OVERSIZED_MESSAGE },
}

function failingResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 401,
    headers: {
      'content-type': 'text/plain',
      'retry-after': '5',
      'x-echo': RELAY_CREDENTIAL,
    },
  })
}

/** Start reading `body`, error its source, then return what the read gave. */
async function readAfterFailure(
  body: ReadableStream<Uint8Array> | null,
  fail: () => void,
): Promise<unknown> {
  const reading = readAll(body).then(
    (bytes) => JSON.parse(decoder.decode(bytes)) as unknown,
    (error: unknown) => error,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  fail()
  return reading
}

test('a body source errored with ProviderErrorSourceOversizedError ends with the fixed oversized JSON, live or disposed', async () => {
  expect(Object.hasOwn(publicApi, 'ProviderErrorSourceOversizedError')).toBe(
    false,
  )
  const cases: Array<
    [string, (response: Response) => { body: Response; dispose(): void }]
  > = [
    [
      'live redactor',
      (response) => {
        const redactor = ownRedactor([RELAY_CREDENTIAL])
        return { body: redactor.redactResponse(response), dispose() {} }
      },
    ],
    [
      'redactor disposed before the response is redacted',
      (response) => {
        const redactor = createProviderErrorRedactor([RELAY_CREDENTIAL])
        redactor.dispose()
        return { body: redactor.redactResponse(response), dispose() {} }
      },
    ],
    [
      'redactor disposed after the response is redacted',
      (response) => {
        const redactor = createProviderErrorRedactor([RELAY_CREDENTIAL])
        return {
          body: redactor.redactResponse(response),
          dispose: () => redactor.dispose(),
        }
      },
    ],
    [
      'response scope disposed after the response is redacted',
      (response) => {
        const scope = createProviderErrorResponseScope(
          [RELAY_CREDENTIAL],
          'http',
        )
        return {
          body: scope.redactResponse(response),
          dispose: () => scope.dispose(),
        }
      },
    ],
  ]
  for (const [label, redact] of cases) {
    const source = erroredSource(new ProviderErrorSourceOversizedError())
    const { body, dispose } = redact(failingResponse(source.stream))
    dispose()
    const outcome = await readAfterFailure(body.body, source.fail)
    expect({ label, outcome }).toEqual({ label, outcome: OVERSIZED_JSON })
    expect(body.status).toBe(401)
    expect(body.headers.get('retry-after')).toBe('5')
    expect(JSON.stringify([...body.headers])).not.toContain(RELAY_CREDENTIAL)
  }

  // Properties on a real instance are never read: only its identity counts.
  let reads = 0
  const decorated = new ProviderErrorSourceOversizedError()
  Object.defineProperty(decorated, 'message', {
    get() {
      reads += 1
      return RELAY_CREDENTIAL
    },
  })
  const redactor = createProviderErrorRedactor([RELAY_CREDENTIAL])
  redactor.dispose()
  const source = erroredSource(decorated)
  const body = redactor.redactResponse(failingResponse(source.stream))
  expect(await readAfterFailure(body.body, source.fail)).toEqual(OVERSIZED_JSON)
  expect(reads).toBe(0)
})

test('look-alikes of ProviderErrorSourceOversizedError are ordinary failures, withheld after dispose, with no getter or trap run', async () => {
  let runs = 0
  const count = () => {
    runs += 1
  }
  const real = new ProviderErrorSourceOversizedError()
  const lookAlikes: Array<[string, unknown]> = [
    [
      'same name, message and a code',
      Object.assign(new Error(PROVIDER_ERROR_OVERSIZED_MESSAGE), {
        name: 'ProviderErrorSourceOversizedError',
        code: 'ERR_BODY_TOO_LARGE',
      }),
    ],
    [
      'same prototype, not constructed',
      Object.create(ProviderErrorSourceOversizedError.prototype),
    ],
    [
      'proxy around a real instance',
      new Proxy(real, {
        get(target, key) {
          count()
          return Reflect.get(target, key)
        },
        getPrototypeOf(target) {
          count()
          return Reflect.getPrototypeOf(target)
        },
        getOwnPropertyDescriptor(target, key) {
          count()
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
        has(target, key) {
          count()
          return Reflect.has(target, key)
        },
        ownKeys(target) {
          count()
          return Reflect.ownKeys(target)
        },
      }),
    ],
    [
      'getters only',
      Object.defineProperties(
        {},
        {
          name: {
            get() {
              count()
              return 'ProviderErrorSourceOversizedError'
            },
          },
          message: {
            get() {
              count()
              return PROVIDER_ERROR_OVERSIZED_MESSAGE
            },
          },
        },
      ),
    ],
  ]
  for (const [label, failure] of lookAlikes) {
    const redactor = createProviderErrorRedactor([RELAY_CREDENTIAL])
    redactor.dispose()
    const source = erroredSource(failure)
    const body = redactor.redactResponse(failingResponse(source.stream))
    const outcome = await readAfterFailure(body.body, source.fail)
    expect({ label, message: instance(outcome, Error).message }).toEqual({
      label,
      message: PROVIDER_ERROR_WITHHELD_MESSAGE,
    })
  }
  expect(runs).toBe(0)
})

/**
 * The documented byte model, counted independently of the implementation:
 * UTF-8 bytes of every string key outside arrays and every string value,
 * one byte per array slot, and 24 bytes for every other non-object value
 * (null and undefined included, symbol-keyed values too). Each object is
 * counted once however often it is referenced; Bun's own error metadata
 * keys are skipped.
 */
function projectedCost(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return encoder.encode(value).length
  if (value === null || typeof value !== 'object') return 24
  if (seen.has(value)) return 0
  seen.add(value)
  const array = Array.isArray(value)
  let total = 0
  for (const key of Reflect.ownKeys(value)) {
    if (RUNTIME_ERROR_KEYS.has(key)) continue
    if (array) {
      if (key === 'length') continue
      total += 1
    } else if (typeof key === 'string') total += encoder.encode(key).length
    total += projectedCost(own(value, key), seen)
  }
  return total
}

test('arrays are copied only as far as their slots and values can be paid for', () => {
  const redactor = ownRedactor([
    'sk-ant-oat01-bound-projection-realistic-string',
  ])
  // 80 arrays of 1000 zeros cost far more than the budget under the model.
  const zeros = instance(
    redactor.redactError(
      new AggregateError(
        Array.from({ length: 80 }, () => Array(1000).fill(0)),
        'attempt detail arrays',
      ),
    ),
    AggregateError,
  )
  expect(projectedCost(zeros)).toBeLessThanOrEqual(
    PROVIDER_ERROR_MAX_BODY_BYTES,
  )
  const arrays = zeros.errors as unknown[][]
  expect(arrays[0]).toEqual(Array(1000).fill(0))
  expect(arrays.length).toBeLessThan(80)
  // Every kept array is a prefix of its original: zeros at the original
  // indexes, never a filler value after the budget ran out.
  for (const array of arrays) {
    expect(array.length).toBeLessThanOrEqual(1000)
    expect(array.every((item) => item === 0)).toBe(true)
  }

  // Withheld values are paid for as the marker text they become.
  const symbols = instance(
    redactor.redactError(
      new AggregateError(
        Array.from({ length: 150 }, () => Array(1000).fill(Symbol('s'))),
        'symbols',
      ),
    ),
    AggregateError,
  )
  expect(projectedCost(symbols)).toBeLessThanOrEqual(
    PROVIDER_ERROR_MAX_BODY_BYTES,
  )
  for (const array of symbols.errors as unknown[][])
    expect(array.every((item) => item === PROVIDER_ERROR_REDACTION)).toBe(true)
})

test('small arrays in errors keep every value at its index', () => {
  const redactor = ownRedactor([RELAY_CREDENTIAL])
  const result = instance(
    redactor.redactError(
      Object.assign(
        new AggregateError(
          [[1, 'a', undefined, null], [`b ${RELAY_CREDENTIAL}`], []],
          'two attempts',
        ),
        { cause: [429, true] },
      ),
    ),
    AggregateError,
  )
  expect(result.errors).toEqual([
    [1, 'a', undefined, null],
    [`b ${PROVIDER_ERROR_REDACTION}`],
    [],
  ])
  expect((result.errors[0] as unknown[]).length).toBe(4)
  expect(result.cause).toEqual([429, true])
  expect(projectedCost(result)).toBeLessThan(1024)
})
