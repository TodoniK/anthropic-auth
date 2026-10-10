import { expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativePoolStore,
  resolveNativePoolPaths,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { saveNativePiFixture } from './native-fixture.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-native-fixture-credential-'))
  const names = [
    'PI_CODING_AGENT_DIR',
    'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  ] as const
  const previous = names.map((name) => [name, process.env[name]] as const)
  deferCleanup(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'anthropic-auth.json')
  const paths = await resolveNativePoolPaths(
    path,
    join(root, 'anthropic-auth-state.json'),
  )
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  const rows = async () => {
    const read = await store.read()
    if (read.status !== 'ready') throw new Error('Fixture pool is unreadable')
    return read.rows
  }
  return { path, rows }
}

test('positive Pi fixture stores its explicit supported default token unchanged', async () => {
  const f = await fixture()
  await saveNativePiFixture({ version: 1, accounts: [] }, f.path)
  const rows = await f.rows()
  expect(rows).toHaveLength(1)
  expect(rows[0]?.credential).toMatchObject({
    type: 'oauth',
    access: 'sk-ant-oat01-main-access',
  })
})

test('Pi fixture refuses an explicitly unsupported main token instead of normalizing it', async () => {
  const f = await fixture()
  await expect(
    saveNativePiFixture({ version: 1, accounts: [] }, f.path, {
      mainAccess: 'unsupported-fixture-main',
    }),
  ).rejects.toThrow('Claude account identity could not be verified')
  expect(await f.rows()).toEqual([])
})

test('Pi fixture refuses an explicitly unsupported fallback token instead of normalizing it', async () => {
  const f = await fixture()
  await expect(
    saveNativePiFixture(
      {
        version: 1,
        accounts: [
          {
            id: 'unsupported-fallback',
            type: 'oauth',
            enabled: true,
            addedAt: 1,
            access: 'unsupported-fixture-fallback',
            refresh: 'synthetic-refresh',
            expires: Date.now() + 3_600_000,
          },
        ],
      },
      f.path,
      { primary: false },
    ),
  ).rejects.toThrow('Claude account identity could not be verified')
  expect(await f.rows()).toEqual([])
})
