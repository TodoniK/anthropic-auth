import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CACHE_KEEP_REGISTRY_LEASE_MS,
  CacheKeepSessionRegistry,
  type CacheKeepTrackedSession,
} from '../cachekeep-registry.ts'

const directories: string[] = []

async function makeDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'cachekeep-registry-test-'))
  directories.push(directory)
  return directory
}

function session(id: string): CacheKeepTrackedSession {
  const cacheExpiresAt = Date.now() + 60 * 60_000
  return { id, cacheExpiresAt, nextPrewarmAt: cacheExpiresAt - 5 * 60_000 }
}

function record(updatedAt: number, sessions: CacheKeepTrackedSession[] = []) {
  return { version: 1, updatedAt, sessions }
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test('reader removes an expired record belonging to another instance', async () => {
  const directory = await makeDirectory()
  await writeFile(
    join(directory, 'stopped.json'),
    JSON.stringify(
      record(Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS - 1, [
        session('ses_stopped'),
      ]),
    ),
  )
  const reader = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'reader',
  })

  expect(await reader.list()).toEqual([])
  expect(await readdir(directory)).toEqual([])
})

test('reader keeps a fresh record belonging to another instance', async () => {
  const directory = await makeDirectory()
  const fresh = session('ses_fresh')
  await writeFile(
    join(directory, 'active.json'),
    JSON.stringify(record(Date.now(), [fresh])),
  )
  const reader = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'reader',
  })

  expect(await reader.list()).toEqual([fresh])
  expect(await readdir(directory)).toEqual(['active.json'])
})

test('a record republished while a sweep runs is kept', async () => {
  const directory = await makeDirectory()
  const recordPath = join(directory, 'publisher.json')
  await writeFile(
    recordPath,
    JSON.stringify(
      record(Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS - 1, [
        session('ses_old'),
      ]),
    ),
  )
  const reader = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'reader',
  })
  const publisher = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'publisher',
  })
  const republished = session('ses_republished')

  await Promise.all([reader.list(), publisher.publish([republished])])

  expect(await reader.list()).toEqual([republished])
  const saved = JSON.parse(await readFile(recordPath, 'utf8'))
  expect(saved.updatedAt).toBeGreaterThan(
    Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS,
  )
  expect(saved.sessions).toEqual([republished])
})

test('concurrent sweepers tolerate another sweeper moving an expired record', async () => {
  const directory = await makeDirectory()
  await writeFile(
    join(directory, 'stopped.json'),
    JSON.stringify(
      record(Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS - 1, [
        session('ses_stopped'),
      ]),
    ),
  )
  const first = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'first-reader',
  })
  const second = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'second-reader',
  })

  const results = await Promise.all([first.list(), second.list()])
  expect(results).toEqual([[], []])
  expect(await readdir(directory)).toEqual([])
})

test('a sweep never removes this instance record even if its timestamp is expired', async () => {
  const directory = await makeDirectory()
  const recordPath = join(directory, 'owner.json')
  await writeFile(
    recordPath,
    JSON.stringify(
      record(Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS - 1, [
        session('ses_owner'),
      ]),
    ),
  )
  const owner = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'owner',
  })

  expect(await owner.list()).toEqual([])
  expect(await readdir(directory)).toEqual(['owner.json'])
})

test('publishing also sweeps expired records from other instances', async () => {
  const directory = await makeDirectory()
  await writeFile(
    join(directory, 'stopped.json'),
    JSON.stringify(
      record(Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS - 1, [
        session('ses_stopped'),
      ]),
    ),
  )
  const publisher = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'publisher',
  })

  await publisher.publish([session('ses_live')])

  expect(await readdir(directory)).toEqual(['publisher.json'])
})
