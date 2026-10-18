import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BindIdentity,
  buildFrame,
  computeProof,
  decodeHeader,
  encodeFrame,
  FrameType,
  HEADER_LEN,
  SERVER_PROOF_DOMAIN,
} from '@cortexkit/subc-client'

import { createNativeCustody, NativeCustodyError } from '../native-custody.ts'
import { connectNativeVaultScopedClient } from '../native-vault-runtime.ts'

const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const daemonId = Uint8Array.from({ length: 16 }, (_, index) => index + 1)
const serverNonce = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)

type RetryableDaemon = {
  connectionFile: string
  routeOpenAttempts: () => number
  close: () => Promise<void>
}

async function startRetryableDaemon(root: string): Promise<RetryableDaemon> {
  let routeOpenAttempts = 0
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let phase: 'hello' | 'auth' | 'frames' = 'hello'
    let buffer = Buffer.alloc(0)

    const sendAuth = (message: unknown) => {
      const body = Buffer.from(JSON.stringify(message))
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32LE(body.length)
      socket.write(Buffer.concat([prefix, body]))
    }

    const handleFrames = () => {
      while (buffer.length >= HEADER_LEN) {
        const header = decodeHeader(buffer.subarray(0, HEADER_LEN))
        const frameLength = HEADER_LEN + header.len
        if (buffer.length < frameLength) return
        const body = buffer.subarray(HEADER_LEN, frameLength)
        buffer = buffer.subarray(frameLength)
        if (header.ty !== FrameType.Request || header.channel !== 0) continue
        const request = JSON.parse(body.toString('utf8')) as { op?: string }
        if (request.op !== 'route.open') continue
        routeOpenAttempts++
        const refusal = buildFrame(
          FrameType.Error,
          0,
          header.channel,
          header.epoch,
          header.corr,
          Buffer.from(
            JSON.stringify({
              code: 'module_warming',
              message: 'The synthetic vault route is still starting.',
            }),
          ),
        )
        socket.write(Buffer.from(encodeFrame(refusal)))
      }
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)])
      while (phase !== 'frames' && buffer.length >= 4) {
        const length = buffer.readUInt32LE(0)
        if (buffer.length < 4 + length) return
        const message = JSON.parse(
          buffer.subarray(4, 4 + length).toString('utf8'),
        ) as { client_nonce?: number[] }
        buffer = buffer.subarray(4 + length)
        if (phase === 'hello') {
          const clientNonce = Uint8Array.from(message.client_nonce ?? [])
          const serverProof = computeProof(
            key,
            SERVER_PROOF_DOMAIN,
            clientNonce,
            serverNonce,
            daemonId,
          )
          sendAuth({
            daemon_id: Array.from(daemonId),
            server_nonce: Array.from(serverNonce),
            daemon_ver: 'synthetic',
            server_proof: Array.from(serverProof),
          })
          phase = 'auth'
        } else {
          phase = 'frames'
        }
      }
      if (phase === 'frames') handleFrames()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Synthetic vault daemon did not bind a TCP port')
  const connectionFile = join(root, 'connection.json')
  await writeFile(
    connectionFile,
    JSON.stringify({
      schema: 1,
      endpoints: [{ host: '127.0.0.1', port: address.port }],
      key: Array.from(key),
      daemon_id: Array.from(daemonId),
      pid: process.pid,
      daemon_ver: 'synthetic',
    }),
    { mode: 0o600 },
  )

  return {
    connectionFile,
    routeOpenAttempts: () => routeOpenAttempts,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}

test('retryable vault route refusals cannot hold native authorization past its two-second budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-vault-connect-timeout-'))
  let daemon: RetryableDaemon | undefined
  let closeCustody: (() => void) | undefined
  try {
    daemon = await startRetryableDaemon(root)
    const identity: BindIdentity = {
      project_root: root,
      harness: 'opencode',
      session: 'native-vault-timeout-test',
    }
    const custody = createNativeCustody({
      host: 'opencode',
      readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
      connect: () =>
        connectNativeVaultScopedClient(daemon!.connectionFile, identity),
    })
    closeCustody = custody.close

    const started = performance.now()
    const error = await custody
      .authorize({
        credentialId: 'credential-test',
        accountIdentity: 'account-test',
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      )
    expect(error).toBeInstanceOf(NativeCustodyError)
    const elapsedMs = performance.now() - started

    expect(elapsedMs).toBeGreaterThanOrEqual(1_500)
    expect(elapsedMs).toBeLessThan(4_000)
    expect(daemon.routeOpenAttempts()).toBeGreaterThan(1)
  } finally {
    closeCustody?.()
    await daemon?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 8_000)
