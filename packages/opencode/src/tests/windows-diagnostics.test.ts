import { expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnerOnlyOptions } from '@cortexkit/anthropic-auth-core'
import { cliDiagnosticsDirectory, writeDiagnosticFile } from '../cli-failure.ts'

for (const allowed of [true, false]) {
  test(`win32 diagnostics ${allowed ? 'accepts' : 'refuses'} the directory ACL and uses native private creation`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'windows-diagnostics-'))
    try {
      const env = { XDG_STATE_HOME: root }
      const directory = cliDiagnosticsDirectory(env)
      if (!directory) throw new Error('Missing diagnostics directory')
      await mkdir(directory, { recursive: true })
      await chmod(directory, allowed ? 0o777 : 0o700)
      const checked: string[] = []
      const created: string[] = []
      const path = await writeDiagnosticFile(
        env,
        'cli-setup',
        'synthetic diagnostic',
        {
          platform: 'win32',
          privateFiles: {
            readPrivateFile: readFile,
            async verifySafeParent() {
              return { ok: true }
            },
            async createPrivateDirectory(path) {
              await mkdir(path)
            },
            async verifyOwnerOnly(path) {
              checked.push(path)
              return allowed
                ? { ok: true }
                : {
                    ok: false,
                    refusal: { reason: 'null-dacl', message: 'refused' },
                  }
            },
            async createPrivateFile(path, bytes) {
              created.push(path)
              await writeFile(path, bytes ?? '')
            },
          },
        },
      )
      expect(checked).toEqual([directory])
      if (allowed) {
        expect(created).toEqual([path as string])
        expect(await readFile(path as string, 'utf8')).toBe(
          'synthetic diagnostic',
        )
      } else {
        expect(path).toBeUndefined()
        expect(created).toEqual([])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function nativeDirectoryBackend() {
  const privatePaths = new Set<string>()
  const directories: string[] = []
  const files: string[] = []
  const safeParents: string[] = []
  const api: NonNullable<OwnerOnlyOptions['privateFiles']> = {
    readPrivateFile: readFile,
    async verifySafeParent(path) {
      safeParents.push(path)
      return { ok: true }
    },
    async verifyOwnerOnly(path) {
      return privatePaths.has(path)
        ? { ok: true }
        : {
            ok: false,
            refusal: { reason: 'not-protected', message: 'Not native-created' },
          }
    },
    async createPrivateDirectory(path) {
      directories.push(path)
      await mkdir(path)
      await chmod(path, 0o777)
      privatePaths.add(path)
    },
    async createPrivateFile(path, bytes) {
      // A private file may live in entry-safe ancestry that is not itself owner-only.
      files.push(path)
      await writeFile(path, bytes ?? '', { mode: 0o666 })
      await chmod(path, 0o666)
      privatePaths.add(path)
    },
  }
  return { api, privatePaths, directories, files, safeParents }
}

test('win32 diagnostics native-creates every missing directory before writing a private file despite POSIX mode bits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-diagnostics-'))
  try {
    const env = { XDG_STATE_HOME: root }
    const directory = cliDiagnosticsDirectory(env)!
    const backend = nativeDirectoryBackend()
    const path = await writeDiagnosticFile(
      env,
      'cli-setup',
      'synthetic detail',
      { platform: 'win32', privateFiles: backend.api },
    )
    expect(path).toBeDefined()
    expect(backend.directories).toEqual([
      join(root, 'cortexkit'),
      join(root, 'cortexkit', 'anthropic-auth'),
      directory,
    ])
    expect(backend.files).toEqual([path as string])
    expect(backend.safeParents).toContain(root)
    expect(await readFile(path as string, 'utf8')).toBe('synthetic detail')
    expect((await stat(directory)).mode & 0o777).toBe(0o777)
    expect((await stat(path as string)).mode & 0o777).toBe(0o666)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('win32 diagnostics refuses existing non-private directories without repair or file creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-diagnostics-'))
  try {
    const env = { XDG_STATE_HOME: root }
    const directory = cliDiagnosticsDirectory(env)!
    await mkdir(directory, { recursive: true })
    await chmod(directory, 0o755)
    await writeFile(join(directory, 'operator.log'), 'keep')
    const backend = nativeDirectoryBackend()
    const path = await writeDiagnosticFile(
      env,
      'cli-setup',
      'synthetic detail',
      { platform: 'win32', privateFiles: backend.api },
    )
    expect(path).toBeUndefined()
    expect(backend.directories).toEqual([])
    expect(backend.files).toEqual([])
    expect((await stat(directory)).mode & 0o777).toBe(0o755)
    expect(await readdir(directory)).toEqual(['operator.log'])
    expect(await readFile(join(directory, 'operator.log'), 'utf8')).toBe('keep')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('win32 diagnostics honors the safe-parent DACL refusal before creating directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unsafe-diagnostics-'))
  try {
    const backend = nativeDirectoryBackend()
    backend.api.verifySafeParent = async (path) => {
      backend.safeParents.push(path)
      return { ok: false, reason: 'writable-by-others', path }
    }
    const path = await writeDiagnosticFile(
      { XDG_STATE_HOME: root },
      'cli-setup',
      'synthetic detail',
      { platform: 'win32', privateFiles: backend.api },
    )
    expect(path).toBeUndefined()
    expect(backend.safeParents).toContain(root)
    expect(backend.directories).toEqual([])
    expect(backend.files).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const platform of ['linux', 'darwin'] as const) {
  test(`${platform} diagnostics retains POSIX creation and no-repair policy without calling the native backend`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'posix-diagnostics-'))
    try {
      const env = { XDG_STATE_HOME: root }
      const directory = cliDiagnosticsDirectory(env)!
      const fail = async () => {
        throw new Error('Native backend must not be called on POSIX')
      }
      const path = await writeDiagnosticFile(
        env,
        'cli-setup',
        'synthetic detail',
        {
          platform,
          privateFiles: {
            readPrivateFile: fail,
            verifyOwnerOnly: fail,
            verifySafeParent: fail,
            createPrivateDirectory: fail,
            createPrivateFile: fail,
          },
        },
      )
      expect(path).toBeDefined()
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(path as string)).mode & 0o777).toBe(0o600)
      await chmod(directory, 0o755)
      expect(
        await writeDiagnosticFile(env, 'cli-setup', 'do not write', {
          platform,
        }),
      ).toBeUndefined()
      expect((await stat(directory)).mode & 0o777).toBe(0o755)
      expect((await readdir(directory)).length).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const [win32Code, privateDirectory, accepted] of [
  [80, true, true],
  [183, true, true],
  [183, false, false],
  [5, true, false],
] as const) {
  test(`win32 diagnostics handles a directory create race with native code ${win32Code}, private=${privateDirectory}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'raced-diagnostics-'))
    try {
      const env = { XDG_STATE_HOME: root }
      const directory = cliDiagnosticsDirectory(env)!
      const backend = nativeDirectoryBackend()
      const create = backend.api.createPrivateDirectory
      if (!create) throw new Error('Missing fake directory creator')
      backend.api.createPrivateDirectory = async (path) => {
        await create(path)
        if (path === directory) {
          if (!privateDirectory) backend.privatePaths.delete(path)
          throw Object.assign(new Error('Directory create refused'), {
            code: 'ERR_PRIVATE_FILES_SECURITY',
            reason: 'io-error',
            win32Code,
          })
        }
      }
      const path = await writeDiagnosticFile(
        env,
        'cli-setup',
        'synthetic detail',
        { platform: 'win32', privateFiles: backend.api },
      )
      if (accepted) {
        expect(path).toBeDefined()
        expect(backend.files).toEqual([path as string])
      } else {
        expect(path).toBeUndefined()
        expect(backend.files).toEqual([])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
