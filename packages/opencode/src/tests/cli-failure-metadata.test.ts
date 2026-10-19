import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reportThrownFailure } from '../cli-failure.ts'

const prefix = 'CLI failure metadata: '
const secret = 'sk-ant-synthetic-metadata-secret-1234567890'

async function refusedReport(
  error: unknown,
  saveError: unknown,
  submitted: string[] = [],
  failDirectory = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'cli-failure-metadata-'))
  const stderr: string[] = []
  try {
    const screen = await reportThrownFailure(
      'cli-setup',
      error,
      { XDG_STATE_HOME: root },
      submitted,
      {
        ownership: {
          platform: 'win32',
          privateFiles: {
            readPrivateFile: readFile,
            async verifySafeParent() {
              return { ok: true }
            },
            async createPrivateDirectory(path) {
              if (failDirectory) throw saveError
              await mkdir(path)
            },
            async verifyOwnerOnly() {
              return { ok: true as const }
            },
            async createPrivateFile() {
              throw saveError
            },
          },
        },
        stderr: (line: string) => {
          stderr.push(line)
        },
      },
    )
    return { screen, stderr }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function privateError(stage: string, reason: string, path: string) {
  return Object.assign(new Error(`Untrusted message ${secret} ${path}`), {
    name: 'PrivateFileError',
    code: 'ERR_PRIVATE_FILES_SECURITY',
    stage,
    reason,
    path,
    stack: `Untrusted stack ${secret} ${path}`,
  })
}

test('unsaved private diagnostics emit exactly allowlisted setup and save error fields to stderr', async () => {
  const setupPath = 'C:\\private\\setup-secret.json'
  const savePath = 'C:\\private\\diagnostic-secret.log'
  const setup = privateError('rename', 'io-error', setupPath)
  const save = privateError('create', 'unsafe-ancestor', savePath)
  let hooks = 0
  Object.assign(setup, {
    toJSON() {
      hooks++
      throw new Error('must not run')
    },
    toString() {
      hooks++
      throw new Error('must not run')
    },
  })
  Object.assign(save, {
    toJSON() {
      hooks++
      throw new Error('must not run')
    },
    toString() {
      hooks++
      throw new Error('must not run')
    },
  })
  const output = await refusedReport(setup, save, [secret])
  expect(output.screen).toBe(
    'Setup failed (cli-setup/unexpected-error). Details could not be saved to a private diagnostics file.',
  )
  expect(output.stderr).toEqual([
    `${prefix}${JSON.stringify({
      error: {
        name: 'PrivateFileError',
        code: 'ERR_PRIVATE_FILES_SECURITY',
        stage: 'rename',
        reason: 'io-error',
      },
      saveError: {
        name: 'PrivateFileError',
        code: 'ERR_PRIVATE_FILES_SECURITY',
        stage: 'create',
        reason: 'unsafe-ancestor',
      },
    })}\n`,
  ])
  for (const forbidden of [
    secret,
    setupPath,
    savePath,
    'Untrusted message',
    'Untrusted stack',
    'path',
    'stack',
    'message',
  ])
    expect(output.stderr.join('')).not.toContain(forbidden)
  expect(hooks).toBe(0)
})

test('stderr metadata drops non-allowlisted field values rather than sanitizing arbitrary strings into codes', async () => {
  const error = {
    name: secret,
    code: 'C:\\private\\code',
    stage: secret,
    reason: `io-error ${secret}`,
    message: secret,
  }
  const output = await refusedReport(error, error, [secret])
  expect(output.stderr).toEqual([`${prefix}{"error":{},"saveError":{}}\n`])
})

test('stderr metadata respects exact known credential redaction even for an otherwise allowlisted code', async () => {
  const error = Object.assign(new Error('untrusted'), { code: 'EACCES' })
  const save = Object.assign(new Error('untrusted'), { code: 'EPERM' })
  const output = await refusedReport(error, save, ['EACCES'])
  expect(output.stderr).toEqual([
    `${prefix}{"error":{"name":"Error"},"saveError":{"name":"Error","code":"EPERM"}}\n`,
  ])
  expect(output.stderr.join('')).not.toContain('EACCES')
})

test('stderr metadata never invokes accessors or proxy traps on either error', async () => {
  let reads = 0
  const accessor = Object.create(null)
  for (const key of [
    'name',
    'code',
    'stage',
    'reason',
    'message',
    'stack',
    'cause',
    'toJSON',
    'toString',
  ])
    Object.defineProperty(accessor, key, {
      get() {
        reads++
        throw new Error('must not run')
      },
    })
  const proxy = new Proxy(
    {},
    {
      get() {
        reads++
        throw new Error('must not run')
      },
      getOwnPropertyDescriptor() {
        reads++
        throw new Error('must not run')
      },
      getPrototypeOf() {
        reads++
        throw new Error('must not run')
      },
      ownKeys() {
        reads++
        throw new Error('must not run')
      },
    },
  )
  for (const value of [accessor, proxy]) {
    for (const failDirectory of [false, true]) {
      const output = await refusedReport(value, value, [], failDirectory)
      expect(output.stderr).toEqual([`${prefix}{"error":{},"saveError":{}}\n`])
    }
  }
  expect(reads).toBe(0)
})

test('a refused directory owner-only verdict retains its actual reason and creates no log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-failure-directory-'))
  const stderr: string[] = []
  let creations = 0
  try {
    const screen = await reportThrownFailure(
      'cli-setup',
      new Error(secret),
      { XDG_STATE_HOME: root },
      [secret],
      {
        ownership: {
          platform: 'win32',
          privateFiles: {
            readPrivateFile: readFile,
            async verifySafeParent() {
              return { ok: true }
            },
            async createPrivateDirectory(path) {
              await mkdir(path)
            },
            async verifyOwnerOnly() {
              return {
                ok: false as const,
                refusal: { reason: 'not-protected' as const, message: secret },
              }
            },
            async createPrivateFile() {
              creations++
            },
          },
        },
        stderr: (line: string) => {
          stderr.push(line)
        },
      },
    )
    expect(screen).toContain('Details could not be saved')
    expect(stderr).toEqual([
      `${prefix}{"error":{"name":"Error"},"saveError":{"name":"Error","code":"ERR_PRIVATE_FILES_SECURITY","stage":"verify","reason":"not-protected"}}\n`,
    ])
    expect(creations).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('saved private diagnostics do not emit fallback metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-failure-saved-'))
  const stderr: string[] = []
  try {
    const screen = await reportThrownFailure(
      'cli-setup',
      new Error(secret),
      { XDG_STATE_HOME: root },
      [secret],
      {
        stderr: (line: string) => {
          stderr.push(line)
        },
      },
    )
    expect(screen).toContain('Details were written to ')
    expect(stderr).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native safe-parent writable-by-others metadata is retained as a closed reason', async () => {
  const output = await refusedReport(
    privateError('safe-parent', 'writable-by-others', 'C:\\private\\parent'),
    privateError('create', 'wrong-owner', 'C:\\private\\diagnostic.log'),
    [secret],
  )
  expect(output.stderr).toEqual([
    `${prefix}${JSON.stringify({
      error: {
        name: 'PrivateFileError',
        code: 'ERR_PRIVATE_FILES_SECURITY',
        stage: 'safe-parent',
        reason: 'writable-by-others',
      },
      saveError: {
        name: 'PrivateFileError',
        code: 'ERR_PRIVATE_FILES_SECURITY',
        stage: 'create',
        reason: 'wrong-owner',
      },
    })}\n`,
  ])
})
