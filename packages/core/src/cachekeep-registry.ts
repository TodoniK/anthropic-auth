import { randomUUID } from 'node:crypto'
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CACHE_KEEP_REGISTRY_LEASE_MS = 3 * 60_000

export type CacheKeepTrackedSession = {
  id: string
  cacheExpiresAt: number
  nextPrewarmAt: number
}

type CacheKeepRegistryRecord = {
  version: 1
  updatedAt: number
  sessions: CacheKeepTrackedSession[]
}

function normalizeSession(value: unknown): CacheKeepTrackedSession | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof record.cacheExpiresAt !== 'number' ||
    !Number.isFinite(record.cacheExpiresAt) ||
    typeof record.nextPrewarmAt !== 'number' ||
    !Number.isFinite(record.nextPrewarmAt)
  ) {
    return
  }
  return {
    id: record.id,
    cacheExpiresAt: record.cacheExpiresAt,
    nextPrewarmAt: record.nextPrewarmAt,
  }
}

function normalizeRecord(value: unknown): CacheKeepRegistryRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.updatedAt !== 'number' ||
    !Number.isFinite(record.updatedAt) ||
    !Array.isArray(record.sessions)
  ) {
    return
  }
  return {
    version: 1,
    updatedAt: record.updatedAt,
    sessions: record.sessions.flatMap((session) => {
      const normalized = normalizeSession(session)
      return normalized ? [normalized] : []
    }),
  }
}

function isExpiredRecord(
  record: CacheKeepRegistryRecord,
  now: number,
  leaseMs: number,
): boolean {
  return record.updatedAt <= now && now - record.updatedAt > leaseMs
}

export function getDefaultCacheKeepRegistryDirectory(scope: 'opencode' | 'pi') {
  return join(tmpdir(), 'opencode-anthropic-auth', 'cachekeep-sessions', scope)
}

export class CacheKeepSessionRegistry {
  private readonly filePath: string
  private writeChain: Promise<void> = Promise.resolve()
  private lastSweepAt?: number

  constructor(
    private readonly options: {
      directory: string
      now?: () => number
      leaseMs?: number
      instanceId?: string
    },
  ) {
    const instanceId = options.instanceId ?? `${process.pid}-${randomUUID()}`
    this.filePath = join(options.directory, `${instanceId}.json`)
  }

  publish(sessions: readonly CacheKeepTrackedSession[]): Promise<void> {
    const snapshot = sessions.map((session) => ({ ...session }))
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        const now = this.options.now?.() ?? Date.now()
        const leaseMs = this.options.leaseMs ?? CACHE_KEEP_REGISTRY_LEASE_MS
        if (snapshot.length === 0) {
          await rm(this.filePath, { force: true })
        } else {
          await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
          const tempPath = `${this.filePath}.${randomUUID()}.tmp`
          const record: CacheKeepRegistryRecord = {
            version: 1,
            updatedAt: now,
            sessions: snapshot,
          }
          await writeFile(tempPath, `${JSON.stringify(record)}\n`, {
            mode: 0o600,
          })
          await rename(tempPath, this.filePath)
        }
        await this.sweepExpiredRecords(now, leaseMs)
      })
    return this.writeChain
  }

  async list(
    localSessions: readonly CacheKeepTrackedSession[] = [],
  ): Promise<CacheKeepTrackedSession[]> {
    await this.writeChain.catch(() => {})
    const now = this.options.now?.() ?? Date.now()
    const leaseMs = this.options.leaseMs ?? CACHE_KEEP_REGISTRY_LEASE_MS
    await this.sweepExpiredRecords(now, leaseMs)
    let names: string[]
    try {
      names = (await readdir(this.options.directory)).filter((name) =>
        name.endsWith('.json'),
      )
    } catch {
      names = []
    }

    const records = await Promise.all(
      names.map(async (name) => {
        try {
          const raw = await readFile(join(this.options.directory, name), 'utf8')
          return normalizeRecord(JSON.parse(raw))
        } catch {
          return undefined
        }
      }),
    )
    const sessions = new Map<string, CacheKeepTrackedSession>()
    for (const record of records) {
      if (
        !record ||
        now - record.updatedAt > leaseMs ||
        record.updatedAt > now
      ) {
        continue
      }
      for (const session of record.sessions) {
        const existing = sessions.get(session.id)
        if (!existing || session.cacheExpiresAt > existing.cacheExpiresAt) {
          sessions.set(session.id, session)
        }
      }
    }
    for (const session of localSessions) {
      const existing = sessions.get(session.id)
      if (!existing || session.cacheExpiresAt > existing.cacheExpiresAt) {
        sessions.set(session.id, { ...session })
      }
    }
    return [...sessions.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )
  }

  async dispose(): Promise<void> {
    await this.writeChain.catch(() => {})
    await rm(this.filePath, { force: true })
  }

  private async sweepExpiredRecords(
    now: number,
    leaseMs: number,
  ): Promise<void> {
    if (this.lastSweepAt !== undefined && now - this.lastSweepAt < leaseMs) {
      return
    }
    this.lastSweepAt = now

    let names: string[]
    try {
      names = (await readdir(this.options.directory)).filter((name) =>
        name.endsWith('.json'),
      )
    } catch {
      return
    }

    await Promise.all(
      names.map(async (name) => {
        const recordPath = join(this.options.directory, name)
        if (recordPath === this.filePath) return

        let initialRecord: CacheKeepRegistryRecord | undefined
        try {
          initialRecord = normalizeRecord(
            JSON.parse(await readFile(recordPath, 'utf8')),
          )
        } catch {
          return
        }
        if (!initialRecord || !isExpiredRecord(initialRecord, now, leaseMs)) {
          return
        }

        const sweptPath = `${recordPath}.${randomUUID()}.sweep`
        try {
          await rename(recordPath, sweptPath)
        } catch {
          // Another publisher or sweeper may have moved the record first.
          return
        }

        let raw: string | undefined
        let record: CacheKeepRegistryRecord | undefined
        try {
          raw = await readFile(sweptPath, 'utf8')
          record = normalizeRecord(JSON.parse(raw))
        } catch {
          // Unreadable records are not safe to classify as expired.
        }

        if (record && isExpiredRecord(record, now, leaseMs)) {
          try {
            await rm(sweptPath, { force: true })
          } catch {
            // Cleanup is best-effort and must not change CacheKeep behavior.
          }
          return
        }

        await this.restoreSweptRecord(recordPath, sweptPath, raw)
      }),
    )
  }

  private async restoreSweptRecord(
    recordPath: string,
    sweptPath: string,
    raw: string | undefined,
  ): Promise<void> {
    try {
      await link(sweptPath, recordPath)
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined
      if (code === 'EEXIST') {
        // A newer atomic publication already occupies the original path.
        try {
          await rm(sweptPath, { force: true })
        } catch {
          // Cleanup is best-effort and must not change CacheKeep behavior.
        }
        return
      }
      if (raw === undefined) return

      try {
        await writeFile(recordPath, raw, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        })
      } catch (writeError) {
        const writeCode =
          writeError && typeof writeError === 'object' && 'code' in writeError
            ? writeError.code
            : undefined
        if (writeCode !== 'EEXIST') return
      }
    }

    try {
      await rm(sweptPath, { force: true })
    } catch {
      // Cleanup is best-effort and must not change CacheKeep behavior.
    }
  }
}
