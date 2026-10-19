import { expect } from 'bun:test'
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectNativeHostAuthEntry } from '../native-host-auth.ts'
import {
  isNativeHostAuthWriteStagingName,
  writeNativeHostAuth,
} from '../native-host-auth-write.ts'
import {
  isNativeRuntimeStagingName,
  updateNativeRuntime,
  updateNativeRuntimeOptional,
} from '../native-runtime.ts'
import { renameWithWindowsSharingRetry } from '../publication-rename.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const storageId = 'a'.repeat(64)
type Site = 'runtime' | 'host-auth'
type Publication = {
  platform: NodeJS.Platform
  rename: (from: string, to: string) => Promise<void>
  now: () => number
  sleep: (ms: number) => Promise<void>
}
type Extra = {
  before?: () => Promise<void>
  authority?: () => Promise<void>
  after?: () => Promise<void>
}

async function fixture(site: Site, trace: string[]) {
  const root = await mkdtemp(join(tmpdir(), `windows-${site}-publication-`))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const path = join(root, site === 'runtime' ? 'runtime.json' : 'auth.json')
  const oauth = {
    type: 'oauth',
    access: 'synthetic-access',
    refresh: 'synthetic-refresh',
    expires: 0,
  }
  const activation = {
    type: 'oauth',
    access: '',
    refresh: 'claustrum-tombstone:v1:anthropic',
    expires: 0,
  }
  if (site === 'runtime')
    await updateNativeRuntime(path, storageId, () => ({
      version: 1,
      storageId,
      accounts: {
        row: {
          binding: {
            kind: 'local',
            storageId,
            rowId: 'row',
            credentialEpoch: 1,
          },
          lastUsed: 1,
        },
      },
    }))
  else
    await writeFile(
      path,
      `${JSON.stringify({
        anthropic: oauth,
        other: { key: 'synthetic-co-tenant' },
      })}\n`,
      { mode: 0o600 },
    )
  const initial = await readFile(path, 'utf8')
  const sourceDigest = inspectNativeHostAuthEntry(
    'opencode',
    JSON.parse(initial),
  ).digest
  const expectedDigest = inspectNativeHostAuthEntry('opencode', {
    anthropic: activation,
  }).digest
  return {
    root,
    path,
    initial,
    async stages() {
      return (await readdir(root)).filter((name) =>
        site === 'runtime'
          ? isNativeRuntimeStagingName(path, name)
          : isNativeHostAuthWriteStagingName(name),
      )
    },
    async publish(publication: Publication, extra: Extra = {}) {
      const before = async () => {
        trace.push('before')
        await extra.before?.()
      }
      const after = async () => {
        trace.push('after')
        await extra.after?.()
      }
      if (site === 'runtime')
        return updateNativeRuntime(
          path,
          storageId,
          (current) => {
            current.accounts.row!.lastUsed = 2
            return current
          },
          {
            publication,
            beforeRename: before,
            beforePublish: async () => {
              trace.push('authority')
              await extra.authority?.()
            },
            afterRename: after,
          },
        )
      return writeNativeHostAuth(
        {
          host: 'opencode',
          authPath: path,
          sourceDigest,
          expectedDigest,
          env: {},
          removePiAnthropicAuth: false,
          processFence: async () => {
            trace.push('fence')
            await extra.authority?.()
          },
        },
        {
          publication,
          beforeRecheck: async () => {
            trace.push('recheck')
          },
          beforeRename: before,
          afterRename: after,
        },
      )
    },
    async expectPublished() {
      const data = JSON.parse(await readFile(path, 'utf8'))
      if (site === 'runtime') expect(data.accounts.row.lastUsed).toBe(2)
      else {
        expect(data.anthropic).toEqual(activation)
        expect(data.other).toEqual({ key: 'synthetic-co-tenant' })
      }
    },
  }
}

function clock() {
  let elapsed = 0
  const delays: number[] = []
  return {
    delays,
    now: () => elapsed,
    sleep: async (ms: number) => {
      delays.push(ms)
      elapsed += ms
    },
  }
}
const outcome = (work: Promise<unknown>) =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  )

for (const site of ['runtime', 'host-auth'] as const) {
  test(`${site} win32 publication retries EBUSY and repeats fences before success`, async () => {
    const trace: string[] = []
    const f = await fixture(site, trace)
    const time = clock()
    let attempts = 0
    const result = await outcome(
      f.publish({
        platform: 'win32',
        ...time,
        rename: async (from, to) => {
          trace.push(`rename${++attempts}`)
          if (attempts === 1)
            throw Object.assign(new Error('synthetic sharing refusal'), {
              code: 'EBUSY',
            })
          await rename(from, to)
        },
      }),
    )
    expect(result).toMatchObject({ ok: true })
    expect(attempts).toBe(2)
    expect(time.delays).toEqual([10])
    expect(trace).toEqual(
      site === 'runtime'
        ? [
            'before',
            'authority',
            'rename1',
            'before',
            'authority',
            'rename2',
            'after',
          ]
        : [
            'recheck',
            'before',
            'fence',
            'rename1',
            'recheck',
            'before',
            'fence',
            'rename2',
            'after',
          ],
    )
    await f.expectPublished()
    expect(await f.stages()).toEqual([])
  })

  test(`${site} win32 persistent sharing refusal is bounded and retains the old file`, async () => {
    const trace: string[] = []
    const f = await fixture(site, trace)
    const time = clock()
    let attempts = 0
    const result = await outcome(
      f.publish({
        platform: 'win32',
        ...time,
        rename: async () => {
          attempts++
          throw Object.assign(
            new Error('synthetic persistent sharing refusal'),
            { code: 'EPERM' },
          )
        },
      }),
    )
    expect(result).toMatchObject({
      ok: false,
      error: { code: site === 'runtime' ? 'runtime-io' : 'write-io' },
    })
    expect(attempts).toBe(6)
    expect(time.delays).toEqual([10, 20, 40, 80, 100])
    expect(await readFile(f.path, 'utf8')).toBe(f.initial)
    expect(trace).not.toContain('after')
    expect(await f.stages()).toEqual([])
  })

  for (const platform of ['linux', 'darwin'] as const) {
    test(`${site} ${platform} publication keeps one attempt and unchanged fence order`, async () => {
      const trace: string[] = []
      const f = await fixture(site, trace)
      const time = clock()
      let attempts = 0
      const result = await outcome(
        f.publish({
          platform,
          ...time,
          rename: async () => {
            trace.push(`rename${++attempts}`)
            throw Object.assign(new Error('synthetic sharing refusal'), {
              code: 'EBUSY',
            })
          },
        }),
      )
      expect(result).toMatchObject({
        ok: false,
        error: { code: site === 'runtime' ? 'runtime-io' : 'write-io' },
      })
      expect(attempts).toBe(1)
      expect(time.delays).toEqual([])
      expect(trace).toEqual(
        site === 'runtime'
          ? ['before', 'authority', 'rename1']
          : ['recheck', 'before', 'fence', 'rename1'],
      )
      expect(await readFile(f.path, 'utf8')).toBe(f.initial)
      expect(await f.stages()).toEqual([])
    })
  }
}

for (const site of ['runtime', 'host-auth'] as const) {
  for (const platform of ['linux', 'darwin'] as const) {
    test(`${site} ${platform} successful publication keeps pre/post order and exact destination bytes`, async () => {
      const trace: string[] = []
      const f = await fixture(site, trace)
      const time = clock()
      let attempts = 0
      await f.publish({
        platform,
        ...time,
        rename: async (from, to) => {
          trace.push(`rename${++attempts}`)
          await rename(from, to)
        },
      })
      expect(attempts).toBe(1)
      expect(time.delays).toEqual([])
      expect(trace).toEqual(
        site === 'runtime'
          ? ['before', 'authority', 'rename1', 'after']
          : ['recheck', 'before', 'fence', 'rename1', 'after'],
      )
      await f.expectPublished()
      expect(await f.stages()).toEqual([])
    })
  }

  test(`${site} win32 retry stops on renewed authority refusal before another rename`, async () => {
    const trace: string[] = []
    const f = await fixture(site, trace)
    const time = clock()
    let attempts = 0
    let authority = 0
    const result = await outcome(
      f.publish(
        {
          platform: 'win32',
          ...time,
          rename: async () => {
            attempts++
            throw Object.assign(new Error('synthetic sharing refusal'), {
              code: 'EBUSY',
            })
          },
        },
        {
          authority: async () => {
            if (++authority === 2)
              throw new Error('synthetic authority revoked')
          },
        },
      ),
    )
    expect(result).toMatchObject({
      ok: false,
      error: {
        code:
          site === 'runtime' ? 'publication-refused' : 'process-fence-refused',
      },
    })
    expect(attempts).toBe(1)
    expect(authority).toBe(2)
    expect(await readFile(f.path, 'utf8')).toBe(f.initial)
    expect(trace).not.toContain('after')
    expect(await f.stages()).toEqual([])
  })

  test(`${site} win32 after-rename refusal keeps published bytes and completed effect`, async () => {
    const trace: string[] = []
    const f = await fixture(site, trace)
    const time = clock()
    let attempts = 0
    const result = await outcome(
      f.publish(
        {
          platform: 'win32',
          ...time,
          rename: async (from, to) => {
            if (++attempts === 1)
              throw Object.assign(new Error('synthetic sharing refusal'), {
                code: 'EBUSY',
              })
            await rename(from, to)
          },
        },
        {
          after: async () => {
            throw new Error('synthetic after-rename refusal')
          },
        },
      ),
    )
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: site === 'runtime' ? 'publication-refused' : 'hook-failed',
      },
    })
    if (site === 'host-auth')
      expect(result).toMatchObject({
        error: { effect: { status: 'replaced' } },
      })
    expect(attempts).toBe(2)
    expect(trace.filter((step) => step === 'after')).toHaveLength(1)
    await f.expectPublished()
    expect(await f.stages()).toEqual([])
  })
}

test('host-auth win32 retry rechecks the complete source before replacing another provider change', async () => {
  const trace: string[] = []
  const f = await fixture('host-auth', trace)
  const time = clock()
  let attempts = 0
  const changed = `${JSON.stringify({
    ...JSON.parse(f.initial),
    other: { key: 'synthetic-new-provider' },
  })}\n`
  const result = await outcome(
    f.publish({
      platform: 'win32',
      ...time,
      rename: async () => {
        attempts++
        await writeFile(f.path, changed)
        throw Object.assign(new Error('synthetic sharing refusal'), {
          code: 'EBUSY',
        })
      },
    }),
  )
  expect(result).toMatchObject({ ok: false, error: { code: 'invalid-source' } })
  expect(attempts).toBe(1)
  expect(await readFile(f.path, 'utf8')).toBe(changed)
  expect(trace).not.toContain('after')
  expect(await f.stages()).toEqual([])
})

test('runtime optional win32 retry can withdraw a newly redundant staged publication', async () => {
  const f = await fixture('runtime', [])
  const time = clock()
  let attempts = 0
  let checks = 0
  const result = await updateNativeRuntimeOptional(
    f.path,
    storageId,
    (current) => {
      current.accounts.row!.lastUsed = 2
      return current
    },
    {
      beforeRename: async () => (++checks === 1 ? 'publish' : 'skip'),
      publication: {
        platform: 'win32',
        ...time,
        rename: async () => {
          attempts++
          throw Object.assign(new Error('synthetic sharing refusal'), {
            code: 'EBUSY',
          })
        },
      },
    },
  )
  expect(result).toEqual({ status: 'skipped' })
  expect(attempts).toBe(1)
  expect(checks).toBe(2)
  expect(await readFile(f.path, 'utf8')).toBe(f.initial)
  expect(await f.stages()).toEqual([])
})

for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
  test(`sharing helper retries transient ${code} without manufacturing a timeout`, async () => {
    const time = clock()
    let attempts = 0
    const result = await renameWithWindowsSharingRetry('from', 'to', {
      platform: 'win32',
      ...time,
      rename: async () => {
        if (++attempts === 1)
          throw Object.assign(new Error('synthetic sharing refusal'), { code })
      },
    })
    expect(result).toBe('published')
    expect(attempts).toBe(2)
    expect(time.delays).toEqual([10])
  })
}

test('sharing helper exhausts bounded attempts with the exact original error', async () => {
  const time = clock()
  const original = Object.assign(new Error('synthetic original failure'), {
    code: 'EACCES',
  })
  let attempts = 0
  await expect(
    renameWithWindowsSharingRetry('from', 'to', {
      platform: 'win32',
      ...time,
      rename: async () => {
        attempts++
        throw attempts === 1
          ? original
          : Object.assign(new Error('synthetic later sharing refusal'), {
              code: 'EACCES',
            })
      },
    }),
  ).rejects.toBe(original)
  expect(attempts).toBe(6)
  expect(time.delays).toEqual([10, 20, 40, 80, 100])
})

for (const expireDuringFence of [false, true]) {
  test(`sharing helper bounds elapsed retry budget with original error, expireDuringFence=${expireDuringFence}`, async () => {
    let now = 0
    let attempts = 0
    let checks = 0
    const original = Object.assign(new Error('synthetic original failure'), {
      code: 'EBUSY',
    })
    await expect(
      renameWithWindowsSharingRetry(
        'from',
        'to',
        {
          platform: 'win32',
          now: () => now,
          sleep: async (ms) => {
            now += expireDuringFence ? ms : 500
          },
          rename: async () => {
            attempts++
            throw original
          },
        },
        async () => {
          checks++
          now = 501
          return 'publish'
        },
      ),
    ).rejects.toBe(original)
    expect(attempts).toBe(1)
    expect(checks).toBe(expireDuringFence ? 1 : 0)
  })
}

for (const details of [
  { code: 'ENOENT' },
  { code: 'EPERM', reason: 'wrong-owner' },
  { code: 'EPERM', win32Code: 5 },
]) {
  test(`sharing helper refuses non-sharing errors ${JSON.stringify(details)} immediately`, async () => {
    const time = clock()
    const original = Object.assign(new Error('synthetic refusal'), details)
    let attempts = 0
    await expect(
      renameWithWindowsSharingRetry('from', 'to', {
        platform: 'win32',
        ...time,
        rename: async () => {
          attempts++
          throw original
        },
      }),
    ).rejects.toBe(original)
    expect(attempts).toBe(1)
    expect(time.delays).toEqual([])
  })
}

for (const win32Code of [32, 33]) {
  test(`sharing helper recognizes native sharing code ${win32Code}`, async () => {
    const time = clock()
    let attempts = 0
    expect(
      await renameWithWindowsSharingRetry('from', 'to', {
        platform: 'win32',
        ...time,
        rename: async () => {
          if (++attempts === 1)
            throw Object.assign(new Error('synthetic native sharing refusal'), {
              code: 'ERR_PRIVATE_FILES_SECURITY',
              reason: 'io-error',
              win32Code,
            })
        },
      }),
    ).toBe('published')
    expect(attempts).toBe(2)
  })
}

test('sharing helper never reads accessors or proxy traps while classifying a failure', async () => {
  let reads = 0
  const accessor = Object.defineProperty(new Error('synthetic'), 'code', {
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
    },
  )
  for (const error of [accessor, proxy]) {
    const time = clock()
    await expect(
      renameWithWindowsSharingRetry('from', 'to', {
        platform: 'win32',
        ...time,
        rename: async () => {
          throw error
        },
      }),
    ).rejects.toBe(error)
    expect(time.delays).toEqual([])
  }
  expect(reads).toBe(0)
})

test('runtime win32 retry reasserts its runtime lease after a sharing refusal', async () => {
  const trace: string[] = []
  const f = await fixture('runtime', trace)
  const time = clock()
  let attempts = 0
  const lockPath = `${f.path}.native-runtime.lock`
  const result = await outcome(
    f.publish({
      platform: 'win32',
      ...time,
      rename: async () => {
        attempts++
        const lease = JSON.parse(await readFile(lockPath, 'utf8'))
        expect(typeof lease.ownerId).toBe('string')
        const successor =
          lease.ownerId === '11111111-1111-4111-8111-111111111111'
            ? '22222222-2222-4222-8222-222222222222'
            : '11111111-1111-4111-8111-111111111111'
        await writeFile(
          lockPath,
          `${JSON.stringify({ ...lease, ownerId: successor })}\n`,
        )
        throw Object.assign(new Error('synthetic sharing refusal'), {
          code: 'EBUSY',
        })
      },
    }),
  )
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'publication-refused' },
  })
  expect(attempts).toBe(1)
  expect(trace.filter((step) => step === 'before')).toHaveLength(2)
  expect(trace.filter((step) => step === 'authority')).toHaveLength(1)
  expect(trace).not.toContain('after')
  expect(await readFile(f.path, 'utf8')).toBe(f.initial)
  expect(await f.stages()).toEqual([])
})
