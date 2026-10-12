import { expect } from 'bun:test'
import {
  createSseFramer,
  decodeSseFrame,
  isSseCandidateFrame,
  isTerminatedSseFrame,
  parseSseFrame,
  SseFrameTooLargeError,
} from '../sse.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test } = createTestLifetimeSuite()
const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text)
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Frames as the stream should split them; their concatenation is the stream. */
const MIXED_FRAMES = [
  ': keep-alive comment\n\n',
  'event: message_start\r\ndata: {"type":"message_start"}\r\n\r\n',
  'event: ping\rdata: {"type":"ping"}\r\r',
  'data: first line\ndata: 中文 and 🙂 emoji\r\n\n',
  '\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"error handling"}}\n\r\n',
  'data: {"type":"message_stop"}\n\n',
]
const MIXED_TAIL = 'data: {"type":"tail-without-blank-line"}\n'
const MIXED_STREAM = bytes(MIXED_FRAMES.join('') + MIXED_TAIL)

function frameAll(chunks: Uint8Array[]) {
  const framer = createSseFramer()
  const frames: Uint8Array[] = []
  for (const chunk of chunks) frames.push(...framer.push(chunk))
  const tail = framer.finish()
  return { frames, tail }
}

test('frames reassemble to the exact input bytes at every two-chunk split point', () => {
  const expectedFrames = MIXED_FRAMES.map((frame) => [...bytes(frame)])
  for (let split = 0; split <= MIXED_STREAM.length; split++) {
    const { frames, tail } = frameAll([
      MIXED_STREAM.subarray(0, split),
      MIXED_STREAM.subarray(split),
    ])
    expect(frames.map((frame) => [...frame])).toEqual(expectedFrames)
    expect(tail ? [...tail] : undefined).toEqual([...bytes(MIXED_TAIL)])
    expect([...concat([...frames, ...(tail ? [tail] : [])])]).toEqual([
      ...MIXED_STREAM,
    ])
  }
})

test('one-byte chunks split UTF-8 characters and still yield whole frames', () => {
  const { frames, tail } = frameAll(
    [...MIXED_STREAM].map((byte) => Uint8Array.of(byte)),
  )
  expect(frames.map((frame) => decodeSseFrame(frame))).toEqual(MIXED_FRAMES)
  expect(tail && decodeSseFrame(tail)).toBe(MIXED_TAIL)
})

test('a CR ending one chunk waits for the next byte before ending the frame', () => {
  const framer = createSseFramer()
  expect(framer.push(bytes('data: a\r'))).toEqual([])
  // The LF completes CRLF; the frame must not end at the CR alone.
  expect(framer.push(bytes('\n'))).toEqual([])
  expect(framer.bufferedBytes).toBe(9)
  const frames = framer.push(bytes('\r'))
  expect(frames).toEqual([])
  const done = framer.push(bytes('\ndata: b'))
  expect(done.map(decodeSseFrame)).toEqual(['data: a\r\n\r\n'])
  expect(decodeSseFrame(framer.finish() ?? bytes(''))).toBe('data: b')
})

test('lone CR terminators frame immediately once the following byte is not LF', () => {
  const framer = createSseFramer()
  const frames = framer.push(bytes('data: a\r\rdata: b\r\rx'))
  expect(frames.map(decodeSseFrame)).toEqual(['data: a\r\r', 'data: b\r\r'])
  expect(decodeSseFrame(framer.finish() ?? bytes(''))).toBe('x')
})

test('a stream ending on a lone CR keeps it in the EOF tail', () => {
  const framer = createSseFramer()
  expect(framer.push(bytes('data: a\n\r'))).toEqual([])
  const tail = framer.finish()
  expect(tail && decodeSseFrame(tail)).toBe('data: a\n\r')
  expect(tail && isTerminatedSseFrame(tail)).toBe(true)
})

test('frames over the byte bound fail loudly and stay failed', () => {
  const framer = createSseFramer({ maxFrameBytes: 16 })
  expect(framer.push(bytes('data: 1234567\n\n')).map(decodeSseFrame)).toEqual([
    'data: 1234567\n\n',
  ])
  expect(() => framer.push(bytes('data: 12345678901'))).toThrow(
    SseFrameTooLargeError,
  )
  expect(() => framer.push(bytes('\n\n'))).toThrow(SseFrameTooLargeError)
  expect(() => framer.finish()).toThrow(SseFrameTooLargeError)
})

test('a frame of exactly the byte bound is accepted whole or split', () => {
  const frame = 'data: 12345678\n\n'
  expect(bytes(frame).length).toBe(16)
  const whole = createSseFramer({ maxFrameBytes: 16 })
  expect(whole.push(bytes(frame + frame)).map(decodeSseFrame)).toEqual([
    frame,
    frame,
  ])
  const split = createSseFramer({ maxFrameBytes: 16 })
  expect(split.push(bytes('data: 1234'))).toEqual([])
  expect(split.push(bytes('5678\n')).map(decodeSseFrame)).toEqual([])
  expect(split.push(bytes('\n')).map(decodeSseFrame)).toEqual([frame])
  expect(split.bufferedBytes).toBe(0)
})

test('a complete frame over the bound is refused even when terminated in one chunk', () => {
  const oversized = 'data: 123456789\n\n'
  expect(bytes(oversized).length).toBe(17)
  const alone = createSseFramer({ maxFrameBytes: 16 })
  expect(() => alone.push(bytes(oversized))).toThrow(SseFrameTooLargeError)
  const afterValid = createSseFramer({ maxFrameBytes: 16 })
  expect(() => afterValid.push(bytes(`data: 1\n\n${oversized}`))).toThrow(
    SseFrameTooLargeError,
  )
  const carried = createSseFramer({ maxFrameBytes: 16 })
  expect(carried.push(bytes('data: 12345'))).toEqual([])
  expect(() => carried.push(bytes('6789\n\n'))).toThrow(SseFrameTooLargeError)
})

test('an unterminated chunk over the bound is refused before it is buffered', () => {
  const framer = createSseFramer({ maxFrameBytes: 16 })
  expect(() => framer.push(new Uint8Array(1024 * 1024).fill(0x61))).toThrow(
    SseFrameTooLargeError,
  )
  expect(framer.bufferedBytes).toBe(0)
})

test('framer options are read without running accessors', () => {
  let reads = 0
  const options = {}
  Object.defineProperty(options, 'maxFrameBytes', {
    get() {
      reads++
      return 4
    },
  })
  expect(() => createSseFramer(options)).toThrow(TypeError)
  expect(reads).toBe(0)
  // Reflect.apply passes deliberately invalid arguments without a type cast
  // that would make the call look valid to TypeScript.
  for (const maxFrameBytes of [0, -1, 1.5, Number.NaN, '4'])
    expect(() =>
      Reflect.apply(createSseFramer, undefined, [{ maxFrameBytes }]),
    ).toThrow(TypeError)
  expect(() => Reflect.apply(createSseFramer, undefined, [null])).toThrow(
    TypeError,
  )
  const framer = createSseFramer()
  expect(() => Reflect.apply(framer.push, framer, ['data'])).toThrow(TypeError)
})

test('parseSseFrame applies event-stream field rules across line endings', () => {
  expect(
    parseSseFrame(
      bytes(
        ': comment\r\nevent: error\rdata:  two spaces\ndata\r\nid: 7\nretry: 1500\nunknown: x\n\n',
      ),
    ),
  ).toEqual({
    event: 'error',
    data: ' two spaces\n',
    id: '7',
    retry: 1500,
  })
  expect(parseSseFrame(': heartbeat\n\n')).toEqual({})
  expect(parseSseFrame('id: a\u0000b\nretry: 1.5\ndata: x')).toEqual({
    data: 'x',
  })
  expect(parseSseFrame('event\ndata:\n\n')).toEqual({ event: '', data: '' })
})

test('the candidate gate admits literal error and JSON escapes only', () => {
  expect(isSseCandidateFrame(bytes('data: {"type":"error"}\n\n'))).toBe(true)
  expect(isSseCandidateFrame(bytes('data: {"\\u0074ype":"x"}\n\n'))).toBe(true)
  expect(isSseCandidateFrame(bytes('data: {"type":"ping"}\n\n'))).toBe(false)
  expect(isSseCandidateFrame(bytes('data: 中文🙂\n\n'))).toBe(false)
  // The gate reads only the view it is given, not the rest of its buffer.
  const shared = bytes('data: ok\n\nerror')
  expect(isSseCandidateFrame(shared.subarray(0, 10))).toBe(false)
})

test('isTerminatedSseFrame distinguishes complete frames from EOF tails', () => {
  for (const frame of ['\n', 'a\n\n', 'a\r\n\r\n', 'a\r\r', 'a\n\r\n'])
    expect(isTerminatedSseFrame(bytes(frame))).toBe(true)
  for (const frame of ['', 'a', 'a\n', 'a\r\n', 'a\r'])
    expect(isTerminatedSseFrame(bytes(frame))).toBe(false)
})

test('framer options that are a Proxy are rejected without running a trap', () => {
  let ran = 0
  const options = new Proxy(
    { maxFrameBytes: 16 },
    {
      getOwnPropertyDescriptor(target, key) {
        ran++
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      get(target, key, receiver) {
        ran++
        return Reflect.get(target, key, receiver)
      },
    },
  )
  expect(() => createSseFramer(options)).toThrow(TypeError)
  expect(ran).toBe(0)
})

test('decodeSseFrame keeps a byte-order mark unless the frame starts the stream', () => {
  const frame = bytes('\uFEFFevent: error\ndata: x\n\n')
  expect(decodeSseFrame(frame)).toBe('\uFEFFevent: error\ndata: x\n\n')
  expect(parseSseFrame(frame)).toEqual({ data: 'x' })
  expect(decodeSseFrame(frame, { streamStart: true })).toBe(
    'event: error\ndata: x\n\n',
  )
  // Only one leading mark is ignored, even at the stream start.
  expect(
    decodeSseFrame(bytes('\uFEFF\uFEFFdata: x\n\n'), { streamStart: true }),
  ).toBe('\uFEFFdata: x\n\n')
})
