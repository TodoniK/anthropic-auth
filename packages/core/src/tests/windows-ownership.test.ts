import { expect } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readClaustrumEnrollmentStatus,
  refuseWritableAncestor,
} from '../claustrum-enrollment.ts'
import { readNativeHostAuthKind } from '../native-host-auth-read.ts'
import { readNativeRuntime } from '../native-runtime.ts'
import { createWindowsOwnerOnly } from '../owner-only.ts'
import {
  beginNativeEmptyInit,
  readNativeMigrationJournal,
} from '../pool-authority.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const storageId = 'a'.repeat(64)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-windows-ownership-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  return root
}

test('win32 enrollment ancestry uses safe-parent ACL policy without a mode fallback', async () => {
  const root = await fixture()
  await chmod(root, 0o777)
  const checked: string[] = []
  const privateFiles = {
    async verifyOwnerOnly() {
      throw new Error('Ancestors need safe-parent, not owner-only policy')
    },
    readPrivateFile: readFile,
    async verifySafeParent(path: string) {
      checked.push(path)
      return { ok: true as const }
    },
  }
  await refuseWritableAncestor(root, { platform: 'win32', privateFiles })
  expect(checked).toEqual([root])
  await chmod(root, 0o700)
  await expect(
    refuseWritableAncestor(root, {
      platform: 'win32',
      privateFiles: {
        ...privateFiles,
        async verifySafeParent() {
          return { ok: false as const, reason: 'unsafe-ancestor', path: root }
        },
      },
    }),
  ).rejects.toThrow('unsafe writable ancestor')
})

for (const platform of ['linux', 'darwin'] as const) {
  test(`${platform} enrollment ancestry retains writable and sticky-bit policy`, async () => {
    const root = await fixture()
    let mode = 0o777
    const metadataAt = async (path: string) => ({
      mode: path === root ? mode : 0o700,
    })
    await expect(
      refuseWritableAncestor(root, { platform }, metadataAt),
    ).rejects.toThrow('unsafe writable ancestor')
    mode = 0o1777
    await refuseWritableAncestor(root, { platform }, metadataAt)
  })
}

test('win32 private creation requires native DACL creation before bytes and POSIX does not use it', async () => {
  const calls: string[] = []
  const options = {
    privateFiles: {
      async verifyOwnerOnly() {
        return { ok: true as const }
      },
      readPrivateFile: readFile,
      async createPrivateFile(path: string, bytes?: string | Uint8Array) {
        calls.push(`${path}:${bytes}`)
      },
    },
  }
  expect(
    await createWindowsOwnerOnly('synthetic', 'bytes', {
      ...options,
      platform: 'win32',
    }),
  ).toBe(true)
  for (const platform of ['linux', 'darwin'] as const)
    expect(
      await createWindowsOwnerOnly('synthetic', 'bytes', {
        ...options,
        platform,
      }),
    ).toBe(false)
  expect(calls).toEqual(['synthetic:bytes'])
})

for (const reader of [
  'runtime',
  'journal',
  'host-auth',
  'enrollment',
] as const) {
  for (const permitted of [true, false]) {
    test(`win32 ${reader} ownership uses the ACL verdict, not mode bits (${permitted ? 'allow' : 'deny'})`, async () => {
      const root = await fixture()
      const path = join(root, 'record.json')
      const paths = await resolveNativePoolPaths(
        join(root, 'anthropic-auth.json'),
      )
      if (reader === 'journal') await beginNativeEmptyInit(paths)
      else
        await writeFile(
          path,
          JSON.stringify(
            reader === 'runtime'
              ? { version: 1, storageId, accounts: {} }
              : reader === 'enrollment'
                ? { token: 'a'.repeat(64), token_generation: 1 }
                : {},
          ),
          { mode: 0o600 },
        )
      const target = reader === 'journal' ? paths.journal : path
      await chmod(target, permitted ? 0o666 : 0o600)
      const calls: string[] = []
      const options = {
        platform: 'win32' as const,
        privateFiles: {
          async verifyOwnerOnly(file: string) {
            calls.push(file)
            return permitted
              ? { ok: true as const }
              : {
                  ok: false as const,
                  refusal: {
                    reason: 'extra-ace' as const,
                    sid: 'untrusted',
                    mask: 1,
                  },
                }
          },
          readPrivateFile: readFile,
        },
      }
      const read = () =>
        reader === 'runtime'
          ? readNativeRuntime(path, storageId, options)
          : reader === 'journal'
            ? readNativeMigrationJournal(paths, options)
            : reader === 'host-auth'
              ? readNativeHostAuthKind('opencode', path, options)
              : readClaustrumEnrollmentStatus(
                  { tokenPath: path, statePath: join(root, 'missing') },
                  undefined,
                  options,
                )
      if (permitted) await read()
      else await expect(read()).rejects.toThrow()
      expect(calls).toContain(target)
    })
  }
  for (const platform of ['darwin', 'linux'] as const) {
    test(`${platform} ${reader} retains its POSIX mode policy without loading ACLs`, async () => {
      const root = await fixture()
      const path = join(root, 'record.json')
      const paths = await resolveNativePoolPaths(
        join(root, 'anthropic-auth.json'),
      )
      if (reader === 'journal') await beginNativeEmptyInit(paths)
      else
        await writeFile(
          path,
          JSON.stringify(
            reader === 'runtime'
              ? { version: 1, storageId, accounts: {} }
              : reader === 'enrollment'
                ? { token: 'a'.repeat(64), token_generation: 1 }
                : {},
          ),
          { mode: 0o600 },
        )
      const target = reader === 'journal' ? paths.journal : path
      const options = {
        platform,
        privateFiles: {
          async verifyOwnerOnly() {
            throw new Error('POSIX must not load ACL verifier')
          },
          async readPrivateFile() {
            throw new Error('POSIX must not load native reader')
          },
        },
      }
      const read = () =>
        reader === 'runtime'
          ? readNativeRuntime(path, storageId, options)
          : reader === 'journal'
            ? readNativeMigrationJournal(paths, options)
            : reader === 'host-auth'
              ? readNativeHostAuthKind('opencode', path, options)
              : readClaustrumEnrollmentStatus(
                  { tokenPath: path, statePath: join(root, 'missing') },
                  undefined,
                  options,
                )
      await read()
      await chmod(target, 0o640)
      await expect(read()).rejects.toThrow()
    })
  }
}
