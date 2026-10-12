/**
 * Credential redaction for plugin-owned Anthropic provider errors.
 *
 * A redactor is created for one physical request attempt with the exact
 * credentials that attempt sent (OAuth access token, API key, relay
 * credential). It scrubs only error material: thrown errors, non-2xx response
 * bodies and status text, and SSE frames that are real error envelopes.
 * Successful response bytes, including successful stream frames that merely
 * mention the word "error", pass through byte-for-byte.
 *
 * The credentials live only in this module's closure. The returned object has
 * no data properties, so serializing or inspecting it reveals nothing, and
 * `dispose()` drops the credentials when the attempt ends. Anything read
 * through the redactor after disposal cannot be checked against the exact
 * credentials any more, so error material read late is replaced with a
 * generic message instead of being passed through.
 *
 * Text is scanned twice by one shared scanner: as written and with its JSON
 * escapes decoded, so a credential spelled with `\uXXXX` escapes, or hidden
 * in a duplicate JSON key that a parser would drop, is still found.
 */
import { types as utilTypes } from 'node:util'
import {
  createSseFramer,
  DEFAULT_SSE_MAX_FRAME_BYTES,
  decodeSseFrame,
  isSseCandidateFrame,
  isTerminatedSseFrame,
  parseSseFrame,
  type SseEvent,
  SseFrameTooLargeError,
} from './sse.ts'

export interface ProviderErrorRedactor {
  /** Scrub credentials from error text. */
  redactText(text: string): string
  /**
   * Scrub credentials from any thrown value without running caller code.
   * Strings come back scrubbed and other primitives unchanged. Objects come
   * back as a fresh projection that keeps only the fields hosts classify on
   * (name, message, status, code, type, retry hints, headers, the nested
   * `error` envelope, `cause` and aggregate `errors`), each read as own data
   * and scrubbed. The original object, its prototype, getters, private state
   * and any response body, stream or URL are never returned. Never throws.
   */
  redactError(error: unknown): unknown
  /**
   * Scrub a provider response. Successful non-stream responses are returned
   * as-is. Successful event streams keep every successful frame byte-for-byte
   * and rewrite only error envelopes. Non-2xx responses get scrubbed status
   * text, headers, URL and body; the body is read lazily when the caller
   * reads it. After disposal a non-2xx response keeps only its status and
   * verifiable retry/rate-limit headers.
   */
  redactResponse(response: Response): Response
  /** Forget the credentials. Later error reads fail closed to a generic message. */
  dispose(): void
}

/** Replacement for every scrubbed credential. */
export const PROVIDER_ERROR_REDACTION = '[REDACTED]'
/** Message used when error material is read after the redactor was disposed. */
export const PROVIDER_ERROR_WITHHELD_MESSAGE =
  'Provider error details were withheld because the request attempt has ended'
/** Message used when a non-2xx body is too large to scrub safely. */
export const PROVIDER_ERROR_OVERSIZED_MESSAGE =
  'Provider error body exceeded the redaction size limit and was withheld'
/** Largest non-2xx body read into memory for scrubbing. */
export const PROVIDER_ERROR_MAX_BODY_BYTES = 1024 * 1024
/** Largest SSE frame carried while looking for its end. */
export const PROVIDER_ERROR_MAX_FRAME_BYTES = DEFAULT_SSE_MAX_FRAME_BYTES

/** Nesting below which error objects and JSON values are still walked. */
const MAX_WALK_DEPTH = 32
/** Objects visited in one `redactError` call before the rest is replaced. */
const MAX_WALK_OBJECTS = 2000
/** Own keys on one object before the object is replaced instead of walked. */
const MAX_OBJECT_KEYS = 1000

// Shapes that look like credentials even when the exact value is unknown, for
// example a token from an earlier attempt echoed back by a proxy. Each one
// requires enough token characters that ordinary prose ("bearer token",
// "risk-based") is left alone. Both expressions are single-pass: every
// quantifier is followed by a character its class cannot match, so a failed
// attempt never rescans text. JWT shapes are found by `addJwtSpans` instead
// of an expression, because a regular expression for them backtracks
// quadratically on long runs such as "eyJ-eyJ-eyJ-...".
/** `Bearer <token>`; only the token (capture group 1) is replaced. */
const BEARER_PATTERN = /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/gi
/** `sk-` keys not preceded by another key character. */
const SK_PATTERN = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g
/** One JSON string escape: `\uXXXX` (group 1) or a one-character escape (group 2). */
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g
const ONE_CHARACTER_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/**
 * Error types kept in a generic replacement body. A closed list rather than
 * a syntax check: an opaque credential can look like any identifier.
 */
const KNOWN_ERROR_TYPES: ReadonlySet<string> = new Set([
  'api_error',
  'authentication_error',
  'billing_error',
  'invalid_request_error',
  'not_found_error',
  'overloaded_error',
  'permission_error',
  'rate_limit_error',
  'relay_upstream_error',
  'request_too_large',
  'timeout_error',
])

const encoder = new TextEncoder()

/** How a lifetime-tracked body reached its end. */
type BodyTerminal = 'eof' | 'cancel' | 'error'

interface RedactorState {
  /** Exact credentials, longest first; null once disposed. */
  secrets: readonly string[] | null
  /**
   * Called once a wrapped body reaches a terminal point, after any error
   * there has been scrubbed with the live credentials and before awaiting
   * source cancellation, which may never finish. Only response scopes set it.
   */
  onTerminal?: (terminal: BodyTerminal) => void
  /** Number of bodies wrapped with this state (event streams and non-2xx). */
  wrappedBodies: number
}

function reachTerminal(state: RedactorState, terminal: BodyTerminal): void {
  state.onTerminal?.(terminal)
}

/**
 * Narrow the caller's credential list without running getters: proxies,
 * holes, accessors and non-string entries are rejected. Empty strings carry
 * nothing to scrub and are skipped. The list is copied so later changes to
 * the caller's array cannot change what is scrubbed.
 */
function readSecrets(secrets: unknown): string[] {
  if (!Array.isArray(secrets) || utilTypes.isProxy(secrets))
    throw new TypeError('Provider error redactor secrets must be an array')
  const lengthField = Object.getOwnPropertyDescriptor(secrets, 'length')
  const length: unknown = lengthField?.value
  if (typeof length !== 'number')
    throw new TypeError('Provider error redactor secrets must be an array')
  const unique = new Set<string>()
  for (let index = 0; index < length; index += 1) {
    const field = Object.getOwnPropertyDescriptor(secrets, String(index))
    if (field === undefined || !('value' in field))
      throw new TypeError(
        `Provider error redactor secret ${index} must be a data property`,
      )
    const value: unknown = field.value
    if (typeof value !== 'string')
      throw new TypeError(
        `Provider error redactor secret ${index} must be a string`,
      )
    if (value !== '') unique.add(value)
  }
  // Longest first, so a credential that contains another is replaced whole.
  return [...unique].sort((left, right) => right.length - left.length)
}

/** Credential spans as flat [start, end) pairs of string offsets. */
type Spans = number[]

const DOT = 0x2e

/** A-Z, a-z, 0-9 and `_`: the characters regular-expression `\b` treats as word characters. */
function isWordCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  )
}

/** End of the run of JWT segment characters (word characters and `-`) starting at `from`. */
function segmentEnd(text: string, from: number): number {
  let end = from
  for (; end < text.length; end += 1) {
    const code = text.charCodeAt(end)
    if (!isWordCode(code) && code !== 0x2d) break
  }
  return end
}

/**
 * JWT shapes: `eyJ` at a word boundary, then three dot-separated segments of
 * [A-Za-z0-9_-]. Each segment is a maximal run, so whether a start matches
 * depends only on the run it sits in and the two runs after it; the earliest
 * start of a run decides for the whole run. Every character is therefore
 * read a bounded number of times, whatever the input.
 */
function addJwtSpans(text: string, spans: Spans): void {
  let at = text.indexOf('eyJ')
  while (at !== -1) {
    const runEnd = segmentEnd(text, at)
    let start = at
    // The first start in this run with a word boundary before it and at
    // least one segment character after `eyJ`.
    while (
      start !== -1 &&
      start < runEnd &&
      !(
        start + 3 < runEnd &&
        (start === 0 || !isWordCode(text.charCodeAt(start - 1)))
      )
    )
      start = text.indexOf('eyJ', start + 1)
    if (start === -1) return
    if (start >= runEnd) {
      at = start
      continue
    }
    let next = runEnd
    if (text.charCodeAt(runEnd) === DOT) {
      const second = segmentEnd(text, runEnd + 1)
      if (second > runEnd + 1 && text.charCodeAt(second) === DOT) {
        const third = segmentEnd(text, second + 1)
        if (third > second + 1) {
          spans.push(start, third)
          next = third
        }
      }
    }
    at = text.indexOf('eyJ', next)
  }
}

function addPatternSpans(text: string, pattern: RegExp, spans: Spans): void {
  pattern.lastIndex = 0
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    const end = match.index + match[0].length
    // Replace only the token when the pattern captures one.
    const token = match[1]
    spans.push(token === undefined ? match.index : end - token.length, end)
  }
}

function addCredentialSpans(
  text: string,
  secrets: readonly string[],
  spans: Spans,
): void {
  for (const secret of secrets)
    for (
      let at = text.indexOf(secret);
      at !== -1;
      at = text.indexOf(secret, at + secret.length)
    )
      spans.push(at, at + secret.length)
  addPatternSpans(text, BEARER_PATTERN, spans)
  addPatternSpans(text, SK_PATTERN, spans)
  addJwtSpans(text, spans)
}

function decodeEscape(_match: string, hex?: string, single?: string): string {
  if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16))
  return single === undefined ? '' : (ONE_CHARACTER_ESCAPES[single] ?? single)
}

/**
 * Map offsets in the escape-decoded text back to offsets in `text`. Every
 * decoded character comes from one contiguous piece of `text` (itself, or a
 * whole escape), so a decoded span maps to whole escapes, never half of one.
 * One linear walk serves every offset.
 */
function rawOffsets(text: string, decoded: readonly number[]): number[] {
  const order = [...decoded.keys()].sort(
    (left, right) => (decoded[left] ?? 0) - (decoded[right] ?? 0),
  )
  const raw = new Array<number>(decoded.length).fill(text.length)
  let next = 0
  let rawAt = 0
  let decodedAt = 0
  JSON_ESCAPE.lastIndex = 0
  for (;;) {
    const match = JSON_ESCAPE.exec(text)
    const literalEnd = match ? match.index : text.length
    // Characters before the escape map one to one; an offset equal to the
    // escape's decoded position maps to the escape's start.
    for (; next < order.length; next += 1) {
      const index = order[next] ?? 0
      const offset = decoded[index] ?? 0
      if (offset > decodedAt + (literalEnd - rawAt)) break
      raw[index] = rawAt + (offset - decodedAt)
    }
    if (!match || next === order.length) return raw
    decodedAt += literalEnd - rawAt + 1
    rawAt = match.index + match[0].length
  }
}

/** Replace each span, merging overlapping ones, with the redaction marker. */
function replaceSpans(text: string, spans: Spans): string {
  const pairs: Array<readonly [number, number]> = []
  for (let index = 0; index + 1 < spans.length; index += 2)
    pairs.push([spans[index] ?? 0, spans[index + 1] ?? 0])
  pairs.sort((left, right) => left[0] - right[0] || right[1] - left[1])
  let out = ''
  let copied = 0
  let start = -1
  let end = -1
  for (const [from, stop] of pairs) {
    if (start !== -1 && from < end) {
      end = Math.max(end, stop)
      continue
    }
    if (start !== -1) {
      out += text.slice(copied, start) + PROVIDER_ERROR_REDACTION
      copied = end
    }
    start = from
    end = stop
  }
  if (start !== -1) {
    out += text.slice(copied, start) + PROVIDER_ERROR_REDACTION
    copied = end
  }
  return out + text.slice(copied)
}

/**
 * The one credential scanner. Exact credentials and credential shapes are
 * located in the text as written and, when it contains a backslash, in its
 * JSON-escape-decoded form, whose matches are mapped back to the original
 * escapes. All spans are found on the original text first and merged before
 * anything is replaced, so a short credential inside a longer shape (a key
 * inside a JWT, say) never leaves part of the shape behind.
 */
function scrubText(text: string, secrets: readonly string[]): string {
  const spans: Spans = []
  addCredentialSpans(text, secrets, spans)
  if (text.includes('\\')) {
    const decoded = text.replace(JSON_ESCAPE, decodeEscape)
    if (decoded !== text) {
      const found: Spans = []
      addCredentialSpans(decoded, secrets, found)
      for (const offset of rawOffsets(text, found)) spans.push(offset)
    }
  }
  if (spans.length === 0) return text
  return replaceSpans(text, spans)
}

// Platform accessors captured at load time. Responses, headers and
// DOMExceptions keep their data in internal slots; reading them through these
// originals, with Reflect.apply, never runs a getter, method or iterator that
// a subclass or the instance itself overrides. Each original also
// brand-checks its receiver, throwing a TypeError for anything that is not
// really that platform type.
type Accessor = (this: unknown) => unknown

function platformGetter(prototype: object, key: string): Accessor {
  const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get
  if (typeof getter !== 'function')
    throw new Error(`Platform accessor ${key} is unavailable`)
  return getter
}

const RESPONSE_STATUS = platformGetter(Response.prototype, 'status')
const RESPONSE_STATUS_TEXT = platformGetter(Response.prototype, 'statusText')
const RESPONSE_OK = platformGetter(Response.prototype, 'ok')
const RESPONSE_HEADERS = platformGetter(Response.prototype, 'headers')
const RESPONSE_BODY = platformGetter(Response.prototype, 'body')
const RESPONSE_URL = platformGetter(Response.prototype, 'url')
const HEADERS_FOR_EACH = Headers.prototype.forEach
const DOM_EXCEPTION_NAME = platformGetter(DOMException.prototype, 'name')
const DOM_EXCEPTION_MESSAGE = platformGetter(DOMException.prototype, 'message')

function readSlot(accessor: Accessor, target: object): unknown {
  return Reflect.apply(accessor, target, [])
}

/** Run `read` and report a brand-check failure as undefined. */
function branded<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch (error) {
    if (error instanceof TypeError) return undefined
    throw error
  }
}

type HeaderEntries = Array<readonly [string, string]>

/** Header pairs of a real Headers object, read without its own iterators. */
function headerEntries(headers: unknown): HeaderEntries {
  const entries: HeaderEntries = []
  Reflect.apply(HEADERS_FOR_EACH, headers, [
    (value: unknown, name: unknown) => {
      if (typeof name === 'string' && typeof value === 'string')
        entries.push([name, value])
    },
  ])
  return entries
}

interface ResponseParts {
  status: number
  statusText: string
  ok: boolean
  headers: HeaderEntries
  url: string
  /**
   * Read the body slot. Deferred because merely reading `body` can turn a
   * string- or buffer-backed Response into a stream; on Bun 1.3.14 a later
   * clone, partial read and release of that clone then leaves the original
   * empty. Responses returned untouched must never have it read.
   */
  body(): ReadableStream<Uint8Array> | null
}

function isByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return value instanceof ReadableStream
}

/** Read a Response's slots, or undefined when `value` is not a Response. */
function readResponse(value: unknown): ResponseParts | undefined {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value))
    return undefined
  const status = branded(() => readSlot(RESPONSE_STATUS, value))
  if (typeof status !== 'number') return undefined
  const statusText = readSlot(RESPONSE_STATUS_TEXT, value)
  const ok = readSlot(RESPONSE_OK, value)
  const url = readSlot(RESPONSE_URL, value)
  if (
    typeof statusText !== 'string' ||
    typeof ok !== 'boolean' ||
    typeof url !== 'string'
  )
    throw new TypeError('Response slots could not be read')
  return {
    status,
    statusText,
    ok,
    headers: headerEntries(readSlot(RESPONSE_HEADERS, value)),
    url,
    body() {
      const body = readSlot(RESPONSE_BODY, value)
      if (body === null || isByteStream(body)) return body
      throw new TypeError('Response body slot could not be read')
    },
  }
}

/**
 * True unless `value` is exactly the platform type with no own property that
 * shadows a platform member. Only such values can be handed back as-is: any
 * override would otherwise run when a consumer later uses the value.
 */
function isUntouchedPlatformValue(value: object, prototype: object): boolean {
  if (Object.getPrototypeOf(value) !== prototype) return false
  return Reflect.ownKeys(value).every((key) => !(key in prototype))
}

function contentType(headers: HeaderEntries): string {
  for (const [name, value] of headers)
    if (name.toLowerCase() === 'content-type') return value
  return ''
}

/**
 * Scrub every key and string in a value produced by `JSON.parse`. Returns the
 * input itself when nothing changed, so callers can keep the original bytes.
 * Values nested deeper than the walk bound are replaced, never passed through.
 */
function scrubJson(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
): unknown {
  if (typeof value === 'string') return scrubText(value, secrets)
  // A parsed number or other literal can itself spell a credential, such
  // as an all-digit key. Replace it rather than reproduce it in the JSON.
  if (value === null || typeof value !== 'object')
    return isCleanLiteral(value, secrets) ? value : PROVIDER_ERROR_REDACTION
  if (depth >= MAX_WALK_DEPTH) return PROVIDER_ERROR_REDACTION
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index]
      const scrubbed = scrubJson(entry, secrets, depth + 1)
      if (scrubbed !== entry) {
        copy ??= value.slice()
        copy[index] = scrubbed
      }
    }
    return copy ?? value
  }
  if (!isPlainJsonObject(value)) return value
  let changed = false
  const entries: Array<[string, unknown]> = []
  for (const key of Object.keys(value)) {
    const entry = value[key]
    const scrubbedKey = scrubText(key, secrets)
    const scrubbed = scrubJson(entry, secrets, depth + 1)
    if (scrubbedKey !== key || scrubbed !== entry) changed = true
    entries.push([scrubbedKey, scrubbed])
  }
  if (!changed) return value
  const copy: Record<string, unknown> = {}
  // defineProperty keeps a parsed "__proto__" key an ordinary own key.
  for (const [key, entry] of entries)
    Object.defineProperty(copy, key, {
      value: entry,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  return copy
}

/** True unless the JSON text of a non-string primitive contains a credential. */
function isCleanLiteral(value: unknown, secrets: readonly string[]): boolean {
  const text = JSON.stringify(value)
  return typeof text !== 'string' || scrubText(text, secrets) === text
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Anthropic error envelopes are `{type:"error", error:{...}}`; relays may send only `{error}`. */
function isErrorPayload(value: unknown): boolean {
  if (!isPlainJsonObject(value)) return false
  return value.type === 'error' || Object.hasOwn(value, 'error')
}

/** Keep `error.type` in a generic body only when it is a known Anthropic type. */
function safeErrorType(payload: unknown): string | undefined {
  if (!isPlainJsonObject(payload)) return undefined
  const error = payload.error
  if (!isPlainJsonObject(error)) return undefined
  const type = error.type
  return typeof type === 'string' && KNOWN_ERROR_TYPES.has(type)
    ? type
    : undefined
}

function genericErrorJson(message: string, type?: string): string {
  return JSON.stringify({
    type: 'error',
    error: type === undefined ? { message } : { type, message },
  })
}

function tryParseJson(text: string): { ok: true; value: unknown } | undefined {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

/**
 * Scrub error data that may be one JSON document: a non-2xx body or the data
 * of an SSE error frame. The text itself is returned when the scanner finds
 * nothing, read as written or escape-decoded. Otherwise JSON is re-serialized
 * from its scrubbed parse, which also drops every earlier duplicate key, and
 * any other text is scrubbed in place.
 */
function scrubPayload(text: string, secrets: readonly string[]): string {
  const clean = scrubText(text, secrets)
  if (clean === text) return text
  const parsed = tryParseJson(text)
  if (!parsed) return clean
  const serialized = JSON.stringify(scrubJson(parsed.value, secrets))
  // Re-serializing can still form a credential the walk could not see (for
  // example out of values that are each clean). Then only the known error
  // type survives, which keeps rate-limit and overload classification.
  return scrubText(serialized, secrets) === serialized
    ? serialized
    : genericErrorJson(UNINSPECTABLE_MESSAGE, safeErrorType(parsed.value))
}

// Thrown values are projected, never copied: a fresh Error or plain record is
// built from a fixed list of fields that hosts classify on, each read as an
// own data property and checked for its expected type. Nothing else of the
// original survives, so its prototype, getters, private fields, internal
// slots (a URL, a stream, a body) and unknown expandos cannot travel with it.

/** How a projected field is checked and copied. */
type FieldKind =
  /** A string, scrubbed. */
  | 'text'
  /** An integer HTTP-like status, 0 to 999. */
  | 'status'
  /** A scrubbed string or a finite number, like `ECONNRESET` or a numeric code. */
  | 'code'
  /** A finite number of seconds or milliseconds, or a scrubbed header-style string. */
  | 'retry'
  | 'boolean'
  /** The failed transport operation, such as 'websocket' or 'anthropic-sse'. */
  | 'syscall'
  /** An integer WebSocket close code, 1000 to 4999. */
  | 'closeCode'
  /** A request id such as `req_011...`: 1 to 128 of [A-Za-z0-9_-]. */
  | 'requestId'
  /** A nested value copied with the same field checks, without its prototype. */
  | 'nested'
  /** Headers or a header record, as a plain record of string values. */
  | 'headers'
  /** An array of values, projected recursively. */
  | 'list'

/**
 * The fields kept on a projected error or record. Status, code, the nested
 * Anthropic `error` envelope (its `type` and `message`), retry hints and
 * headers decide 429, overload, retry and context-overflow handling; `cause`
 * and `errors` carry nested network codes. `statusCode`, `isRetryable` and
 * `responseHeaders` are where AI SDK `APICallError` keeps the same facts.
 * `request_id` (Anthropic error bodies) and `requestID` (Anthropic SDK
 * errors) identify the failed request for support and logs.
 * `syscall`, `closeCode` and `wasClean` describe a dropped websocket
 * connection to the relay server (which transport failed, the WebSocket
 * close code, and whether the close was clean); the close reason text comes
 * from the remote side, nothing classifies on it, so it is not kept.
 */
const PROJECTED_FIELDS: ReadonlyArray<readonly [string, FieldKind]> = [
  ['name', 'text'],
  ['message', 'text'],
  ['type', 'text'],
  ['status', 'status'],
  ['statusCode', 'status'],
  ['code', 'code'],
  ['retryAfter', 'retry'],
  ['isRetryable', 'boolean'],
  ['request_id', 'requestId'],
  ['requestID', 'requestId'],
  ['syscall', 'syscall'],
  ['closeCode', 'closeCode'],
  ['wasClean', 'boolean'],
  ['error', 'nested'],
  ['cause', 'nested'],
  ['response', 'nested'],
  ['headers', 'headers'],
  ['responseHeaders', 'headers'],
  ['errors', 'list'],
]

/**
 * Values this repository's own errors put in `syscall` to say which
 * transport failed: 'websocket' for a dropped relay websocket
 * (packages/core/src/relay.ts) and 'anthropic-sse' for a retryable failure
 * in an Anthropic event stream (packages/opencode/src/transform.ts). Only
 * these exact values are kept, so the field never carries free text.
 */
const TRANSPORT_SYSCALLS: ReadonlySet<string> = new Set([
  'websocket',
  'anthropic-sse',
])

/**
 * AI SDK errors are recognized across package versions by these registered
 * symbols holding `true` (`AISDKError.hasMarker`). Only these exact public
 * markers are carried over, as an own `true`; any other symbol is dropped.
 */
const AI_SDK_ERROR_MARKERS: readonly symbol[] = [
  Symbol.for('vercel.ai.error'),
  Symbol.for('vercel.ai.error.AI_APICallError'),
]

/**
 * Built-in error constructors a native error is rebuilt with, chosen by its
 * `name`. A closed list: any other name yields a plain `Error`, which keeps
 * the original's name only when that name is an own string.
 */
const BUILT_IN_ERRORS: ReadonlyMap<string, new (message?: string) => Error> =
  new Map<string, new (message?: string) => Error>([
    ['Error', Error],
    ['TypeError', TypeError],
    ['RangeError', RangeError],
    ['SyntaxError', SyntaxError],
    ['ReferenceError', ReferenceError],
    ['EvalError', EvalError],
    ['URIError', URIError],
  ])

const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Longest prototype chain inspected before a value is withheld. */
const MAX_PROTOTYPE_CHAIN = 64

interface Projection {
  secrets: readonly string[]
  /** Original objects already projected, so cycles point at projections. */
  memo: Map<object, unknown>
  /** Objects still allowed before the rest is withheld. */
  budget: number
}

/**
 * True when neither the object nor anything on its prototype chain is a
 * proxy. Checked link by link before each link is read, so no trap runs.
 */
function hasProxyFreeChain(value: object): boolean {
  let current: object | null = value
  for (let links = 0; current !== null; links += 1) {
    if (links > MAX_PROTOTYPE_CHAIN || utilTypes.isProxy(current)) return false
    current = Object.getPrototypeOf(current)
  }
  return true
}

/** An own data property, or undefined for accessors and missing keys. */
function ownData(value: object, key: PropertyKey): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key)
  return field !== undefined && 'value' in field ? field.value : undefined
}

/**
 * The data `name` a native error reports, own or inherited, without running
 * getters; the chain was already checked to be proxy-free. It only picks a
 * built-in constructor from the closed list: an inherited name is never
 * copied onto the projection.
 */
function inheritedName(value: object): unknown {
  for (
    let current: object | null = value;
    current !== null;
    current = Object.getPrototypeOf(current)
  ) {
    const field = Object.getOwnPropertyDescriptor(current, 'name')
    if (field !== undefined) return 'value' in field ? field.value : undefined
  }
  return undefined
}

function defineField(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function isStatus(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 999
}

/**
 * Header entries as a plain record. An entry whose name carries a credential
 * is dropped whole, since a header name cannot be partly redacted; values are
 * scrubbed, so retry and rate-limit headers keep theirs.
 */
function headerRecord(
  entries: Iterable<readonly [string, string]>,
  secrets: readonly string[],
): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [name, value] of entries)
    if (scrubText(name, secrets) === name)
      defineField(record, name, scrubText(value, secrets))
  return record
}

/** Headers, read through the platform, or a plain record of string values. */
function projectHeaders(
  value: unknown,
  walk: Projection,
): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || !hasProxyFreeChain(value))
    return undefined
  const platform = branded(() => headerEntries(value))
  if (platform) return headerRecord(platform, walk.secrets)
  const keys = Reflect.ownKeys(value)
  if (keys.length > MAX_OBJECT_KEYS) return undefined
  const entries: Array<readonly [string, string]> = []
  for (const key of keys) {
    const entry = typeof key === 'string' ? ownData(value, key) : undefined
    if (typeof key === 'string' && typeof entry === 'string')
      entries.push([key, entry])
  }
  return headerRecord(entries, walk.secrets)
}

function projectField(
  kind: FieldKind,
  value: unknown,
  walk: Projection,
  depth: number,
): unknown {
  switch (kind) {
    case 'text':
      return typeof value === 'string'
        ? scrubText(value, walk.secrets)
        : undefined
    case 'status':
      return isStatus(value) && isCleanLiteral(value, walk.secrets)
        ? value
        : undefined
    case 'code':
    case 'retry':
      if (typeof value === 'string') return scrubText(value, walk.secrets)
      return Number.isFinite(value) && isCleanLiteral(value, walk.secrets)
        ? value
        : undefined
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined
    case 'syscall':
      return typeof value === 'string' && TRANSPORT_SYSCALLS.has(value)
        ? value
        : undefined
    case 'closeCode':
      return Number.isInteger(value) &&
        Number(value) >= 1000 &&
        Number(value) <= 4999 &&
        isCleanLiteral(value, walk.secrets)
        ? value
        : undefined
    case 'requestId':
      return typeof value === 'string' &&
        REQUEST_ID.test(value) &&
        scrubText(value, walk.secrets) === value
        ? value
        : undefined
    case 'nested':
      return value === undefined ? undefined : project(value, walk, depth)
    case 'headers':
      return projectHeaders(value, walk)
    case 'list':
      return Array.isArray(value) ? project(value, walk, depth) : undefined
  }
}

/** Copy the whitelisted fields of `value` onto the fresh `target`. */
function projectFields(
  value: object,
  target: object,
  walk: Projection,
  depth: number,
  skip: ReadonlySet<string>,
): void {
  for (const [key, kind] of PROJECTED_FIELDS) {
    if (skip.has(key)) continue
    const projected = projectField(kind, ownData(value, key), walk, depth + 1)
    if (projected !== undefined) defineField(target, key, projected)
  }
  for (const marker of AI_SDK_ERROR_MARKERS)
    if (ownData(value, marker) === true) defineField(target, marker, true)
}

const ERROR_SKIP: ReadonlySet<string> = new Set(['message'])
const AGGREGATE_SKIP: ReadonlySet<string> = new Set(['message', 'errors'])
const NO_SKIP: ReadonlySet<string> = new Set()

function projectError(value: object, walk: Projection, depth: number): Error {
  const message = ownData(value, 'message')
  const text =
    typeof message === 'string' ? scrubText(message, walk.secrets) : ''
  const name = inheritedName(value)
  const aggregate = name === 'AggregateError'
  const Builtin =
    typeof name === 'string' ? BUILT_IN_ERRORS.get(name) : undefined
  // An AggregateError gets its members afterwards, as an array this module
  // built, so the constructor never iterates anything from the original.
  const error = aggregate
    ? new AggregateError([], text)
    : new (Builtin ?? Error)(text)
  walk.memo.set(value, error)
  // An own `name` is copied as an own string with the other fields.
  projectFields(
    value,
    error,
    walk,
    depth,
    aggregate ? AGGREGATE_SKIP : ERROR_SKIP,
  )
  if (aggregate) {
    const errors = ownData(value, 'errors')
    const members = Array.isArray(errors)
      ? project(errors, walk, depth + 1)
      : undefined
    Object.defineProperty(error, 'errors', {
      value: Array.isArray(members) ? members : [],
      writable: true,
      configurable: true,
    })
  }
  return error
}

function projectArray(
  value: readonly unknown[],
  walk: Projection,
  depth: number,
): unknown {
  const length = ownData(value, 'length')
  if (typeof length !== 'number' || length > MAX_OBJECT_KEYS)
    return PROVIDER_ERROR_REDACTION
  const array: unknown[] = []
  walk.memo.set(value, array)
  for (let index = 0; index < length; index += 1)
    array.push(project(ownData(value, String(index)), walk, depth + 1))
  return array
}

/**
 * Project one value. Strings are scrubbed; numbers, booleans, bigints, null
 * and undefined are kept; symbols and functions are withheld. Objects are
 * withheld when a proxy sits anywhere on their prototype chain, or past the
 * depth and object budgets; otherwise they become a fresh projection.
 */
function project(value: unknown, walk: Projection, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value, walk.secrets)
  if (typeof value === 'symbol' || typeof value === 'function')
    return PROVIDER_ERROR_REDACTION
  if (value === null || typeof value !== 'object') return value
  if (walk.memo.has(value)) return walk.memo.get(value)
  if (!hasProxyFreeChain(value)) return PROVIDER_ERROR_REDACTION
  walk.budget -= 1
  if (walk.budget < 0 || depth >= MAX_WALK_DEPTH)
    return PROVIDER_ERROR_REDACTION
  const response = readResponse(value)
  if (response) {
    // Status, scrubbed status text and headers only: the body and URL of a
    // response inside an error are never read or kept.
    const record = {}
    walk.memo.set(value, record)
    defineField(record, 'status', response.status)
    defineField(
      record,
      'statusText',
      scrubText(response.statusText, walk.secrets),
    )
    defineField(record, 'headers', headerRecord(response.headers, walk.secrets))
    return record
  }
  const exceptionMessage = branded(() => readSlot(DOM_EXCEPTION_MESSAGE, value))
  if (typeof exceptionMessage === 'string') {
    const error = new Error(scrubText(exceptionMessage, walk.secrets))
    const name = readSlot(DOM_EXCEPTION_NAME, value)
    if (typeof name === 'string')
      defineField(error, 'name', scrubText(name, walk.secrets))
    walk.memo.set(value, error)
    return error
  }
  if (utilTypes.isNativeError(value)) return projectError(value, walk, depth)
  if (Array.isArray(value)) return projectArray(value, walk, depth)
  const record = {}
  walk.memo.set(value, record)
  projectFields(value, record, walk, depth, NO_SKIP)
  return record
}

/** A generic error keeping only an own integer `status` of the original. */
function genericError(original: unknown, message: string): Error {
  const error = new Error(message)
  try {
    if (
      original !== null &&
      typeof original === 'object' &&
      !utilTypes.isProxy(original)
    ) {
      const status = ownData(original, 'status')
      if (isStatus(status)) defineField(error, 'status', status)
    }
  } catch {
    // A hostile object can throw from descriptor reads; keep the bare error.
  }
  return error
}

const UNINSPECTABLE_MESSAGE = 'Provider error could not be inspected safely'

function redactErrorWith(error: unknown, state: RedactorState): unknown {
  const secrets = state.secrets
  const isValue =
    (error !== null && typeof error === 'object') ||
    typeof error === 'function' ||
    typeof error === 'symbol'
  if (secrets === null) {
    if (typeof error === 'string') return PROVIDER_ERROR_WITHHELD_MESSAGE
    return isValue
      ? genericError(error, PROVIDER_ERROR_WITHHELD_MESSAGE)
      : error
  }
  try {
    const result = project(
      error,
      { secrets, memo: new Map(), budget: MAX_WALK_OBJECTS },
      0,
    )
    // A withheld thrown value still surfaces as an error, not a bare marker.
    return isValue && result === PROVIDER_ERROR_REDACTION
      ? genericError(undefined, UNINSPECTABLE_MESSAGE)
      : result
  } catch {
    return genericError(undefined, UNINSPECTABLE_MESSAGE)
  }
}

/**
 * Scrub a complete non-2xx body, which starts its own stream, so a leading
 * byte-order mark is not part of the text. The original bytes are kept
 * unless the shared scanner finds a credential.
 */
function scrubErrorBody(bytes: Uint8Array, state: RedactorState): Uint8Array {
  const text = decodeSseFrame(bytes, { streamStart: true })
  const secrets = state.secrets
  if (secrets === null)
    return encoder.encode(
      genericErrorJson(
        PROVIDER_ERROR_WITHHELD_MESSAGE,
        safeErrorType(tryParseJson(text)?.value),
      ),
    )
  const clean = scrubPayload(text, secrets)
  return clean === text ? bytes : encoder.encode(clean)
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]) return chunks[0]
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Enqueue unless the consumer already cancelled, which closes the controller. */
function deliver(
  controller: ReadableStreamDefaultController<Uint8Array>,
  bytes: Uint8Array | undefined,
  close: boolean,
): void {
  try {
    if (bytes) controller.enqueue(bytes)
    if (close) controller.close()
  } catch {
    // Cancelled while the source was being read; nothing is left to deliver.
  }
}

/**
 * Forward a consumer's cancel to the source. The credentials are already
 * retired by then, so a rejection cannot be checked for them: the consumer
 * gets a fixed generic error instead of the source's reason.
 */
function forwardCancel(
  target: { cancel(reason?: unknown): Promise<void> },
  reason: unknown,
): Promise<void> {
  return target.cancel(reason).then(
    () => undefined,
    () => {
      throw new Error(PROVIDER_ERROR_WITHHELD_MESSAGE)
    },
  )
}

/**
 * Non-2xx body that is read, bounded and scrubbed only when the caller first
 * reads it. A body over the bound is cancelled at the source and replaced
 * with a fixed message: cutting it would risk ending inside a credential.
 */
function scrubbedErrorBody(
  source: ReadableStream<Uint8Array>,
  state: RedactorState,
): ReadableStream<Uint8Array> {
  state.wrappedBodies += 1
  const openReader = () => source.getReader()
  let reader: ReturnType<typeof openReader> | undefined
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const chunks: Uint8Array[] = []
        let total = 0
        let active: ReturnType<typeof openReader> | undefined
        let output: Uint8Array
        try {
          // Acquiring the reader can throw too (a body already locked or
          // read elsewhere), so it shares the error path below.
          active = openReader()
          reader = active
          for (;;) {
            const { done, value } = await active.read()
            if (done) break
            if (!utilTypes.isUint8Array(value))
              throw new TypeError('Provider error body chunk must be bytes')
            // Empty chunks are never kept, so the byte bound also bounds
            // how much is held, whatever the source enqueues.
            if (value.byteLength === 0) continue
            total += value.byteLength
            if (total > PROVIDER_ERROR_MAX_BODY_BYTES) {
              deliver(
                controller,
                encoder.encode(
                  genericErrorJson(PROVIDER_ERROR_OVERSIZED_MESSAGE),
                ),
                true,
              )
              reachTerminal(state, 'eof')
              await active.cancel().catch(() => {})
              return
            }
            chunks.push(value)
          }
          output = scrubErrorBody(concatBytes(chunks, total), state)
        } catch (error) {
          const safe = redactErrorWith(error, state)
          reachTerminal(state, 'error')
          try {
            controller.error(safe)
          } catch {
            // Already cancelled by the consumer.
          }
          if (active) await active.cancel(safe).catch(() => {})
          return
        }
        deliver(controller, output, true)
        reachTerminal(state, 'eof')
      },
      cancel(reason) {
        // Retire the credentials first: the source's cancel may never settle.
        reachTerminal(state, 'cancel')
        return forwardCancel(reader ?? source, reason)
      },
    },
    { highWaterMark: 0 },
  )
}

function lineTerminatorOf(text: string): string {
  const match = /\r\n|\r|\n/.exec(text)
  return match ? match[0] : '\n'
}

/** Rebuild an error frame from parsed fields, keeping its line endings and termination. */
function buildFrame(
  original: Uint8Array,
  text: string,
  fields: { event?: string; id?: string; retry?: number; data?: string },
): Uint8Array {
  const lines: string[] = []
  if (fields.event !== undefined) lines.push(`event: ${fields.event}`)
  if (fields.id !== undefined) lines.push(`id: ${fields.id}`)
  if (fields.retry !== undefined) lines.push(`retry: ${fields.retry}`)
  if (fields.data !== undefined)
    for (const line of fields.data.split(/\r\n|\r|\n/))
      lines.push(`data: ${line}`)
  return buildFrameLines(original, text, lines)
}

function buildFrameLines(
  original: Uint8Array,
  text: string,
  lines: string[],
): Uint8Array {
  const terminator = lineTerminatorOf(text)
  let ending = ''
  if (isTerminatedSseFrame(original)) ending = terminator + terminator
  else if (/[\r\n]$/.test(text)) ending = terminator
  return encoder.encode(lines.join(terminator) + ending)
}

/**
 * Decide what to emit for one SSE frame. Only error envelopes are error
 * material: an `event: error` frame, or a frame whose data decodes to JSON
 * with `type: "error"` or an `error` key (escaped spellings included).
 * Every other frame, including comments, heartbeats and non-JSON data that
 * mention "error" or quote a credential, is successful stream content and is
 * returned as the same bytes.
 * - frames failing the raw candidate gate are never decoded;
 * - error envelopes are scrubbed field by field and rebuilt only when a
 *   credential was found;
 * - after disposal, error envelopes are replaced with a generic message
 *   because their credentials can no longer be recognized. A data-less
 *   `event: error` frame stays data-less, so no event is dispatched that the
 *   original would not have dispatched.
 * Only the first frame of a stream (`streamStart`) drops a leading
 * byte-order mark before parsing, as event-stream decoding does; a rebuilt
 * first frame keeps the mark's original bytes in front.
 */
function rewriteFrame(
  frame: Uint8Array,
  state: RedactorState,
  streamStart: boolean,
): Uint8Array {
  if (!isSseCandidateFrame(frame)) return frame
  const text = decodeSseFrame(frame, { streamStart })
  const event = parseSseFrame(text)
  const parsed = event.data === undefined ? undefined : tryParseJson(event.data)
  const isError =
    event.event === 'error' ||
    (parsed !== undefined && isErrorPayload(parsed.value))
  if (!isError) return frame
  const secrets = state.secrets
  const rebuilt =
    secrets === null
      ? buildFrame(frame, text, {
          event: event.event === undefined ? undefined : 'error',
          data:
            event.data === undefined
              ? undefined
              : genericErrorJson(
                  PROVIDER_ERROR_WITHHELD_MESSAGE,
                  safeErrorType(parsed?.value),
                ),
        })
      : // This error frame is kept as-is only when nothing in it holds a
        // credential. Rebuilding it drops comments and unknown fields, so the
        // whole frame text is scanned; the joined data is scanned too,
        // because a value split over several data lines (`Bearer` on one,
        // the token on the next) only reads as a credential once joined.
        scrubText(text, secrets) === text &&
          (event.data === undefined ||
            scrubText(event.data, secrets) === event.data)
        ? frame
        : buildFrame(frame, text, {
            event:
              event.event === undefined
                ? undefined
                : scrubText(event.event, secrets),
            id:
              event.id === undefined ? undefined : scrubText(event.id, secrets),
            // The retry line is rebuilt from the parsed number. It is written
            // back only when that number is a safe integer whose decimal
            // digits contain no credential (an all-digit key, for example);
            // otherwise the retry line is left out.
            retry:
              event.retry !== undefined &&
              Number.isSafeInteger(event.retry) &&
              isCleanLiteral(event.retry, secrets)
                ? event.retry
                : undefined,
            data:
              event.data === undefined
                ? undefined
                : scrubPayload(event.data, secrets),
          })
  const safe =
    rebuilt === frame || secrets === null
      ? rebuilt
      : checkRebuiltFrame(rebuilt, frame, text, event, parsed, secrets)
  if (safe === frame || !streamStart || !startsWithByteOrderMark(frame))
    return safe
  const marked = new Uint8Array(BYTE_ORDER_MARK.length + safe.length)
  marked.set(BYTE_ORDER_MARK, 0)
  marked.set(safe, BYTE_ORDER_MARK.length)
  return marked
}

/**
 * Last check on a rebuilt error frame: each field was scrubbed on its own,
 * but the written lines are scanned once more as a whole. If they still
 * spell a credential, the frame becomes a generic error that keeps only
 * whether it was an `error` event and the known error type.
 */
function checkRebuiltFrame(
  rebuilt: Uint8Array,
  original: Uint8Array,
  text: string,
  event: SseEvent,
  parsed: { value: unknown } | undefined,
  secrets: readonly string[],
): Uint8Array {
  const written = decodeSseFrame(rebuilt)
  if (scrubText(written, secrets) === written) return rebuilt
  return buildFrame(original, text, {
    event: event.event === undefined ? undefined : 'error',
    data:
      event.data === undefined
        ? undefined
        : genericErrorJson(UNINSPECTABLE_MESSAGE, safeErrorType(parsed?.value)),
  })
}

/** UTF-8 bytes of U+FEFF. */
const BYTE_ORDER_MARK = Uint8Array.of(0xef, 0xbb, 0xbf)

function startsWithByteOrderMark(frame: Uint8Array): boolean {
  return (
    frame[0] === BYTE_ORDER_MARK[0] &&
    frame[1] === BYTE_ORDER_MARK[1] &&
    frame[2] === BYTE_ORDER_MARK[2]
  )
}

/**
 * Successful event-stream body with error-only rewriting. It pulls from the
 * source only when its own reader asks for data (high-water mark 0), so
 * backpressure reaches the provider connection, and cancelling it cancels the
 * source. Consecutive unchanged frames from one source chunk are forwarded as
 * one view of that chunk; only rewritten frames are new bytes.
 *
 * A frame larger than the frame bound, complete or not, errors the stream
 * with `SseFrameTooLargeError` and is never forwarded, nor are frames that
 * arrived in the same source chunk before it: the stream fails visibly rather
 * than truncating a successful frame or decoding an unbounded error frame.
 */
function wrapEventStream(
  source: ReadableStream<Uint8Array>,
  state: RedactorState,
): ReadableStream<Uint8Array> {
  state.wrappedBodies += 1
  const pipeline = createFramePipeline(state)
  const openReader = () => source.getReader()
  let reader: ReturnType<typeof openReader> | undefined
  const emit = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunks: Uint8Array[],
  ) => {
    for (const chunk of chunks) controller.enqueue(chunk)
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let active = reader
        // Set around pipeline.push() and finish(): their frame-limit error
        // contains only byte counts and a fixed message. Errors from acquiring
        // or reading the source can contain credentials and must be scrubbed.
        let framing = false
        try {
          // Acquiring the reader can throw too (a body already locked or
          // read elsewhere), so it shares the error path below.
          active ??= openReader()
          reader = active
          for (;;) {
            const { done, value } = await active.read()
            if (done) {
              framing = true
              const tail = pipeline.finish()
              framing = false
              emit(controller, tail)
              controller.close()
              reachTerminal(state, 'eof')
              return
            }
            if (!utilTypes.isUint8Array(value))
              throw new TypeError('Provider event-stream chunk must be bytes')
            framing = true
            const chunks = pipeline.push(value)
            framing = false
            if (chunks.length > 0) {
              emit(controller, chunks)
              return
            }
          }
        } catch (error) {
          // Scrub with the live credentials, retire them, then cancel the
          // source; that cancel may never settle.
          const safe =
            framing && error instanceof SseFrameTooLargeError
              ? error
              : redactErrorWith(error, state)
          reachTerminal(state, 'error')
          try {
            controller.error(safe)
          } catch {
            // Already cancelled by the consumer.
          }
          if (active) await active.cancel(safe).catch(() => {})
        }
      },
      cancel(reason) {
        // Retire the credentials first: the source's cancel may never settle.
        reachTerminal(state, 'cancel')
        return forwardCancel(reader ?? source, reason)
      },
    },
    { highWaterMark: 0 },
  )
}

interface FramePipeline {
  /** Bytes to forward for this chunk; empty while a frame is incomplete. */
  push(chunk: Uint8Array): Uint8Array[]
  /** Bytes to forward for the unterminated tail at end of input. */
  finish(): Uint8Array[]
}

/**
 * The single SSE rewriting pipeline: byte framing, the error-only rewrite and
 * the frame bound. Consecutive unchanged frames from one input chunk are
 * forwarded as one view of that chunk; only rewritten frames are new bytes,
 * so concatenating every output equals the input wherever no error envelope
 * carried a credential. It also remembers whether the next frame is the
 * first of the stream, the only place a byte-order mark is dropped; the
 * framer keeps a mark split across chunks inside that first frame.
 */
function createFramePipeline(state: RedactorState): FramePipeline {
  const framer = createSseFramer({
    maxFrameBytes: PROVIDER_ERROR_MAX_FRAME_BYTES,
  })
  let streamStart = true
  const rewrite = (frames: Uint8Array[]): Uint8Array[] => {
    const out: Uint8Array[] = []
    let run: Uint8Array | undefined
    for (const frame of frames) {
      const output = rewriteFrame(frame, state, streamStart)
      streamStart = false
      if (
        output === frame &&
        run !== undefined &&
        run.buffer === frame.buffer &&
        run.byteOffset + run.byteLength === frame.byteOffset
      ) {
        run = new Uint8Array(
          run.buffer,
          run.byteOffset,
          run.byteLength + frame.byteLength,
        )
        continue
      }
      if (run) out.push(run)
      run = undefined
      if (output === frame) run = frame
      else out.push(output)
    }
    if (run) out.push(run)
    return out
  }
  return {
    push: (chunk) => rewrite(framer.push(chunk)),
    finish: () => {
      const tail = framer.finish()
      return tail ? rewrite([tail]) : []
    },
  }
}

/** Message of the error thrown when a closed stream scope is fed again. */
export const PROVIDER_ERROR_SCOPE_CLOSED_MESSAGE =
  'Provider error stream scope is closed'

/**
 * Internal scope for a producer that already holds the raw event-stream
 * bytes of one physical attempt (the relay): it feeds them through the same
 * pipeline as `redactResponse` without wrapping a Response.
 */
export interface ProviderErrorStreamScope {
  /**
   * Bytes to forward for this chunk. Unchanged frames come back as the same
   * bytes; only error envelopes are rewritten; an incomplete frame is held
   * until its blank line. A frame over the bound throws
   * `SseFrameTooLargeError`, and any failure disposes the scope.
   */
  push(chunk: Uint8Array): Uint8Array[]
  /** End of input: bytes for the unterminated tail, then the scope disposes. */
  finish(): Uint8Array[]
  /** Scrub a thrown error; generic once the scope is disposed. */
  redactError(error: unknown): unknown
  /** Drop the credentials and any held partial frame. Idempotent. */
  dispose(): void
}

/**
 * Create a stream scope for one physical attempt or reconnect, holding the
 * exact credentials that attempt sent. Create a fresh scope after every
 * fresh authorization. After `finish()` or `dispose()`, `push` and `finish`
 * throw an error carrying no content and `redactError` fails closed.
 */
export function createProviderErrorStreamScope(
  secrets: readonly string[],
): ProviderErrorStreamScope {
  const state: RedactorState = {
    secrets: readSecrets(secrets),
    wrappedBodies: 0,
  }
  let pipeline: FramePipeline | null = createFramePipeline(state)
  const dispose = () => {
    state.secrets = null
    pipeline = null
  }
  const live = (): FramePipeline => {
    if (pipeline === null) throw new Error(PROVIDER_ERROR_SCOPE_CLOSED_MESSAGE)
    return pipeline
  }
  return Object.freeze({
    push(chunk: Uint8Array): Uint8Array[] {
      const active = live()
      try {
        return active.push(chunk)
      } catch (error) {
        dispose()
        throw error
      }
    },
    finish(): Uint8Array[] {
      const active = live()
      try {
        return active.finish()
      } finally {
        dispose()
      }
    },
    redactError(error: unknown): unknown {
      return redactErrorWith(error, state)
    },
    dispose,
  })
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

const RATE_LIMIT_PREFIX = 'anthropic-ratelimit-unified-'
const RATE_LIMIT_STATUSES: ReadonlySet<string> = new Set([
  'allowed',
  'allowed_warning',
  'rejected',
])
const RATE_LIMIT_CLAIMS: ReadonlySet<string> = new Set([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'overage',
])
const RATE_LIMIT_FALLBACKS: ReadonlySet<string> = new Set([
  'available',
  'unavailable',
])
const DECIMAL = /^[0-9]{1,15}(\.[0-9]{1,15})?$/
const DELAY_SECONDS = /^[0-9]{1,10}$/
const HTTP_DATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/

/**
 * After disposal a header value can no longer be checked for the exact
 * credentials, so only retry and rate-limit fields whose values are numbers,
 * HTTP dates or members of a closed vocabulary are kept. Those are what retry
 * and quota routing read; everything else is withheld.
 */
function isVerifiableAfterDispose(name: string, value: string): boolean {
  const lower = name.toLowerCase()
  if (lower === 'retry-after')
    return DELAY_SECONDS.test(value) || HTTP_DATE.test(value)
  if (lower === 'x-should-retry') return value === 'true' || value === 'false'
  if (!lower.startsWith(RATE_LIMIT_PREFIX)) return false
  const field = lower.slice(RATE_LIMIT_PREFIX.length)
  if (field === 'status' || field.endsWith('-status'))
    return RATE_LIMIT_STATUSES.has(value)
  if (field === 'representative-claim') return RATE_LIMIT_CLAIMS.has(value)
  if (field === 'fallback') return RATE_LIMIT_FALLBACKS.has(value)
  if (
    field === 'reset' ||
    field.endsWith('-reset') ||
    field.endsWith('-utilization') ||
    field.endsWith('-percentage')
  )
    return DECIMAL.test(value)
  return false
}

type HeaderPolicy = 'keep' | 'scrub' | 'verified-only'

function copyHeaders(
  entries: HeaderEntries,
  policy: HeaderPolicy,
  secrets: readonly string[],
): Headers {
  const copy = new Headers()
  for (const [name, value] of entries) {
    if (policy === 'verified-only' && !isVerifiableAfterDispose(name, value))
      continue
    // A header name cannot be partly redacted, so an entry whose name
    // carries a credential is dropped whole.
    if (policy === 'scrub' && scrubText(name, secrets) !== name) continue
    copy.append(name, policy === 'scrub' ? scrubText(value, secrets) : value)
  }
  // The body may be rewritten, so its original length no longer applies.
  copy.delete('content-length')
  return copy
}

/**
 * Carry the original URL, scrubbed, since a constructed Response has none.
 * After disposal the URL cannot be checked and is left empty.
 */
function withOriginalUrl(
  copy: Response,
  url: string,
  secrets: readonly string[] | null,
): Response {
  if (url !== '' && secrets !== null)
    Object.defineProperty(copy, 'url', {
      value: scrubText(url, secrets),
      enumerable: true,
    })
  return copy
}

/**
 * How a successful body is treated:
 * - `content-type`: an event stream when the response says so (the public
 *   redactor, which has no request context);
 * - `event-stream`: always an event stream, because the request asked for
 *   one, whatever content type the response claims;
 * - `http`: never an event stream; successful bodies pass untouched.
 */
type SuccessFraming = 'content-type' | ProviderResponseMode

function redactResponseParts(
  original: object,
  response: ResponseParts,
  state: RedactorState,
  framing: SuccessFraming,
): unknown {
  const secrets = state.secrets
  const exact = isUntouchedPlatformValue(original, Response.prototype)
  if (response.ok) {
    const eventStream =
      framing === 'content-type'
        ? /text\/event-stream/i.test(contentType(response.headers))
        : framing === 'event-stream'
    // Decided from status, framing, headers and shape alone: a successful
    // response that needs no rewriting is handed back without its body being
    // read.
    if (exact && !eventStream) return original
    const source = response.body()
    if (exact && source === null) return original
    // A subclass or shadowed Response is rebuilt so its overrides cannot run
    // later.
    const body =
      source === null || !eventStream ? source : wrapEventStream(source, state)
    return withOriginalUrl(
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: copyHeaders(response.headers, 'keep', []),
      }),
      response.url,
      secrets,
    )
  }
  // Network-error responses (status 0) carry no status text or body.
  if (response.status === 0) return exact ? original : Response.error()
  const source = NULL_BODY_STATUSES.has(response.status)
    ? null
    : response.body()
  const body = source === null ? null : scrubbedErrorBody(source, state)
  if (secrets === null) {
    // Only verifiable retry/quota headers survive, and the body will be the
    // generic JSON error, so the original content type no longer applies.
    const headers = copyHeaders(response.headers, 'verified-only', [])
    if (body !== null) headers.set('content-type', 'application/json')
    return new Response(body, { status: response.status, headers })
  }
  return withOriginalUrl(
    new Response(body, {
      status: response.status,
      statusText: scrubText(response.statusText, secrets),
      headers: copyHeaders(response.headers, 'scrub', secrets),
    }),
    response.url,
    secrets,
  )
}

function redactResponseWith(
  response: Response,
  state: RedactorState,
): Response {
  const parts = readResponse(response)
  if (!parts) throw new TypeError('Provider error redactor expects a Response')
  const result = redactResponseParts(response, parts, state, 'content-type')
  if (!(result instanceof Response))
    throw new TypeError('Provider error redactor expects a Response')
  return result
}

/**
 * Create a redactor for one request attempt. `secrets` are the exact
 * credentials that attempt sent; pass a new redactor for every attempt so a
 * rotated or fallback credential is scrubbed by the attempt that used it, and
 * call `dispose()` when the attempt ends.
 */
export function createProviderErrorRedactor(
  secrets: readonly string[],
): ProviderErrorRedactor {
  const state: RedactorState = {
    secrets: readSecrets(secrets),
    wrappedBodies: 0,
  }
  return Object.freeze({
    redactText(text: string): string {
      if (typeof text !== 'string')
        throw new TypeError('Provider error redactor expects text')
      const current = state.secrets
      return current === null
        ? PROVIDER_ERROR_WITHHELD_MESSAGE
        : scrubText(text, current)
    },
    redactError(error: unknown): unknown {
      return redactErrorWith(error, state)
    },
    redactResponse(response: Response): Response {
      return redactResponseWith(response, state)
    },
    dispose(): void {
      state.secrets = null
    },
  })
}

/**
 * What the request asked for, which decides how a successful body is
 * treated: `event-stream` for streaming model requests (the body always goes
 * through the error-only SSE rewrite, whatever content type the response
 * claims), `http` for every other request (successful bodies are returned
 * untouched and never read).
 */
export type ProviderResponseMode = 'event-stream' | 'http'

/** How a response scope retired its credentials. */
export type ProviderResponseSettlement =
  | 'eof'
  | 'cancel'
  | 'error'
  | 'untouched'
  | 'disposed'

/**
 * Lifetime of one direct provider response. The credentials are retired at
 * the response's terminal point rather than when the host remembers to
 * dispose.
 */
export interface ProviderErrorResponseScope {
  /**
   * Scrub exactly one response. In `http` mode a successful response is
   * returned as-is without reading its body; in `event-stream` mode a
   * successful body is wrapped so only error envelopes are rewritten,
   * whatever its content type. In both modes a non-2xx response gets
   * scrubbed status text, headers, URL and a lazily scrubbed body. A second
   * call, or any call after the scope has settled, throws a TypeError.
   */
  redactResponse(response: Response): Response
  /** Scrub a thrown error while live; generic once the scope has settled. */
  redactError(error: unknown): unknown
  /** Retire the credentials now. Idempotent. */
  dispose(): void
  /**
   * Resolves once, at the first terminal point, and never rejects:
   * - `eof`, `cancel` or `error` when a wrapped body (a successful event
   *   stream or a non-2xx body) ends, is cancelled by its consumer, or fails;
   * - `untouched` when `redactResponse` returned without wrapping a body,
   *   such as a successful non-event-stream response, whose body is never
   *   read;
   * - `disposed` when `dispose()` came first.
   * It marks the credentials' retirement, not completed I/O cleanup: a
   * source cancellation may still be pending.
   */
  readonly settled: Promise<ProviderResponseSettlement>
}

/** Message of the TypeError thrown when a response scope is reused. */
export const PROVIDER_ERROR_RESPONSE_SCOPE_USED_MESSAGE =
  'Provider error response scope accepts one response while live'

/**
 * Create a response scope for one physical attempt, holding the exact
 * credentials that attempt sent, and the mode of the request that attempt
 * made. Host code that classifies the outcome after
 * the scope settles (retry, rerouting or quota decisions) must use the
 * status, headers and already-scrubbed frames it read during the attempt:
 * once settled, `redactError` only returns a generic error.
 */
export function createProviderErrorResponseScope(
  secrets: readonly string[],
  mode: ProviderResponseMode,
): ProviderErrorResponseScope {
  if (mode !== 'event-stream' && mode !== 'http')
    throw new TypeError(
      "Provider error response scope mode must be 'event-stream' or 'http'",
    )
  const framing: SuccessFraming = mode
  const state: RedactorState = {
    secrets: readSecrets(secrets),
    wrappedBodies: 0,
  }
  let resolveSettled: (settlement: ProviderResponseSettlement) => void =
    () => {}
  const settled = new Promise<ProviderResponseSettlement>((resolve) => {
    resolveSettled = resolve
  })
  let retired = false
  let used = false
  const retire = (settlement: ProviderResponseSettlement) => {
    if (retired) return
    retired = true
    state.secrets = null
    state.onTerminal = undefined
    resolveSettled(settlement)
  }
  state.onTerminal = retire
  const scope: ProviderErrorResponseScope = {
    get settled() {
      return settled
    },
    redactResponse(response: Response): Response {
      if (used || retired)
        throw new TypeError(PROVIDER_ERROR_RESPONSE_SCOPE_USED_MESSAGE)
      const parts = readResponse(response)
      if (!parts)
        throw new TypeError('Provider error redactor expects a Response')
      used = true
      let result: unknown
      try {
        result = redactResponseParts(response, parts, state, framing)
      } catch (error) {
        retire('disposed')
        throw error
      }
      // No wrapped body means nothing else can carry error material through
      // this scope, so the credentials retire as soon as the call returns.
      if (state.wrappedBodies === 0) retire('untouched')
      if (!(result instanceof Response))
        throw new TypeError('Provider error redactor expects a Response')
      return result
    },
    redactError(error: unknown): unknown {
      return redactErrorWith(error, state)
    },
    dispose(): void {
      retire('disposed')
    },
  }
  // Non-enumerable, so serializing the scope shows nothing but `{}`.
  Object.defineProperty(scope, 'settled', { enumerable: false })
  return Object.freeze(scope)
}
