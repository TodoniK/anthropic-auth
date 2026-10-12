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
 */
import { types as utilTypes } from 'node:util'
import {
  createSseFramer,
  DEFAULT_SSE_MAX_FRAME_BYTES,
  decodeSseFrame,
  isSseCandidateFrame,
  isTerminatedSseFrame,
  parseSseFrame,
} from './sse.ts'

export interface ProviderErrorRedactor {
  /** Scrub credentials from error text. */
  redactText(text: string): string
  /**
   * Scrub credentials from any thrown value without running getters. Returns
   * the same value when nothing needed scrubbing; otherwise a copy with the
   * same prototype whose secret-bearing strings are replaced and whose
   * accessor properties are dropped. Platform responses, requests, headers,
   * DOMExceptions and bytes are read through the original platform accessors;
   * Map, Set and similar slot-backed containers are withheld. Never throws.
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

/**
 * Shapes that look like credentials even when the exact value is unknown, for
 * example a token from an earlier attempt echoed back by a proxy. Each one
 * requires enough token characters that ordinary prose ("bearer token",
 * "risk-based") is left alone.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${PROVIDER_ERROR_REDACTION}`],
  [/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g, PROVIDER_ERROR_REDACTION],
  [
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    PROVIDER_ERROR_REDACTION,
  ],
]

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

function scrubText(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets)
    if (result.includes(secret))
      result = result.split(secret).join(PROVIDER_ERROR_REDACTION)
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS)
    result = result.replace(pattern, replacement)
  return result
}

// Platform accessors captured at load time. Responses, requests, headers,
// DOMExceptions and typed arrays keep their data in internal slots; reading
// them through these originals, with Reflect.apply, never runs a getter,
// method or iterator that a subclass or the instance itself overrides. Each
// original also brand-checks its receiver, throwing a TypeError for anything
// that is not really that platform type.
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
const REQUEST_URL = platformGetter(Request.prototype, 'url')
const REQUEST_METHOD = platformGetter(Request.prototype, 'method')
const REQUEST_HEADERS = platformGetter(Request.prototype, 'headers')
const HEADERS_FOR_EACH = Headers.prototype.forEach
const DOM_EXCEPTION_NAME = platformGetter(DOMException.prototype, 'name')
const DOM_EXCEPTION_MESSAGE = platformGetter(DOMException.prototype, 'message')
const TYPED_ARRAY_PROTOTYPE: object = Object.getPrototypeOf(
  Uint8Array.prototype,
)
const TYPED_ARRAY_BUFFER = platformGetter(TYPED_ARRAY_PROTOTYPE, 'buffer')
const TYPED_ARRAY_OFFSET = platformGetter(TYPED_ARRAY_PROTOTYPE, 'byteOffset')
const TYPED_ARRAY_LENGTH = platformGetter(TYPED_ARRAY_PROTOTYPE, 'byteLength')
const DATA_VIEW_BUFFER = platformGetter(DataView.prototype, 'buffer')
const DATA_VIEW_OFFSET = platformGetter(DataView.prototype, 'byteOffset')
const DATA_VIEW_LENGTH = platformGetter(DataView.prototype, 'byteLength')

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
  if (value === null || typeof value !== 'object') return value
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

interface WalkEntry {
  /** Copy being filled while the original's properties are walked. */
  copy: object
  /** Set when a cycle reached this object before its walk finished. */
  referenced: boolean
  /** Final value for the original: itself when unchanged, else `copy`. */
  result?: unknown
}

interface ErrorWalk {
  secrets: readonly string[]
  memo: Map<object, WalkEntry>
  budget: number
  state: RedactorState
}

/** Mirror freeze/seal/extensibility so a frozen original yields a frozen copy. */
function mirrorIntegrity(original: object, copy: object): void {
  if (Object.isFrozen(original)) Object.freeze(copy)
  else if (Object.isSealed(original)) Object.seal(copy)
  else if (!Object.isExtensible(original)) Object.preventExtensions(copy)
}

/** A blank object that keeps the original's prototype and, for errors, its error brand. */
function emptyCopyOf(value: object): object {
  const prototype: object | null = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    const array: unknown[] = []
    Object.setPrototypeOf(array, prototype)
    array.length = value.length
    return array
  }
  if (utilTypes.isNativeError(value)) {
    // `new Error` carries the internal error brand that Object.create lacks,
    // so the copy still prints and type-checks as an error. Its own default
    // fields are removed and replaced with the scrubbed originals below.
    const error = new Error()
    Object.setPrototypeOf(error, prototype)
    for (const key of Reflect.ownKeys(error)) Reflect.deleteProperty(error, key)
    return error
  }
  return Object.create(prototype)
}

function scrubHeaderEntries(
  entries: HeaderEntries,
  secrets: readonly string[],
): { headers: Headers; changed: boolean } {
  const headers = new Headers()
  let changed = false
  for (const [name, value] of entries) {
    const clean = scrubText(value, secrets)
    if (clean !== value) changed = true
    headers.append(name, clean)
  }
  return { headers, changed }
}

/** Containers whose contents live in internal slots that own-property walks cannot see. */
function isOpaqueContainer(value: object): boolean {
  return (
    utilTypes.isMap(value) ||
    utilTypes.isSet(value) ||
    utilTypes.isWeakMap(value) ||
    utilTypes.isWeakSet(value) ||
    utilTypes.isMapIterator(value) ||
    utilTypes.isSetIterator(value) ||
    utilTypes.isPromise(value) ||
    utilTypes.isGeneratorObject(value) ||
    utilTypes.isAnyArrayBuffer(value) ||
    utilTypes.isBoxedPrimitive(value) ||
    utilTypes.isRegExp(value) ||
    (typeof WeakRef === 'function' && value instanceof WeakRef)
  )
}

/**
 * Bytes are always returned as a fresh plain Uint8Array, scrubbed when they
 * decode to text holding a credential: a typed-array subclass or instance
 * override could otherwise change what a consumer reads later.
 */
function scrubBytes(
  buffer: unknown,
  offset: unknown,
  length: unknown,
  secrets: readonly string[],
): unknown {
  if (
    !utilTypes.isAnyArrayBuffer(buffer) ||
    typeof offset !== 'number' ||
    typeof length !== 'number' ||
    length > PROVIDER_ERROR_MAX_BODY_BYTES
  )
    return PROVIDER_ERROR_REDACTION
  const bytes = new Uint8Array(buffer, offset, length)
  const text = decodeSseFrame(bytes)
  const clean = scrubText(text, secrets)
  return clean === text ? bytes.slice() : encoder.encode(clean)
}

/**
 * Values with internal slots cannot be copied property by property. Platform
 * request/response material is read through the captured platform accessors
 * and rebuilt when it carries a credential or is a subclass (whose overrides
 * would otherwise run later). Other slot-backed containers such as Map and
 * Set are withheld whole: classification never needs them, and their
 * contents cannot be inspected without running their iterators. Returns
 * undefined for ordinary objects, which are walked property by property.
 */
function scrubSlottedValue(
  value: object,
  walk: ErrorWalk,
): { value: unknown } | undefined {
  const response = readResponse(value)
  if (response)
    return {
      value: redactResponseParts(value, response, walk.state, 'content-type'),
    }
  const headers = branded(() => headerEntries(value))
  if (headers) {
    const scrubbed = scrubHeaderEntries(headers, walk.secrets)
    const keep =
      !scrubbed.changed && isUntouchedPlatformValue(value, Headers.prototype)
    return { value: keep ? value : scrubbed.headers }
  }
  const method = branded(() => readSlot(REQUEST_METHOD, value))
  if (typeof method === 'string') {
    const rawUrl = readSlot(REQUEST_URL, value)
    const url =
      typeof rawUrl === 'string' ? scrubText(rawUrl, walk.secrets) : ''
    const scrubbed = scrubHeaderEntries(
      headerEntries(readSlot(REQUEST_HEADERS, value)),
      walk.secrets,
    )
    if (
      url === rawUrl &&
      !scrubbed.changed &&
      isUntouchedPlatformValue(value, Request.prototype)
    )
      return { value }
    try {
      return { value: new Request(url, { method, headers: scrubbed.headers }) }
    } catch {
      return { value: PROVIDER_ERROR_REDACTION }
    }
  }
  const message = branded(() => readSlot(DOM_EXCEPTION_MESSAGE, value))
  if (typeof message === 'string') {
    const rawName = readSlot(DOM_EXCEPTION_NAME, value)
    const name = typeof rawName === 'string' ? rawName : 'Error'
    const cleanMessage = scrubText(message, walk.secrets)
    const cleanName = scrubText(name, walk.secrets)
    if (
      cleanMessage === message &&
      cleanName === name &&
      isUntouchedPlatformValue(value, DOMException.prototype)
    )
      return { value }
    return { value: new DOMException(cleanMessage, cleanName) }
  }
  if (utilTypes.isTypedArray(value))
    return {
      value: scrubBytes(
        readSlot(TYPED_ARRAY_BUFFER, value),
        readSlot(TYPED_ARRAY_OFFSET, value),
        readSlot(TYPED_ARRAY_LENGTH, value),
        walk.secrets,
      ),
    }
  if (utilTypes.isDataView(value))
    return {
      value: scrubBytes(
        readSlot(DATA_VIEW_BUFFER, value),
        readSlot(DATA_VIEW_OFFSET, value),
        readSlot(DATA_VIEW_LENGTH, value),
        walk.secrets,
      ),
    }
  if (isOpaqueContainer(value)) return { value: PROVIDER_ERROR_REDACTION }
  return undefined
}

function walkValue(value: unknown, walk: ErrorWalk, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value, walk.secrets)
  if (value === null || typeof value !== 'object') return value
  const seen = walk.memo.get(value)
  if (seen) {
    if (seen.result !== undefined) return seen.result
    seen.referenced = true
    return seen.copy
  }
  // A proxy can run code for every inspection, and depth or size beyond the
  // bound cannot be checked; replace rather than pass such values through.
  if (utilTypes.isProxy(value)) return PROVIDER_ERROR_REDACTION
  walk.budget -= 1
  if (walk.budget < 0 || depth >= MAX_WALK_DEPTH)
    return PROVIDER_ERROR_REDACTION
  const slotted = scrubSlottedValue(value, walk)
  if (slotted) {
    walk.memo.set(value, {
      copy: value,
      referenced: false,
      result: slotted.value,
    })
    return slotted.value
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length > MAX_OBJECT_KEYS) return PROVIDER_ERROR_REDACTION
  const entry: WalkEntry = { copy: emptyCopyOf(value), referenced: false }
  walk.memo.set(value, entry)
  const isArray = Array.isArray(value)
  let changed = false
  const fields: Array<[string | symbol, PropertyDescriptor]> = []
  for (const key of keys) {
    if (isArray && key === 'length') continue
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (field === undefined) continue
    if (!('value' in field)) {
      // Running an accessor could run caller code or reveal a secret; the
      // copy simply omits it.
      changed = true
      continue
    }
    const scrubbedKey =
      typeof key === 'string' ? scrubText(key, walk.secrets) : key
    const scrubbed = walkValue(field.value, walk, depth + 1)
    if (scrubbedKey !== key || scrubbed !== field.value) changed = true
    fields.push([scrubbedKey, { ...field, value: scrubbed }])
  }
  if (!changed && !entry.referenced) {
    entry.result = value
    return value
  }
  for (const [key, field] of fields)
    Object.defineProperty(entry.copy, key, field)
  mirrorIntegrity(value, entry.copy)
  entry.result = entry.copy
  return entry.copy
}

/** Only a finite numeric status survives a generic replacement error. */
function genericError(original: unknown, message: string): Error {
  const error = new Error(message)
  if (original !== null && typeof original === 'object') {
    try {
      if (!utilTypes.isProxy(original)) {
        const status = Object.getOwnPropertyDescriptor(original, 'status')
        if (status && 'value' in status && Number.isFinite(status.value))
          Object.defineProperty(error, 'status', {
            value: status.value,
            enumerable: true,
          })
      }
    } catch {
      // A hostile object can throw from descriptor reads; keep the bare error.
    }
  }
  return error
}

function redactErrorWith(error: unknown, state: RedactorState): unknown {
  const secrets = state.secrets
  if (secrets === null) {
    if (error === null || error === undefined) return error
    if (typeof error === 'string') return PROVIDER_ERROR_WITHHELD_MESSAGE
    if (typeof error !== 'object') return error
    return genericError(error, PROVIDER_ERROR_WITHHELD_MESSAGE)
  }
  try {
    const result = walkValue(
      error,
      { secrets, memo: new Map(), budget: MAX_WALK_OBJECTS, state },
      0,
    )
    if (
      result === PROVIDER_ERROR_REDACTION &&
      error !== null &&
      typeof error === 'object'
    )
      return genericError(
        undefined,
        'Provider error could not be inspected safely',
      )
    return result
  } catch {
    return genericError(
      undefined,
      'Provider error could not be inspected safely',
    )
  }
}

/**
 * Scrub a complete non-2xx body. JSON bodies are parsed so escaped
 * credentials are found too, and re-serialized only when something changed;
 * otherwise the original bytes are kept.
 */
function scrubErrorBody(bytes: Uint8Array, state: RedactorState): Uint8Array {
  const text = decodeSseFrame(bytes)
  const parsed = tryParseJson(text)
  const secrets = state.secrets
  if (secrets === null)
    return encoder.encode(
      genericErrorJson(
        PROVIDER_ERROR_WITHHELD_MESSAGE,
        safeErrorType(parsed?.value),
      ),
    )
  if (parsed) {
    const scrubbed = scrubJson(parsed.value, secrets)
    return scrubbed === parsed.value
      ? bytes
      : encoder.encode(JSON.stringify(scrubbed))
  }
  const clean = scrubText(text, secrets)
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
        try {
          // Acquiring the reader can throw too (a body already locked or
          // read elsewhere), so it shares the error path below.
          active = openReader()
          reader = active
          for (;;) {
            const { done, value } = await active.read()
            if (done) break
            if (!(value instanceof Uint8Array))
              throw new TypeError('Provider error body chunk must be bytes')
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
        deliver(
          controller,
          scrubErrorBody(concatBytes(chunks, total), state),
          true,
        )
        reachTerminal(state, 'eof')
      },
      cancel(reason) {
        // Retire the credentials first: the source's cancel may never settle.
        reachTerminal(state, 'cancel')
        return reader ? reader.cancel(reason) : source.cancel(reason)
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
 */
function rewriteFrame(frame: Uint8Array, state: RedactorState): Uint8Array {
  if (!isSseCandidateFrame(frame)) return frame
  const text = decodeSseFrame(frame)
  const event = parseSseFrame(text)
  const parsed = event.data === undefined ? undefined : tryParseJson(event.data)
  const isError =
    event.event === 'error' ||
    (parsed !== undefined && isErrorPayload(parsed.value))
  if (!isError) return frame
  const secrets = state.secrets
  if (secrets === null)
    return buildFrame(frame, text, {
      event: event.event === undefined ? undefined : 'error',
      data:
        event.data === undefined
          ? undefined
          : genericErrorJson(
              PROVIDER_ERROR_WITHHELD_MESSAGE,
              safeErrorType(parsed?.value),
            ),
    })
  // Comments and unknown fields are dropped from a rewritten error frame, so
  // any credential anywhere in the frame forces the rebuild.
  const fieldsChanged =
    parsed !== undefined
      ? scrubJson(parsed.value, secrets) !== parsed.value
      : event.data !== undefined &&
        scrubText(event.data, secrets) !== event.data
  if (!fieldsChanged && scrubText(text, secrets) === text) return frame
  return buildFrame(frame, text, {
    event:
      event.event === undefined ? undefined : scrubText(event.event, secrets),
    id: event.id === undefined ? undefined : scrubText(event.id, secrets),
    retry: event.retry,
    data:
      parsed !== undefined
        ? JSON.stringify(scrubJson(parsed.value, secrets))
        : event.data === undefined
          ? undefined
          : scrubText(event.data, secrets),
  })
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
        try {
          // Acquiring the reader can throw too (a body already locked or
          // read elsewhere), so it shares the error path below.
          active ??= openReader()
          reader = active
          for (;;) {
            const { done, value } = await active.read()
            if (done) {
              emit(controller, pipeline.finish())
              controller.close()
              reachTerminal(state, 'eof')
              return
            }
            if (!(value instanceof Uint8Array))
              throw new TypeError('Provider event-stream chunk must be bytes')
            const chunks = pipeline.push(value)
            if (chunks.length > 0) {
              emit(controller, chunks)
              return
            }
          }
        } catch (error) {
          // Scrub with the live credentials, retire them, then cancel the
          // source; that cancel may never settle.
          const safe = redactErrorWith(error, state)
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
        return reader ? reader.cancel(reason) : source.cancel(reason)
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
 * carried a credential.
 */
function createFramePipeline(state: RedactorState): FramePipeline {
  const framer = createSseFramer({
    maxFrameBytes: PROVIDER_ERROR_MAX_FRAME_BYTES,
  })
  const rewrite = (frames: Uint8Array[]): Uint8Array[] => {
    const out: Uint8Array[] = []
    let run: Uint8Array | undefined
    for (const frame of frames) {
      const output = rewriteFrame(frame, state)
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
