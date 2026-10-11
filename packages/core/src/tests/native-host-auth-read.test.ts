import { expect } from 'bun:test'
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { custodyTombstoneOAuth } from '../claustrum.ts'
import { readNativeHostAuthKind } from '../native-host-auth-read.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-host-auth-read-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'auth.json') }
}

test('an absent host auth file is absent without creating a file or local authority', async () => {
  const f = await fixture()
  expect(await readNativeHostAuthKind('opencode', f.path)).toBe('absent')
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

for (const [host, entry, kind] of [
  ['opencode', undefined, 'absent'],
  ['opencode', { type: 'api', key: 'synthetic-private-key' }, 'api'],
  ['pi', { type: 'api_key', key: 'synthetic-private-key' }, 'api_key'],
  [
    'opencode',
    {
      type: 'oauth',
      access: 'synthetic-access',
      refresh: 'synthetic-refresh',
      expires: 1,
    },
    'oauth',
  ],
  ['opencode', custodyTombstoneOAuth('anthropic'), 'activation'],
] as const) {
  test(`${host} host auth read returns only ${kind} and preserves every file byte`, async () => {
    const f = await fixture()
    const text = JSON.stringify({
      other: { type: 'api', key: 'synthetic-co-tenant-secret' },
      ...(entry && { anthropic: entry }),
    })
    await writeFile(f.path, text, { mode: 0o600 })
    const result = await readNativeHostAuthKind(host, f.path)
    expect(result).toBe(kind)
    expect(typeof result).toBe('string')
    expect(await readFile(f.path, 'utf8')).toBe(text)
  })
}

for (const dangling of [false, true]) {
  test(`a ${dangling ? 'dangling' : 'readable'} auth symlink refuses instead of admitting an empty slot`, async () => {
    const f = await fixture()
    const target = join(f.root, 'target.json')
    if (!dangling) await writeFile(target, '{}', { mode: 0o600 })
    await symlink(target, f.path)
    await expect(
      readNativeHostAuthKind('opencode', f.path),
    ).rejects.toMatchObject({ code: 'invalid-source' })
    if (!dangling) expect(await readFile(target, 'utf8')).toBe('{}')
  })
}

for (const text of [
  '{"anthropic":"synthetic-secret"',
  '{"anthropic":null}',
  '{"anthropic":{"type":"oauth","access":"synthetic-secret"}}',
]) {
  test(`malformed host auth refuses with a closed error and unchanged bytes: ${text.length}`, async () => {
    const f = await fixture()
    await writeFile(f.path, text, { mode: 0o600 })
    const outcome = await readNativeHostAuthKind('opencode', f.path).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok)
      throw new Error('Malformed host authentication was admitted')
    expect(outcome.error).toMatchObject({ code: 'invalid-source' })
    expect(String(outcome.error)).not.toContain('synthetic-secret')
    expect(outcome.error).not.toHaveProperty('cause')
    expect(await readFile(f.path, 'utf8')).toBe(text)
  })
}

test('group-readable authentication refuses even when the process can physically read it', async () => {
  const f = await fixture()
  await writeFile(f.path, '{}', { mode: 0o600 })
  await chmod(f.path, 0o640)
  await expect(
    readNativeHostAuthKind('opencode', f.path),
  ).rejects.toMatchObject({ code: 'invalid-source' })
  expect(await readFile(f.path, 'utf8')).toBe('{}')
})
