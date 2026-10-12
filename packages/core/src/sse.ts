/**
 * Byte-level Server-Sent Events framing shared by the stream parsers and the
 * provider-error redactor.
 *
 * Framing works on raw bytes so callers can forward successful frames
 * unchanged: the concatenation of every frame returned by a framer (plus the
 * final `finish()` tail) is exactly the input byte sequence. A frame ends at a
 * blank line, where a line ends in CRLF, LF or a lone CR (WHATWG
 * `text/event-stream` rules). CR and LF bytes never occur inside a multi-byte
 * UTF-8 sequence, so splitting on them never cuts a character in half; a
 * character split across network chunks simply stays in the carried partial
 * frame until the frame is complete.
 */
import { types as utilTypes } from 'node:util'

/** Largest single frame a framer accepts before it refuses the stream. */
export const DEFAULT_SSE_MAX_FRAME_BYTES = 8 * 1024 * 1024

const LF = 0x0a
const CR = 0x0d

/**
 * Raised when a single frame, terminated or not, grows past the framer's
 * byte bound. The framer cannot continue after this error. The message
 * carries only sizes, never frame content.
 */
export class SseFrameTooLargeError extends Error {
  readonly code = 'SSE_FRAME_TOO_LARGE'
  readonly maxFrameBytes: number

  constructor(maxFrameBytes: number) {
    super(`SSE frame exceeded ${maxFrameBytes} bytes without a terminator`)
    this.name = 'SseFrameTooLargeError'
    this.maxFrameBytes = maxFrameBytes
  }
}

export interface SseFramerOptions {
  /** Upper bound for one frame, complete or partial, in bytes. */
  maxFrameBytes?: number
}

export interface SseFramer {
  /**
   * Feed the next chunk of the stream. Returns every frame completed by this
   * chunk, in order. Each frame includes its own line terminators and the
   * blank line that ends it. Returned arrays may be views of `chunk`, so
   * callers must not mutate them. Throws `SseFrameTooLargeError` when any
   * single frame, complete or still partial, exceeds the bound; frames
   * completed earlier in the same chunk are not returned in that case, and
   * the framer refuses all later input.
   */
  push(chunk: Uint8Array): Uint8Array[]
  /**
   * Signal end of input and return the unterminated tail, if any. A stream
   * that ends mid-frame yields that partial frame here instead of losing it.
   */
  finish(): Uint8Array | undefined
  /** Bytes of the current partial frame held while waiting for its end. */
  readonly bufferedBytes: number
}

function readMaxFrameBytes(options: SseFramerOptions | undefined): number {
  if (options === undefined) return DEFAULT_SSE_MAX_FRAME_BYTES
  // Reject proxies before inspecting maxFrameBytes: descriptor lookup can run their traps.
  if (
    options === null ||
    typeof options !== 'object' ||
    utilTypes.isProxy(options)
  )
    throw new TypeError('SSE framer options must be an object')
  // Read through the descriptor so an accessor is rejected rather than run.
  const field = Object.getOwnPropertyDescriptor(options, 'maxFrameBytes')
  if (field === undefined) return DEFAULT_SSE_MAX_FRAME_BYTES
  if (!('value' in field))
    throw new TypeError('SSE framer maxFrameBytes must be a data property')
  const value: unknown = field.value
  if (value === undefined) return DEFAULT_SSE_MAX_FRAME_BYTES
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new TypeError('SSE framer maxFrameBytes must be a positive integer')
  return value
}

export function createSseFramer(options?: SseFramerOptions): SseFramer {
  const maxFrameBytes = readMaxFrameBytes(options)
  // Bytes of the current partial frame received in earlier chunks. Never
  // larger than maxFrameBytes: the size is checked before anything is copied.
  let carry = new Uint8Array(0)
  let carryLength = 0
  // True when the carried frame ends at the start of a line (after a line
  // terminator, or at the very start of the frame).
  let carryAtLineStart = true
  // The carried frame ends with a CR whose line ending is undecided: a
  // following LF belongs to the same CRLF terminator. `pendingBlank` records
  // that this CR ended an empty line, so the frame ends with it.
  let pendingCr = false
  let pendingBlank = false
  let failed = false

  const fail = (): never => {
    failed = true
    carry = new Uint8Array(0)
    carryLength = 0
    throw new SseFrameTooLargeError(maxFrameBytes)
  }

  const keep = (bytes: Uint8Array, append: boolean) => {
    const needed = (append ? carryLength : 0) + bytes.length
    if (needed > maxFrameBytes) fail()
    if (carry.length < needed) {
      const grown = new Uint8Array(
        Math.min(maxFrameBytes, Math.max(needed, carry.length * 2, 1024)),
      )
      if (append) grown.set(carry.subarray(0, carryLength), 0)
      carry = grown
    }
    carry.set(bytes, append ? carryLength : 0)
    carryLength = needed
  }

  const push = (chunk: Uint8Array): Uint8Array[] => {
    if (failed) throw new SseFrameTooLargeError(maxFrameBytes)
    if (!utilTypes.isUint8Array(chunk))
      throw new TypeError('SSE framer input must be a Uint8Array')
    const end = chunk.length
    if (end === 0) return []
    const frames: Uint8Array[] = []
    // Positions below are offsets into `chunk`. The first frame completed by
    // this chunk is the carried bytes followed by chunk[0, frame end).
    let frameStart = 0
    let pos = 0
    // Start of the current line, or -1 when the line began in the carry and
    // already has content.
    let line = carryAtLineStart ? 0 : -1
    const complete = (frameEnd: number) => {
      if (carryLength > 0) {
        const size = carryLength + frameEnd
        if (size > maxFrameBytes) fail()
        const joined = new Uint8Array(size)
        joined.set(carry.subarray(0, carryLength), 0)
        joined.set(chunk.subarray(0, frameEnd), carryLength)
        carryLength = 0
        frames.push(joined)
      } else {
        if (frameEnd - frameStart > maxFrameBytes) fail()
        frames.push(chunk.subarray(frameStart, frameEnd))
      }
      frameStart = frameEnd
    }
    if (pendingCr) {
      pendingCr = false
      if (chunk[0] === LF) pos = 1
      if (pendingBlank) {
        pendingBlank = false
        complete(pos)
      }
      line = pos
    }
    let nextLf = -2
    let nextCr = -2
    while (pos < end) {
      if (nextLf !== -1 && nextLf < pos) nextLf = chunk.indexOf(LF, pos)
      if (nextCr !== -1 && nextCr < pos) nextCr = chunk.indexOf(CR, pos)
      let terminator: number
      if (nextLf === -1) terminator = nextCr
      else if (nextCr === -1) terminator = nextLf
      else terminator = Math.min(nextLf, nextCr)
      if (terminator === -1) break
      let terminatorEnd = terminator + 1
      if (chunk[terminator] === CR) {
        if (terminatorEnd === end) {
          // A CR as the last byte may be the first half of CRLF; the next
          // chunk decides. The CR itself is part of the carried frame.
          pendingCr = true
          pendingBlank = terminator === line
          line = end
          break
        }
        if (chunk[terminatorEnd] === LF) terminatorEnd += 1
      }
      // An empty line ends the frame, including the empty line itself.
      if (terminator === line) complete(terminatorEnd)
      line = terminatorEnd
      pos = terminatorEnd
    }
    if (frameStart < end) {
      // The unfinished frame is kept; its size is checked before copying so
      // a huge unterminated chunk is refused without being buffered.
      keep(chunk.subarray(frameStart, end), carryLength > 0)
      carryAtLineStart = line === end
    } else {
      carryAtLineStart = true
    }
    return frames
  }

  const finish = (): Uint8Array | undefined => {
    if (failed) throw new SseFrameTooLargeError(maxFrameBytes)
    const tail = carryLength > 0 ? carry.slice(0, carryLength) : undefined
    carry = new Uint8Array(0)
    carryLength = 0
    carryAtLineStart = true
    pendingCr = false
    pendingBlank = false
    return tail
  }

  return Object.freeze({
    push,
    finish,
    get bufferedBytes() {
      return carryLength
    },
  })
}

/** One parsed frame. Field values follow the WHATWG event-stream rules. */
export interface SseEvent {
  /** Last `event:` value, or undefined when the frame sets none. */
  event?: string
  /**
   * All `data:` lines joined with LF, or undefined when the frame has no data
   * line (a comment or heartbeat that dispatches no event).
   */
  data?: string
  /** Last `id:` value, ignoring values that contain NUL. */
  id?: string
  /** Last `retry:` value made only of ASCII digits. */
  retry?: number
}

// ignoreBOM keeps U+FEFF in the output: a frame is usually not the start of
// its stream, and only the stream start may drop a byte-order mark.
const frameDecoder = new TextDecoder('utf-8', { ignoreBOM: true })
const BYTE_ORDER_MARK = 0xfeff

export interface SseDecodeOptions {
  /**
   * The frame is the first one of its stream, so one leading byte-order mark
   * is dropped as the event-stream rules require. Elsewhere U+FEFF is an
   * ordinary character (for example part of a field name) and is kept.
   */
  streamStart?: boolean
}

function readStreamStart(options: unknown): boolean {
  if (
    options === null ||
    typeof options !== 'object' ||
    utilTypes.isProxy(options)
  )
    return false
  const field = Object.getOwnPropertyDescriptor(options, 'streamStart')
  return field !== undefined && 'value' in field && field.value === true
}

/**
 * Decode a frame as UTF-8, replacing invalid sequences like EventSource. A
 * leading byte-order mark is dropped only for the first frame of a stream.
 * The one-argument form stays usable as an `Array.prototype.map` callback.
 */
export function decodeSseFrame(frame: Uint8Array): string
export function decodeSseFrame(
  frame: Uint8Array,
  options: SseDecodeOptions,
): string
export function decodeSseFrame(frame: Uint8Array, options?: unknown): string {
  const text = frameDecoder.decode(frame)
  return text.charCodeAt(0) === BYTE_ORDER_MARK && readStreamStart(options)
    ? text.slice(1)
    : text
}

/**
 * Parse one frame produced by `createSseFramer`. Accepts CRLF, LF and CR line
 * endings in any mix, comment lines, fields without a colon and multi-line
 * data. Unknown fields are ignored.
 */
export function parseSseFrame(frame: Uint8Array | string): SseEvent {
  const text = typeof frame === 'string' ? frame : decodeSseFrame(frame)
  const result: SseEvent = {}
  let dataLines: string[] | undefined
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '' || line.charCodeAt(0) === 0x3a) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.charCodeAt(0) === 0x20) value = value.slice(1)
    switch (field) {
      case 'event':
        result.event = value
        break
      case 'data':
        if (dataLines) dataLines.push(value)
        else dataLines = [value]
        break
      case 'id':
        if (!value.includes('\u0000')) result.id = value
        break
      case 'retry':
        if (/^[0-9]+$/.test(value)) result.retry = Number(value)
        break
    }
  }
  if (dataLines) result.data = dataLines.join('\n')
  return result
}

/** True when the frame ends with a blank line rather than being an EOF tail. */
export function isTerminatedSseFrame(frame: Uint8Array): boolean {
  const length = frame.length
  if (length === 0) return false
  const last = frame[length - 1]
  if (last !== LF && last !== CR) return false
  // Step back over the final terminator (CRLF counts as one) and require the
  // byte before it to be another terminator, or the frame to be only that
  // terminator: either way the frame's last line is empty.
  let before = length - 1
  if (last === LF && before > 0 && frame[before - 1] === CR) before -= 1
  if (before === 0) return true
  const previous = frame[before - 1]
  return previous === LF || previous === CR
}

const ERROR_NEEDLE = Buffer.from('error')
const UNICODE_ESCAPE_NEEDLE = Buffer.from('\\u')

/**
 * Cheap raw-byte gate for frames that might be error envelopes: the literal
 * `error`, or any JSON `\u` escape, which could spell an `error` key or type
 * without the literal appearing. Frames that fail this gate cannot be error
 * envelopes and are never decoded. Frames that pass still need parsing; a
 * successful text delta that mentions "error" passes the gate too.
 */
export function isSseCandidateFrame(frame: Uint8Array): boolean {
  const view = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
  return (
    view.indexOf(ERROR_NEEDLE) !== -1 ||
    view.indexOf(UNICODE_ESCAPE_NEEDLE) !== -1
  )
}
