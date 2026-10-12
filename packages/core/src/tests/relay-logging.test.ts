import { expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, gate, trackDetached, deferCleanup } = createTestLifetimeSuite()
const opaque = 'opaqueRelayCredential123456789'
const oauth = 'sk-ant-oat01-synthetic-relay-log-control'
const relayPath = new URL('../relay.ts', import.meta.url).href
const dumpPath = new URL('../dump.ts', import.meta.url).href

async function loggedChild(script: string) {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-relay-log-'))
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
    const failures = [exit, out, err].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    if (failures.length)
      throw new AggregateError(failures, 'Relay log fixture drainage failed')
    if (
      exit.status !== 'fulfilled' ||
      out.status !== 'fulfilled' ||
      err.status !== 'fulfilled'
    )
      throw new Error('Relay log result missing')
    expect(err.value).toBe('')
    expect(exit.value).toBe(0)
    return {
      stdout: out.value,
      log: await readFile(log, 'utf8').catch((error) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return ''
        throw error
      }),
    }
  } finally {
    cancellation.open()
  }
}

for (const fallback of [false, true]) {
  test(`real relay failure logs omit credentials with direct fallback=${fallback}`, async () => {
    const script = `
      import { sendViaRelay } from ${JSON.stringify(relayPath)}
      import { setDumpEnabled } from ${JSON.stringify(dumpPath)}
      setDumpEnabled(false)
      const token = ${JSON.stringify(opaque)}, oauth = ${JSON.stringify(oauth)}
      let posts = 0, direct = 0, threw = false
      const original = globalThis.fetch
      const mocked: typeof fetch = Object.assign(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url !== 'https://relay-control.example.invalid/') throw new Error('Unexpected external URL')
        posts++
        throw new Error('synthetic connection failure ' + token + ' Bearer ' + oauth)
      }, { preconnect() {} })
      globalThis.fetch = mocked
      try {
        await sendViaRelay({ config: { enabled: true, url: 'https://relay-control.example.invalid/', token, transport: 'http', fallbackToDirect: ${fallback} }, input: 'https://api.anthropic.com/v1/messages', init: { method: 'POST' }, headers: new Headers({ authorization: 'Bearer ' + oauth }), body: JSON.stringify({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'synthetic' }] }), affinity: 'synthetic-log-control', fallback: async () => { direct++; return new Response('healthy direct') } })
      } catch { threw = true }
      finally { globalThis.fetch = original }
      if (posts !== 1 || direct !== ${fallback ? 1 : 0} || threw !== ${!fallback}) throw new Error('Did not reach the expected physical attempt')
      console.log('PHYSICAL_RELAY_ATTEMPT=1; EXTERNAL_HTTP=0')
    `
    const result = await loggedChild(script)
    expect(result.stdout).toContain('PHYSICAL_RELAY_ATTEMPT=1; EXTERNAL_HTTP=0')
    expect(result.log).toContain('relay failed')
    expect(result.log).toContain('synthetic-lo')
    expect(result.log).not.toContain(opaque)
    expect(result.log).not.toContain(oauth)
    expect(result.log).not.toContain('synthetic connection failure')
  })
}

test('real healthy relay logs retain stable metadata', async () => {
  const result = await loggedChild(`
    import { sendViaRelay } from ${JSON.stringify(relayPath)}
    import { setDumpEnabled } from ${JSON.stringify(dumpPath)}
    setDumpEnabled(false)
    let posts = 0
    globalThis.fetch = Object.assign(async () => { posts++; return new Response('healthy', { status: 200 }) }, { preconnect() {} })
    const response = await sendViaRelay({ config: { enabled: true, url: 'https://relay-control.example.invalid/', token: ${JSON.stringify(opaque)}, transport: 'http', fallbackToDirect: false }, input: 'https://api.anthropic.com/v1/messages', init: { method: 'POST' }, headers: new Headers({ authorization: ${JSON.stringify(`Bearer ${oauth}`)} }), body: JSON.stringify({ messages: [] }), affinity: 'synthetic-log-control', fallback: async () => { throw new Error('Unexpected fallback') } })
    if (posts !== 1 || response.status !== 200 || await response.text() !== 'healthy') throw new Error('Healthy relay failed')
    console.log('PHYSICAL_RELAY_ATTEMPT=1; EXTERNAL_HTTP=0')
  `)
  expect(result.stdout).toContain('PHYSICAL_RELAY_ATTEMPT=1; EXTERNAL_HTTP=0')
  expect(result.log).toContain('used relay transport=http')
  expect(result.log).toContain('status=200')
  expect(result.log).not.toContain(opaque)
  expect(result.log).not.toContain(oauth)
})

test('Worker checkpoint diagnostics omit arbitrary storage exception text', async () => {
  const result = await loggedChild(`
    import { WORKER_SCRIPT, hashBody } from ${JSON.stringify(relayPath)}
    const url = URL.createObjectURL(new Blob([WORKER_SCRIPT + '\\nexport { checkpointWebSocketState };'], { type: 'application/javascript' }))
    const loaded: unknown = await import(url)
    if (typeof loaded !== 'object' || loaded === null) throw new Error('Worker module missing')
    const checkpoint: unknown = Object.getOwnPropertyDescriptor(loaded, 'checkpointWebSocketState')?.value
    if (typeof checkpoint !== 'function') throw new Error('Worker checkpoint missing')
    let writes = 0
    const body = JSON.stringify({ messages: [] }), hash = await hashBody(body)
    try {
      await Reflect.apply(checkpoint, undefined, [{ RELAY_STATE: { async put() { writes++; throw new Error(${JSON.stringify(`storage failed ${opaque} Bearer ${oauth}`)}) } } }, { affinity: 'synthetic-checkpoint', next_hash: hash }, body, { body, hash, revision: 1 }])
    } finally { URL.revokeObjectURL(url) }
    if (writes !== 1) throw new Error('Checkpoint did not reach storage')
    console.log('PHYSICAL_STORAGE_WRITE=1')
  `)
  expect(result.stdout).toContain('PHYSICAL_STORAGE_WRITE=1')
  expect(result.stdout).toContain('checkpoint_write_failed')
  expect(result.stdout).not.toContain(opaque)
  expect(result.stdout).not.toContain(oauth)
  expect(result.stdout).not.toContain('storage failed')
})
