/**
 * Measures what the provider-error response scope adds to reading a
 * successful Anthropic event stream, on the path streaming model requests
 * use: `createProviderErrorResponseScope(secrets, 'event-stream')`.
 *
 * Each scenario is a frozen, deterministic 2,000-event stream cut into frozen
 * pseudo-random chunk sizes (so chunks split frames and UTF-8 characters).
 * Every run reads the same chunks twice: once straight from the source
 * ("before", what an unwrapped host reads) and once through a fresh scope's
 * `redactResponse` ("after"). The order alternates per run so drift affects
 * both sides equally. Every output is checked byte-for-byte against the input,
 * and every scope must settle `eof`.
 *
 * It also times one credential scan of 'eyJ-' repeated, the input on which a
 * backtracking JWT pattern is quadratic. Those are single runs per size,
 * reported as measured, not a model of larger inputs.
 *
 * Usage: bun scripts/benchmark-provider-errors.ts [--runs N] [--warmup N]
 * Prints one JSON document with the input/output digests, every raw per-run
 * timing in milliseconds, the median and p95 of the paired overhead, and the
 * scan timings.
 */
import { createHash } from 'node:crypto'
import { availableParallelism, cpus } from 'node:os'
import {
  createProviderErrorRedactor,
  createProviderErrorResponseScope,
} from '../packages/core/src/provider-error.ts'

const EVENTS = 2000
const CHUNK_SEED = 0x5eed1234
const encoder = new TextEncoder()
// Synthetic credential; no real account material is used here.
const SYNTHETIC_TOKEN = `sk-ant-oat01-${'BenchToken_-'.repeat(8)}AA`

function readFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} needs a positive integer`)
  return value
}

function frame(event: string, payload: string): string {
  return `event: ${event}\ndata: ${payload}\n\n`
}

function escapeAll(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index += 1)
    out += `\\u${text.charCodeAt(index).toString(16).padStart(4, '0')}`
  return out
}

/** A complete message stream whose content deltas carry `delta(index)` as raw JSON string content. */
function messageStream(delta: (index: number) => string): string {
  const parts = [
    frame(
      'message_start',
      '{"type":"message_start","message":{"id":"msg_bench","type":"message","role":"assistant","content":[],"model":"claude-bench","usage":{"input_tokens":12,"output_tokens":1}}}',
    ),
    frame(
      'content_block_start',
      '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    ),
  ]
  // Two start frames, ping, stop, delta and message stop make up the rest.
  const deltas = EVENTS - 6
  parts.push(frame('ping', '{"type": "ping"}'))
  for (let index = 0; index < deltas; index += 1)
    parts.push(
      frame(
        'content_block_delta',
        `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${delta(index)}"}}`,
      ),
    )
  parts.push(
    frame('content_block_stop', '{"type":"content_block_stop","index":0}'),
    frame(
      'message_delta',
      '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1994}}',
    ),
    frame('message_stop', '{"type":"message_stop"}'),
  )
  return parts.join('')
}

const CJK_EMOJI = '中文测试数据流🙂😀日本語のテキスト한국어🚀'

const scenarios = {
  // Ordinary prose: no frame passes the raw candidate gate.
  ascii: messageStream(
    (index) =>
      `Chunk ${index}: the quick brown fox jumps over the lazy dog, then naps.`,
  ),
  // Every delta mentions "error", so every frame is decoded and parsed.
  'ascii-mentions-error': messageStream(
    (index) =>
      `Chunk ${index}: the quick brown fox jumps over the lazy dog, error handling notes.`,
  ),
  'raw-cjk-emoji': messageStream(
    (index) => `${index} ${CJK_EMOJI}${CJK_EMOJI}`,
  ),
  // Serialized \uXXXX text in every delta: each frame passes the raw
  // candidate gate, so this is the gate's worst case.
  'escaped-cjk-emoji': messageStream(
    (index) => `${index} ${escapeAll(CJK_EMOJI.repeat(6))}`,
  ),
}

/** Frozen chunk sizes from a fixed LCG seed, between 1 byte and 4 KiB. */
function chunk(bytes: Uint8Array): Uint8Array[] {
  let state = CHUNK_SEED
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; ) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const size = 1 + (state % 4096)
    chunks.push(bytes.slice(offset, offset + size))
    offset += size
  }
  return chunks
}

function source(chunks: Uint8Array[]): Response {
  let index = 0
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const next = chunks[index++]
          if (next) controller.enqueue(next)
          else controller.close()
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

async function drain(response: Response, expected: Uint8Array) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('missing body')
  const hash = createHash('sha256')
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    // Compare every byte; a hash alone could hide where output diverged.
    for (let index = 0; index < value.length; index += 1)
      if (value[index] !== expected[length + index])
        throw new Error(`output differs from input at byte ${length + index}`)
    hash.update(value)
    length += value.length
  }
  if (length !== expected.length)
    throw new Error(
      `output length ${length} != input length ${expected.length}`,
    )
  return hash.digest('hex')
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.ceil(fraction * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? Number.NaN
}

const round = (value: number) => Math.round(value * 1e4) / 1e4

async function measure(
  name: string,
  text: string,
  runs: number,
  warmup: number,
) {
  const input = encoder.encode(text)
  const chunks = chunk(input)
  const inputSha256 = createHash('sha256').update(input).digest('hex')
  const before: number[] = []
  const after: number[] = []
  const outputDigests = new Set<string>()
  const readBefore = async () => {
    const start = performance.now()
    outputDigests.add(await drain(source(chunks), input))
    return performance.now() - start
  }
  const readAfter = async () => {
    const start = performance.now()
    // A fresh scope per read, as hosts create one per request attempt.
    const scope = createProviderErrorResponseScope(
      [SYNTHETIC_TOKEN],
      'event-stream',
    )
    outputDigests.add(await drain(scope.redactResponse(source(chunks)), input))
    const settlement = await scope.settled
    if (settlement !== 'eof')
      throw new Error(`${name}: scope settled ${settlement}, not eof`)
    return performance.now() - start
  }
  for (let run = 0; run < warmup + runs; run += 1) {
    let plain: number
    let redacted: number
    if (run % 2 === 0) {
      plain = await readBefore()
      redacted = await readAfter()
    } else {
      redacted = await readAfter()
      plain = await readBefore()
    }
    if (run >= warmup) {
      before.push(plain)
      after.push(redacted)
    }
  }
  if (outputDigests.size !== 1 || !outputDigests.has(inputSha256))
    throw new Error(`${name}: output digest differs from input digest`)
  const overhead = after.map((value, index) => value - (before[index] ?? 0))
  const summary = (values: number[]) => ({
    median: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
  })
  const beforeMedian = percentile(before, 0.5)
  return {
    scenario: name,
    events: (text.match(/\n\n/g) ?? []).length,
    inputBytes: input.length,
    chunks: chunks.length,
    inputSha256,
    outputSha256: [...outputDigests][0],
    outputMatchesInputEveryRun: true,
    beforeMs: summary(before),
    afterMs: summary(after),
    overheadMs: summary(overhead),
    overheadPercentOfBeforeMedian: {
      median: round((percentile(overhead, 0.5) / beforeMedian) * 100),
      p95: round((percentile(overhead, 0.95) / beforeMedian) * 100),
    },
    raw: {
      beforeMs: before.map(round),
      afterMs: after.map(round),
    },
  }
}

/** One scan per size of text with many JWT-like starts and no match. */
function jwtScanTimings() {
  const redactor = createProviderErrorRedactor([SYNTHETIC_TOKEN])
  const timings = []
  for (const repeats of [2048, 16 * 1024, 64 * 1024, 256 * 1024]) {
    const text = 'eyJ-'.repeat(repeats)
    const start = performance.now()
    const out = redactor.redactText(text)
    const ms = performance.now() - start
    if (out !== text) throw new Error('JWT scan changed text without a JWT')
    timings.push({ chars: text.length, ms: round(ms) })
  }
  redactor.dispose()
  return timings
}

const runs = readFlag('--runs', 200)
const warmup = readFlag('--warmup', 20)
const results = []
for (const [name, text] of Object.entries(scenarios))
  results.push(await measure(name, text, runs, warmup))
console.log(
  JSON.stringify({
    runtime: {
      bun: typeof Bun === 'undefined' ? null : Bun.version,
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? null,
      parallelism: availableParallelism(),
    },
    runs,
    warmup,
    chunkSeed: CHUNK_SEED,
    results,
    jwtScanSingleRuns: jwtScanTimings(),
  }),
)
