import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  acquireRefreshFileLock,
  buildQuotaOperationError,
  buildRefreshOperationError,
  ClaudeOAuthRefreshError,
  fallbackAccountUuidForLineage,
  fetchOAuthAccountProfile,
  fetchOAuthQuotaSnapshot,
  formatOAuthAccountTier,
  getAccountStatePath,
  getCache1hPersistentMode,
  getClaustrumMode,
  getFallbackReauthLabels,
  getLogLevel,
  getScopedQuotaWindowForModel,
  getThinkingPrefixMismatchBehavior,
  isCacheKeepSubagentsEnabled,
  isCostZeroingEnabled,
  isFastModePersistentlyEnabled,
  isPermanentRefreshError,
  isPrimePersistentlyEnabled,
  type KillswitchThresholds,
  killswitchPassesPolicy,
  mergeHeaderQuotaSnapshot,
  mergeMainQuotaErrorClearedAt,
  normalizeQuotaHeaders,
  type OAuthAccount,
  type OAuthAccountProfile,
  type OAuthQuotaSnapshot,
  oauthProfileIsFresh,
  PROFILE_TTL_MS,
  type ProviderAccountUuid,
  QuotaManager,
  quotaFieldSource,
  quotaSnapshotModelScopeIsExhausted,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  setLogLevel,
  shouldFallbackStatus,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import {
  loadAccounts,
  persistFallbackQuotaHeaderPersistent,
  saveAccountState,
  saveAccounts,
  saveOAuthProfileState,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  setCacheKeepPersistentAlways,
  setCacheKeepPersistentEnabled,
  setCacheKeepPersistentWindow,
  setCacheKeepSubagentsEnabled,
  setClaustrumModePersistent,
  setFastModePersistentEnabled,
  setLogLevelPersistent,
  setPrimePersistentEnabled,
  upsertAccount,
} from '../../../core/src/tests/legacy-account-fixture.ts'

const providerUuid = (value: string) => value as ProviderAccountUuid

let tempDir: string
let accountPath: string
let previousStateFile: string | undefined

function expectOAuthAccount(
  account: AccountStorage['accounts'][number] | undefined,
): OAuthAccount {
  expect(account?.type).toBe('oauth')
  return account as OAuthAccount
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function seedStaleRefreshLock(name: string, now: number, ttlMs: number) {
  const lockPath = `${accountPath}.${name}.lock`
  const evictPath = `${lockPath}.evicting`
  await rm(lockPath, { recursive: true, force: true })
  await rm(evictPath, { recursive: true, force: true })
  await writeFile(
    lockPath,
    `${JSON.stringify({ ownerId: 'stale-owner', expiresAt: now - ttlMs })}\n`,
    'utf8',
  )
  await mkdir(evictPath)
  const staleTime = new Date(now - 10_000)
  await utimes(evictPath, staleTime, staleTime)
  return { lockPath, evictPath }
}

async function countRefreshLockLeaks(name: string) {
  const entries = await readdir(tempDir)
  return entries.filter(
    (entry) =>
      entry.startsWith(`anthropic-auth.json.${name}.lock.evicting`) ||
      entry.startsWith(`anthropic-auth.json.${name}.lock.evicting.`),
  ).length
}

const baseStorage = (): AccountStorage => ({
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  fallbackOn: [401, 403, 429],
  refresh: {
    enabled: true,
    intervalMinutes: 10,
    refreshBeforeExpiryMinutes: 30,
  },
  quota: {
    enabled: true,
    checkIntervalMinutes: 5,
    minimumRemaining: { five_hour: 10, seven_day: 20 },
    failClosedOnUnknownQuota: true,
  },
  accounts: [],
})

describe('main quota clear marker', () => {
  test('keeps the newer marker when an older marker arrives', () => {
    expect(mergeMainQuotaErrorClearedAt(2_000, 1_000)).toBe(2_000)
  })

  test('keeps a defined marker when undefined arrives', () => {
    expect(mergeMainQuotaErrorClearedAt(2_000, undefined)).toBe(2_000)
  })
})

describe('cross-process main quota backoff', () => {
  test('an equal-generation stale observation cannot resurrect a clear', async () => {
    const error = {
      message: 'quota API unavailable',
      checkedAt: 900_000,
      nextRetryAt: 1_060_000,
      retryCount: 1,
      accountIdentity: 'account-a',
    }
    const initial = {
      ...baseStorage(),
      mainAccountId: 'main-slot',
      quota: {
        ...baseStorage().quota,
        mainLastQuotaApiError: error,
        mainQuotaErrorGeneration: 1,
      },
    }
    await saveAccounts(initial, accountPath)
    const staleWriterStorage = (await loadAccounts(accountPath))!
    const managerA = new QuotaManager({
      storage: staleWriterStorage,
      now: () => 1_000_000,
    })
    const managerB = new QuotaManager({
      storage: staleWriterStorage,
      now: () => 1_000_000,
    })
    expect(managerA.isBackedOff()).toBe(true)
    expect(managerB.isBackedOff()).toBe(true)

    const clearWriterStorage = (await loadAccounts(accountPath))!
    clearWriterStorage.quota = {
      ...clearWriterStorage.quota,
      mainLastQuotaApiError: undefined,
      mainQuotaErrorGeneration: 2,
      mainQuotaErrorClearedAt: 1_000_200,
    }
    await saveAccountState(clearWriterStorage, accountPath, { mainQuota: true })

    const clearedStorage = (await loadAccounts(accountPath))!
    managerB.updateStorage(clearedStorage)
    staleWriterStorage.quota = {
      ...staleWriterStorage.quota,
      mainLastQuotaApiError: {
        ...error,
        checkedAt: 1_000_100,
      },
      // Both writers started from generation 1 and allocated generation 2.
      mainQuotaErrorGeneration: 2,
      mainQuotaErrorClearedAt: 1_000_100,
    }
    await saveAccountState(staleWriterStorage, accountPath, { mainQuota: true })
    const finalStorage = (await loadAccounts(accountPath))!
    expect(finalStorage.quota?.mainLastQuotaApiError).toBeUndefined()
    expect(finalStorage.quota?.mainQuotaErrorGeneration).toBe(2)
    expect(finalStorage.quota?.mainQuotaErrorClearedAt).toBe(1_000_200)
    managerB.updateStorage(finalStorage)
    expect(managerB.isBackedOff()).toBe(false)
  })

  test('a stale main refresh error cannot resurrect a refresh clear', async () => {
    const error = {
      message: 'invalid_grant',
      checkedAt: 900_000,
      nextRetryAt: 1_060_000,
      retryCount: 1,
      accountIdentity: 'main-slot',
      permanent: true,
    }
    await saveAccounts(
      {
        ...baseStorage(),
        mainAccountId: 'main-slot',
        refresh: { ...baseStorage().refresh, mainLastRefreshError: error },
      },
      accountPath,
    )
    const staleWriterStorage = (await loadAccounts(accountPath))!
    const clearWriterStorage = (await loadAccounts(accountPath))!
    clearWriterStorage.refresh = {
      ...clearWriterStorage.refresh,
      mainLastRefreshError: undefined,
      mainRefreshErrorClearedAt: 1_000_200,
    }
    await saveAccountState(clearWriterStorage, accountPath, {
      mainRefresh: true,
    })

    await saveAccountState(staleWriterStorage, accountPath, {
      mainRefresh: true,
    })
    expect(
      (await loadAccounts(accountPath))?.refresh?.mainLastRefreshError,
    ).toBeUndefined()

    staleWriterStorage.refresh = {
      ...staleWriterStorage.refresh,
      mainLastRefreshError: { ...error, checkedAt: 1_000_300 },
    }
    await saveAccountState(staleWriterStorage, accountPath, {
      mainRefresh: true,
    })
    expect(
      (await loadAccounts(accountPath))?.refresh?.mainLastRefreshError
        ?.checkedAt,
    ).toBe(1_000_300)
  })
})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-test-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  previousStateFile = process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
  // The fixture owns both files, even if another suite left a state-path override.
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
    tempDir,
    'anthropic-auth-state.json',
  )
})

test('does not echo secrets from corrupt account stores', async () => {
  const expectRedactedCorruption = async (path: string, content: string) => {
    await writeFile(path, content, 'utf8')
    let caught: unknown
    try {
      await loadAccounts(accountPath)
    } catch (error) {
      caught = error
    }

    expect(caught instanceof Error).toBe(true)
    const error = caught as Error
    expect(error.message.includes('CANARY')).toBe(false)
    expect(String(error.cause ?? '').includes('CANARY')).toBe(false)
    expect(error.message).not.toContain('Unexpected identifier')
    expect(error.message).toContain(path)
    expect(error.message).toContain('fix or remove it')
  }

  await writeFile(accountPath, JSON.stringify(baseStorage()), 'utf8')
  await expectRedactedCorruption(
    getAccountStatePath(accountPath),
    '{"main":{"access":sk-ant-oat-CANARY-SECRET-0000}}',
  )

  await expectRedactedCorruption(
    accountPath,
    '{"main":{"claustrumHandle":claustrumHandle-CANARY-SECRET-0000}}',
  )
})

afterEach(async () => {
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  if (previousStateFile === undefined)
    delete process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
  else process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = previousStateFile
  await rm(tempDir, { recursive: true, force: true })
  mock.restore()
})

describe('OAuth account profiles', () => {
  const mainCapture = {
    account: { has_claude_max: true },
    organization: {
      organization_type: 'claude_max',
      rate_limit_tier: 'default_claude_max_20x',
    },
  }
  const teamCapture = {
    account: { has_claude_max: false },
    organization: {
      organization_type: 'claude_team',
      rate_limit_tier: 'default_claude_max_5x',
      seat_tier: 'team_tier_1',
    },
  }

  async function fetchProfile(capture: unknown) {
    return fetchOAuthAccountProfile({
      accessToken: 'token',
      now: () => 1234,
      fetchImpl: (async () =>
        Response.json(capture)) as unknown as typeof fetch,
    })
  }

  test('fetchOAuthAccountProfile normalizes the personal Max 20x capture', async () => {
    const profile = await fetchProfile(mainCapture)

    expect(profile).toEqual({
      tier: 'default_claude_max_20x',
      orgType: 'claude_max',
      checkedAt: 1234,
    })
    expect(formatOAuthAccountTier(profile)).toBe('Max 20x')
  })

  test('fetchOAuthAccountProfile normalizes the Team Max-5x capture', async () => {
    const profile = await fetchProfile(teamCapture)

    expect(profile).toEqual({
      tier: 'default_claude_max_5x',
      orgType: 'claude_team',
      checkedAt: 1234,
    })
    expect(formatOAuthAccountTier(profile)).toBe('Team · Max 5x')
  })

  test('fetchOAuthAccountProfile rejects blank account metadata', async () => {
    await expect(
      fetchProfile({
        organization: {
          organization_type: '   ',
          rate_limit_tier: '',
        },
      }),
    ).rejects.toThrow('missing account metadata')
  })

  test('profile freshness expires at seven days', () => {
    const profile: OAuthAccountProfile = {
      tier: 'default_claude_max_20x',
      orgType: 'claude_max',
      checkedAt: 100,
    }

    expect(
      oauthProfileIsFresh(profile, profile.checkedAt + PROFILE_TTL_MS - 1),
    ).toBe(true)
    expect(
      oauthProfileIsFresh(profile, profile.checkedAt + PROFILE_TTL_MS),
    ).toBe(false)
  })

  test('dedicated main and scoped fallback profiles survive sidecar load', async () => {
    const storage = baseStorage()
    const mainProfile: OAuthAccountProfile = {
      tier: 'default_claude_max_20x',
      orgType: 'claude_max',
      checkedAt: 100,
    }
    const fallbackProfile: OAuthAccountProfile = {
      tier: 'default_claude_max_5x',
      orgType: 'claude_team',
      checkedAt: 200,
    }
    storage.main = { ...storage.main!, profile: mainProfile }
    storage.accounts.push({
      id: 'work',
      type: 'oauth',
      refresh: 'refresh',
      profile: fallbackProfile,
    })

    await saveAccounts(storage, accountPath)
    await saveAccountState(storage, accountPath, { mainProfile: true })
    const loaded = await loadAccounts(accountPath)

    expect(loaded?.main?.profile).toEqual(mainProfile)
    expect(expectOAuthAccount(loaded?.accounts[0]).profile).toEqual(
      fallbackProfile,
    )
  })

  test('profile runtime fields are omitted from anthropic-auth.json', async () => {
    const storage = baseStorage()
    storage.main = {
      ...storage.main!,
      profile: { tier: 'tier', orgType: 'org', checkedAt: 100 },
    }
    storage.accounts.push({
      id: 'work',
      type: 'oauth',
      refresh: 'refresh',
      profile: { tier: 'tier', orgType: 'org', checkedAt: 100 },
    })

    await saveAccounts(storage, accountPath)
    const config = JSON.parse(await readFile(accountPath, 'utf8'))

    expect(config.main.profile).toBeUndefined()
    expect(config.accounts[0].profile).toBeUndefined()
  })

  test('re-login does not retain a previous account profile', () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'work',
      type: 'oauth',
      refresh: 'old',
      profile: { tier: 'old', orgType: 'old', checkedAt: 100 },
    })

    upsertAccount(storage, { id: 'work', type: 'oauth', refresh: 'new' })

    expect(expectOAuthAccount(storage.accounts[0]).profile).toBeUndefined()
  })

  test('runtime merge clears a fallback profile when OAuth credentials rotate', async () => {
    const initial = baseStorage()
    initial.accounts.push({
      id: 'work',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      profile: {
        tier: 'old-tier',
        orgType: 'claude_team',
        checkedAt: 100,
        tokenFingerprint: tokenFingerprint('old-access'),
      },
    })
    await saveAccounts(initial, accountPath)

    const rotated = baseStorage()
    rotated.accounts.push({
      id: 'work',
      type: 'oauth',
      access: 'new-access',
      refresh: 'new-refresh',
    })
    await saveAccounts(rotated, accountPath)

    expect(
      expectOAuthAccount((await loadAccounts(accountPath))?.accounts[0])
        .profile,
    ).toBeUndefined()
  })

  test('runtime merge keeps a fallback profile when OAuth credentials match', async () => {
    const profile: OAuthAccountProfile = {
      tier: 'same-tier',
      orgType: 'claude_team',
      checkedAt: 100,
      tokenFingerprint: tokenFingerprint('same-access'),
    }
    const initial = baseStorage()
    initial.accounts.push({
      id: 'work',
      type: 'oauth',
      access: 'same-access',
      refresh: 'same-refresh',
      profile,
    })
    await saveAccounts(initial, accountPath)

    const sameCredentials = baseStorage()
    sameCredentials.accounts.push({
      id: 'work',
      type: 'oauth',
      access: 'same-access',
      refresh: 'same-refresh',
    })
    await saveAccounts(sameCredentials, accountPath)

    expect(
      expectOAuthAccount((await loadAccounts(accountPath))?.accounts[0])
        .profile,
    ).toEqual(profile)
  })

  test('delayed main profile clear preserves a newer profile for the same token', async () => {
    const accessToken = 'main-access'
    const expectedTokenFingerprint = tokenFingerprint(accessToken)
    const staleProfile: OAuthAccountProfile = {
      tier: 'old-tier',
      orgType: 'old-org',
      checkedAt: 100,
      tokenFingerprint: tokenFingerprint('old-main-access'),
    }
    const freshProfile: OAuthAccountProfile = {
      tier: 'default_claude_max_20x',
      orgType: 'claude_max',
      checkedAt: 200,
      tokenFingerprint: expectedTokenFingerprint,
    }
    const storage = baseStorage()
    storage.main = { ...storage.main!, profile: staleProfile }
    await saveAccounts(storage, accountPath)
    await saveAccountState(storage, accountPath, { mainProfile: true })

    const processAView = await loadAccounts(accountPath)
    expect(processAView?.main?.profile).toEqual(staleProfile)
    expect(
      await saveOAuthProfileState(
        {
          accountId: 'main',
          profile: undefined,
          accountIdentity: 'main',
        },
        accountPath,
      ),
    ).toBe(false)
    expect(
      await saveOAuthProfileState(
        {
          accountId: 'main',
          profile: freshProfile,
          accountIdentity: 'main',
        },
        accountPath,
      ),
    ).toBe(true)

    const clearAccepted = await saveOAuthProfileState(
      {
        accountId: 'main',
        profile: undefined,
        accountIdentity: 'main',
      },
      accountPath,
    )
    expect((await loadAccounts(accountPath))?.main?.profile).toEqual({
      ...freshProfile,
      accountIdentity: 'main',
    })
    expect(clearAccepted).toBe(false)
  })

  test('delayed fallback profile clear preserves a newer profile for the same token', async () => {
    const accessToken = 'fallback-access'
    const expectedTokenFingerprint = tokenFingerprint(accessToken)
    const staleProfile: OAuthAccountProfile = {
      tier: 'old-tier',
      orgType: 'old-org',
      checkedAt: 100,
      tokenFingerprint: tokenFingerprint('old-fallback-access'),
    }
    const freshProfile: OAuthAccountProfile = {
      tier: 'default_claude_max_5x',
      orgType: 'claude_team',
      checkedAt: 200,
      tokenFingerprint: expectedTokenFingerprint,
    }
    const storage = baseStorage()
    storage.accounts.push({
      id: 'work',
      type: 'oauth',
      access: accessToken,
      refresh: 'refresh',
      profile: staleProfile,
    })
    await saveAccounts(storage, accountPath)

    const processAView = await loadAccounts(accountPath)
    expect(expectOAuthAccount(processAView?.accounts[0]).profile).toEqual(
      staleProfile,
    )
    expect(
      await saveOAuthProfileState(
        {
          accountId: 'work',
          profile: undefined,
          accountIdentity: 'work',
        },
        accountPath,
      ),
    ).toBe(false)
    expect(
      await saveOAuthProfileState(
        {
          accountId: 'work',
          profile: freshProfile,
          accountIdentity: 'work',
        },
        accountPath,
      ),
    ).toBe(true)

    const clearAccepted = await saveOAuthProfileState(
      {
        accountId: 'work',
        profile: undefined,
        accountIdentity: 'work',
      },
      accountPath,
    )
    expect(
      expectOAuthAccount((await loadAccounts(accountPath))?.accounts[0])
        .profile,
    ).toEqual({ ...freshProfile, accountIdentity: 'work' })
    expect(clearAccepted).toBe(false)
  })

  test('rotated access token reuses the same account profile', async () => {
    const firstToken = 'first-access'
    const secondToken = 'second-access'
    const firstProfile: OAuthAccountProfile = {
      tier: 'default_claude_max_5x',
      orgType: 'claude_team',
      checkedAt: 100,
      tokenFingerprint: tokenFingerprint(firstToken),
    }
    const secondProfile: OAuthAccountProfile = {
      tier: 'default_claude_max_5x',
      orgType: 'claude_team',
      checkedAt: 200,
      tokenFingerprint: tokenFingerprint(secondToken),
    }
    const storage = baseStorage()
    storage.main = { ...storage.main!, profile: firstProfile }
    await saveAccounts(storage, accountPath)
    await saveAccountState(storage, accountPath, { mainProfile: true })

    expect(
      await saveOAuthProfileState(
        {
          accountId: 'main',
          profile: secondProfile,
          accountIdentity: 'main',
        },
        accountPath,
      ),
    ).toBe(true)
    expect((await loadAccounts(accountPath))?.main?.profile).toEqual({
      ...secondProfile,
      accountIdentity: 'main',
    })
  })

  test('older profile cannot overwrite newer profile for the same identity', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)
    const newer: OAuthAccountProfile = {
      tier: 'new-tier',
      orgType: 'new-org',
      checkedAt: 200,
      accountIdentity: 'main',
    }
    const older: OAuthAccountProfile = {
      tier: 'old-tier',
      orgType: 'old-org',
      checkedAt: 100,
      accountIdentity: 'main',
    }

    expect(
      await saveOAuthProfileState(
        { accountId: 'main', profile: newer, accountIdentity: 'main' },
        accountPath,
      ),
    ).toBe(true)
    expect(
      await saveOAuthProfileState(
        { accountId: 'main', profile: older, accountIdentity: 'main' },
        accountPath,
      ),
    ).toBe(false)
    expect((await loadAccounts(accountPath))?.main?.profile).toEqual(newer)
  })

  test('different identity does not reuse another account profile', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)
    const first: OAuthAccountProfile = {
      tier: 'first-tier',
      orgType: 'first-org',
      checkedAt: 200,
      accountIdentity: 'account-a',
    }
    const second: OAuthAccountProfile = {
      tier: 'second-tier',
      orgType: 'second-org',
      checkedAt: 100,
      accountIdentity: 'account-b',
    }

    expect(
      await saveOAuthProfileState(
        { accountId: 'main', profile: first, accountIdentity: 'account-a' },
        accountPath,
      ),
    ).toBe(true)
    expect(
      await saveOAuthProfileState(
        { accountId: 'main', profile: second, accountIdentity: 'account-b' },
        accountPath,
      ),
    ).toBe(true)
    expect((await loadAccounts(accountPath))?.main?.profile).toEqual(second)
  })

  test('legacy profile without identity is adopted under the current identity', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)
    const legacy: OAuthAccountProfile = {
      tier: 'legacy-tier',
      orgType: 'legacy-org',
      checkedAt: 100,
      tokenFingerprint: tokenFingerprint('old-access'),
    }

    expect(
      await saveOAuthProfileState(
        { accountId: 'main', profile: legacy, accountIdentity: 'main' },
        accountPath,
      ),
    ).toBe(true)
    expect((await loadAccounts(accountPath))?.main?.profile).toEqual({
      ...legacy,
      accountIdentity: 'main',
    })
  })

  test('missing identity never deletes stored profile state', async () => {
    const profile: OAuthAccountProfile = {
      tier: 'default_claude_max_5x',
      orgType: 'claude_team',
      checkedAt: 100,
      accountIdentity: 'main',
    }
    const storage = {
      ...baseStorage(),
      main: { ...baseStorage().main!, profile },
    }
    await saveAccounts(storage, accountPath)
    await saveAccountState(storage, accountPath, { mainProfile: true })

    expect(
      await saveOAuthProfileState(
        { accountId: 'main', profile: undefined },
        accountPath,
      ),
    ).toBe(false)
    expect((await loadAccounts(accountPath))?.main?.profile).toEqual(profile)
  })
})

describe('thinkingBinding.prefixMismatchBehavior', () => {
  test('persists explicit behavior and defaults unknown values safely', async () => {
    const storage = baseStorage()
    storage.thinkingBinding = { prefixMismatchBehavior: 'error' }
    await saveAccounts(storage)
    const loaded = await loadAccounts()
    expect(loaded?.thinkingBinding).toEqual({
      prefixMismatchBehavior: 'error',
    })
    expect(getThinkingPrefixMismatchBehavior(loaded)).toBe('error')
    expect(
      getThinkingPrefixMismatchBehavior({
        thinkingBinding: {
          prefixMismatchBehavior: 'unknown' as 'account-default',
        },
      }),
    ).toBe('account-default')
  })
})

describe('isCostZeroingEnabled', () => {
  test('defaults to enabled when costZeroing is absent', () => {
    expect(isCostZeroingEnabled(baseStorage())).toBe(true)
  })

  test('stays enabled when explicitly enabled', () => {
    expect(isCostZeroingEnabled({ costZeroing: { enabled: true } })).toBe(true)
  })

  test('is disabled only when explicitly set to false', () => {
    expect(isCostZeroingEnabled({ costZeroing: { enabled: false } })).toBe(
      false,
    )
  })

  test('persists across save/load round-trip', async () => {
    const storage = baseStorage()
    storage.costZeroing = { enabled: false }
    await saveAccounts(storage)
    const loaded = await loadAccounts()
    expect(loaded!.costZeroing).toEqual({ enabled: false })
    expect(isCostZeroingEnabled(loaded!)).toBe(false)
  })
})

describe('account storage', () => {
  test('preserves mixed quota field provenance across a save/load round-trip', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 123,
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 600,
        },
        seven_day: {
          usedPercent: 40,
          remainingPercent: 60,
          checkedAt: 700,
        },
        fieldSources: {
          five_hour: 'poll',
          seven_day: 'headers',
        },
        source: 'headers',
        checkedAt: 700,
      },
    })

    await saveAccounts(storage, accountPath)

    const loaded = await loadAccounts(accountPath)
    const quota = expectOAuthAccount(loaded?.accounts[0]).quota
    expect(quota?.fieldSources).toEqual({
      five_hour: 'poll',
      seven_day: 'headers',
    })
  })

  test('keeps a reloaded poll window poll-owned during a partial header harvest', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 123,
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 600,
        },
        seven_day: {
          usedPercent: 40,
          remainingPercent: 60,
          checkedAt: 700,
        },
        fieldSources: {
          five_hour: 'poll',
          seven_day: 'headers',
        },
        source: 'headers',
        checkedAt: 700,
      },
    })
    await saveAccounts(storage, accountPath)

    const loaded = await loadAccounts(accountPath)
    const existing = expectOAuthAccount(loaded?.accounts[0]).quota
    const merged = mergeHeaderQuotaSnapshot(
      existing,
      normalizeQuotaHeaders(
        new Headers({
          'anthropic-ratelimit-unified-7d-utilization': '0.5',
        }),
        800,
      ),
    )

    expect(quotaFieldSource(merged, 'five_hour')).toBe('poll')
    expect(quotaFieldSource(merged, 'seven_day')).toBe('headers')
  })

  test('filters unknown quota provenance fields and invalid sources on load', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 123,
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 600,
        },
        seven_day: {
          usedPercent: 40,
          remainingPercent: 60,
          checkedAt: 700,
        },
        fieldSources: {
          five_hour: 'poll',
          seven_day: 'headers',
          unknown: 'poll',
          extraUsage: 'database',
        } as unknown as OAuthQuotaSnapshot['fieldSources'],
        source: 'headers',
        checkedAt: 700,
      },
    })

    await saveAccounts(storage, accountPath)

    const loaded = await loadAccounts(accountPath)
    expect(expectOAuthAccount(loaded?.accounts[0]).quota?.fieldSources).toEqual(
      {
        five_hour: 'poll',
        seven_day: 'headers',
      },
    )
  })

  test('drops provenance for quota fields rejected during normalization', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 123,
      quota: {
        five_hour: {
          usedPercent: 'not-a-number' as unknown as number,
          remainingPercent: 80,
          checkedAt: 600,
        },
        seven_day: {
          usedPercent: 40,
          remainingPercent: 60,
          checkedAt: 700,
        },
        fieldSources: {
          five_hour: 'poll',
          seven_day: 'headers',
        },
        source: 'headers',
        checkedAt: 700,
      },
    })

    await saveAccounts(storage, accountPath)

    const loaded = await loadAccounts(accountPath)
    const quota = expectOAuthAccount(loaded?.accounts[0]).quota
    expect(quota?.five_hour).toBeUndefined()
    expect(quota?.fieldSources).toEqual({ seven_day: 'headers' })
  })

  test('saves and loads sidecar accounts', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 123,
    })

    await saveAccounts(storage)

    const rawConfig = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(rawConfig.accounts[0].id).toBe('fallback-1')
    expect(rawConfig.accounts[0].access).toBeUndefined()
    expect(rawConfig.accounts[0].refresh).toBeUndefined()

    const rawState = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(rawState.accounts['fallback-1'].access).toBe('access')
    expect(rawState.accounts['fallback-1'].refresh).toBe('refresh')

    await expect(loadAccounts()).resolves.toEqual(storage)
  })

  test('stores API fallback route secret in runtime state and endpoint in config', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'kie-opus',
      label: 'Kie Opus',
      type: 'api',
      apiKey: 'kie-key',
      baseURL: 'https://api.kie.ai/claude',
      authHeader: 'authorization-bearer',
    })

    await saveAccounts(storage)

    const rawConfig = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(rawConfig.accounts[0]).toMatchObject({
      id: 'kie-opus',
      label: 'Kie Opus',
      type: 'api',
      baseURL: 'https://api.kie.ai/claude',
      authHeader: 'authorization-bearer',
    })
    expect(rawConfig.accounts[0].apiKey).toBeUndefined()

    const rawState = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(rawState.accounts['kie-opus'].apiKey).toBe('kie-key')

    await expect(loadAccounts()).resolves.toEqual(storage)
  })

  test('prefers newer legacy config OAuth credentials over stale runtime state', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [
          {
            id: 'umut',
            label: 'umut',
            type: 'oauth',
            enabled: true,
            addedAt: 1,
            lastUsed: 2_000,
            access: 'new-access',
            refresh: 'new-refresh',
            expires: 3_000,
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      getAccountStatePath(),
      JSON.stringify({
        version: 1,
        accounts: {
          umut: {
            access: 'old-access',
            refresh: 'old-refresh',
            expires: 1_000,
            lastRefreshedAt: 1_000,
            lastRefreshError: {
              message: 'Claude OAuth refresh failed: 400 invalid_grant',
              checkedAt: 1_500,
              nextRetryAt: 99_999,
              status: 400,
              permanent: true,
            },
            lastQuotaRefreshError: {
              message: 'refresh backed off',
              checkedAt: 1_500,
            },
            quota: {
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: 1_500,
              },
            },
          },
        },
      }),
      'utf8',
    )

    const loaded = await loadAccounts()
    const account = loaded?.accounts[0]
    expect(account?.type).toBe('oauth')
    if (account?.type !== 'oauth') throw new Error('expected oauth account')
    expect(account).toMatchObject({
      id: 'umut',
      access: 'new-access',
      refresh: 'new-refresh',
      expires: 3_000,
      lastUsed: 2_000,
      lastRefreshedAt: 2_000,
    })
    expect(account.lastRefreshError).toBeUndefined()
    expect(account.lastQuotaRefreshError).toBeUndefined()
    expect(account.quota).toBeUndefined()
  })

  test('keeps newer runtime OAuth credentials over older legacy config credentials', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [
          {
            id: 'umut',
            label: 'umut',
            type: 'oauth',
            enabled: true,
            addedAt: 1,
            lastUsed: 500,
            access: 'old-config-access',
            refresh: 'old-config-refresh',
            expires: 500,
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      getAccountStatePath(),
      JSON.stringify({
        version: 1,
        accounts: {
          umut: {
            access: 'new-state-access',
            refresh: 'new-state-refresh',
            expires: 2_000,
            lastRefreshedAt: 2_000,
          },
        },
      }),
      'utf8',
    )

    const loaded = await loadAccounts()
    expect(loaded?.accounts[0]).toMatchObject({
      id: 'umut',
      access: 'new-state-access',
      refresh: 'new-state-refresh',
      expires: 2_000,
      lastRefreshedAt: 2_000,
    })
  })

  test('drops API fallback routes with invalid base URLs on load', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [
          {
            id: 'bad-api',
            type: 'api',
            baseURL: 'https://token@example.com/v1',
            enabled: true,
          },
          {
            id: 'good-api',
            type: 'api',
            baseURL: 'https://api.kie.ai/claude',
            enabled: true,
          },
        ],
      }),
      'utf8',
    )

    const loaded = await loadAccounts()
    expect(loaded?.accounts.map((account) => account.id)).toEqual(['good-api'])
  })

  test('preserves runtime state when config membership entry is shape-invalid', async () => {
    const seeded = baseStorage()
    seeded.accounts = [
      {
        id: 'a',
        type: 'api',
        apiKey: 'api-key',
        baseURL: 'https://api.example.com/v1',
      },
      {
        id: 'b',
        type: 'oauth',
        access: 'access-b',
        refresh: 'refresh-b',
      },
    ]
    await saveAccounts(seeded, accountPath)
    const staleStorage = await loadAccounts(accountPath)
    expect(staleStorage?.accounts.map((account) => account.id)).toEqual([
      'a',
      'b',
    ])

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [{ id: 'a', type: 'api', baseURL: 'garbage' }],
      }),
      'utf8',
    )

    await saveAccountState(staleStorage!, accountPath, { accounts: true })
    const state = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(state.accounts).toHaveProperty('a')
    expect(state.accounts).toHaveProperty('b')
    expect(state.accounts.a.apiKey).toBe('api-key')
    expect(state.accounts.b.refresh).toBe('refresh-b')
  })

  test('prunes runtime state for a fully valid config membership set', async () => {
    const seeded = baseStorage()
    seeded.accounts = [
      {
        id: 'a',
        type: 'api',
        apiKey: 'api-key',
        baseURL: 'https://api.example.com/v1',
      },
      {
        id: 'b',
        type: 'oauth',
        access: 'access-b',
        refresh: 'refresh-b',
      },
    ]
    await saveAccounts(seeded, accountPath)
    const staleStorage = await loadAccounts(accountPath)
    expect(staleStorage?.accounts.map((account) => account.id)).toEqual([
      'a',
      'b',
    ])

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [
          { id: 'a', type: 'api', baseURL: 'https://api.example.com/v1' },
        ],
      }),
      'utf8',
    )

    await saveAccountState(staleStorage!, accountPath, { accounts: true })
    const state = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(state.accounts).toEqual({ a: expect.any(Object) })
    expect(state.accounts.b).toBeUndefined()
  })

  test('uses incoming account credentials to establish config membership', async () => {
    const seeded = baseStorage()
    seeded.accounts = [
      {
        id: 'x',
        type: 'oauth',
        access: 'access-x',
        refresh: 'refresh-x',
      },
    ]
    await saveAccounts(seeded, accountPath)
    const loaded = await loadAccounts(accountPath)
    expect(loaded?.accounts.map((account) => account.id)).toEqual(['x'])

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [{ id: 'y', type: 'oauth' }],
      }),
      'utf8',
    )

    const incoming = baseStorage()
    incoming.accounts = [
      {
        id: 'y',
        type: 'oauth',
        access: 'access-y',
        refresh: 'refresh-y',
      },
    ]
    await saveAccountState(incoming, accountPath, { accounts: true })
    const state = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(state.accounts).toEqual({ y: expect.any(Object) })
    expect(state.accounts.x).toBeUndefined()
    expect(state.accounts.y.refresh).toBe('refresh-y')
  })

  test('does not establish membership from config-owned fields on an incoming api account', async () => {
    const seeded = baseStorage()
    seeded.accounts = [
      {
        id: 'a',
        type: 'api',
        apiKey: 'api-key-a',
        baseURL: 'https://api.example.com/v1',
      },
      {
        id: 'b',
        type: 'oauth',
        access: 'access-b',
        refresh: 'refresh-b',
      },
    ]
    await saveAccounts(seeded, accountPath)

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [{ id: 'a', type: 'api' }],
      }),
      'utf8',
    )

    const incoming = baseStorage()
    incoming.accounts = [
      {
        id: 'a',
        type: 'api',
        apiKey: 'api-key-a-new',
        baseURL: 'https://api.example.com/v1',
      },
    ]
    await saveAccountState(incoming, accountPath, { accounts: true })

    const state = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(state.accounts).toHaveProperty('a')
    expect(state.accounts).toHaveProperty('b')
  })

  test('keeps runtime state when incoming storage cannot validate config membership', async () => {
    const seeded = baseStorage()
    seeded.accounts = [
      {
        id: 'x',
        type: 'oauth',
        access: 'access-x',
        refresh: 'refresh-x',
      },
    ]
    await saveAccounts(seeded, accountPath)
    const loaded = await loadAccounts(accountPath)
    expect(loaded?.accounts.map((account) => account.id)).toEqual(['x'])

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [{ id: 'y', type: 'oauth' }],
      }),
      'utf8',
    )

    await saveAccountState(loaded!, accountPath, { accounts: true })
    const state = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(state.accounts.x.refresh).toBe('refresh-x')
    expect(state.accounts.y).toBeUndefined()
  })

  test('does not establish membership from an id-less shape-valid config entry', async () => {
    const seeded = baseStorage()
    seeded.accounts = [
      {
        id: 'a',
        type: 'oauth',
        access: 'access-a',
        refresh: 'refresh-a',
      },
      {
        id: 'b',
        type: 'oauth',
        access: 'access-b',
        refresh: 'refresh-b',
      },
    ]
    await saveAccounts(seeded, accountPath)
    const staleStorage = await loadAccounts(accountPath)
    expect(staleStorage?.accounts.map((account) => account.id)).toEqual([
      'a',
      'b',
    ])

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [{ type: 'oauth', refresh: 'new-refresh' }],
      }),
      'utf8',
    )

    const loaded = await loadAccounts(accountPath)
    expect(loaded?.accounts).toHaveLength(1)
    await saveAccountState(staleStorage!, accountPath, { accounts: true })
    const state = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(state.accounts).toHaveProperty('a')
    expect(state.accounts).toHaveProperty('b')
  })

  test('prunes runtime state for an explicitly empty config account list', async () => {
    const seeded = baseStorage()
    seeded.accounts = [
      {
        id: 'a',
        type: 'oauth',
        access: 'access-a',
        refresh: 'refresh-a',
      },
    ]
    await saveAccounts(seeded, accountPath)
    const staleStorage = await loadAccounts(accountPath)
    expect(staleStorage?.accounts).toHaveLength(1)

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [],
      }),
      'utf8',
    )

    await saveAccountState(staleStorage!, accountPath, { accounts: true })
    const state = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(state.accounts).toEqual({})
  })

  test('runtime state saves do not rewrite user-editable config', async () => {
    const storage = baseStorage()
    storage.quota = {
      ...storage.quota,
      checkIntervalMinutes: 20,
      mainQuota: {
        five_hour: {
          usedPercent: 11,
          remainingPercent: 89,
          checkedAt: 123,
        },
      },
      mainQuotaCheckedAt: 123,
      mainQuotaToken: 'token-a',
    }
    await saveAccounts(storage)

    const staleRuntimeView = await loadAccounts()
    expect(staleRuntimeView).not.toBeNull()
    ;(staleRuntimeView as AccountStorage).quota = {
      ...(staleRuntimeView as AccountStorage).quota,
      checkIntervalMinutes: 5,
      mainQuota: {
        five_hour: {
          usedPercent: 22,
          remainingPercent: 78,
          checkedAt: 456,
        },
      },
      mainQuotaCheckedAt: 456,
      mainQuotaToken: 'token-b',
    }

    await saveAccountState(staleRuntimeView as AccountStorage, accountPath, {
      mainQuota: true,
    })

    const rawConfig = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(rawConfig.quota.checkIntervalMinutes).toBe(20)
    expect(rawConfig.quota.mainQuota).toBeUndefined()

    const loaded = await loadAccounts()
    expect(loaded?.quota?.checkIntervalMinutes).toBe(20)
    expect(loaded?.quota?.mainQuotaToken).toBe('token-b')
    expect(loaded?.quota?.mainQuota?.five_hour?.usedPercent).toBe(22)
  })

  test('runtime state saves preserve accounts when config is missing', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access-before',
      refresh: 'refresh-before',
      expires: 10_000,
      lastRefreshedAt: 100,
    })
    await saveAccounts(storage, accountPath)
    await rm(accountPath)
    storage.accounts[0] = {
      ...storage.accounts[0],
      access: 'access-after',
      refresh: 'refresh-after',
      expires: 2_000,
      lastRefreshedAt: 200,
    } as OAuthAccount

    await saveAccountState(storage, accountPath)

    const rawState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(rawState.accounts['fallback-1']).toMatchObject({
      access: 'access-after',
      refresh: 'refresh-after',
      expires: 2_000,
      lastRefreshedAt: 200,
    })
  })

  test('runtime state saves preserve whitespace-padded configured account ids', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [
          { id: ' fb-1 ', type: 'oauth', refresh: 'refresh-padded' },
          { id: 'fb-control', type: 'oauth', refresh: 'refresh-control' },
        ],
      }),
      'utf8',
    )
    await writeFile(
      getAccountStatePath(accountPath),
      JSON.stringify({
        version: 1,
        accounts: {
          ' fb-1 ': {
            access: 'access-padded',
            refresh: 'refresh-padded',
            expires: 1_000,
          },
          'fb-control': {
            access: 'access-control',
            refresh: 'refresh-control',
            expires: 1_000,
          },
        },
      }),
      'utf8',
    )
    const loaded = await loadAccounts(accountPath)
    expect(loaded).not.toBeNull()
    expect(loaded?.accounts.map((account) => account.id)).toEqual([
      'fb-1',
      'fb-control',
    ])
    expect((loaded!.accounts[0] as OAuthAccount).refresh).toBe('refresh-padded')

    await saveAccountState(loaded!, accountPath, {
      accounts: ['fb-1', 'fb-control'],
    })

    const state = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    ) as { accounts?: Record<string, { refresh?: string }> }
    expect(Object.keys(state.accounts ?? {}).sort()).toEqual([
      'fb-1',
      'fb-control',
    ])
    expect(state.accounts?.['fb-1']?.refresh).toBe('refresh-padded')
    expect(state.accounts?.['fb-control']?.refresh).toBe('refresh-control')
  })

  test('loads a trimmed legacy state key for a padded configured account', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        ...baseStorage(),
        accounts: [{ id: ' fb-1 ', type: 'oauth', enabled: true }],
      }),
    )
    await writeFile(
      getAccountStatePath(accountPath),
      JSON.stringify({
        version: 1,
        accounts: {
          'fb-1': {
            access: 'access-trimmed',
            refresh: 'refresh-trimmed',
            expires: Date.now() + 3_600_000,
          },
        },
      }),
    )

    const loaded = await loadAccounts(accountPath)
    expect(loaded?.accounts).toHaveLength(1)
    expect((loaded!.accounts[0] as OAuthAccount).refresh).toBe(
      'refresh-trimmed',
    )

    await saveAccountState({ ...loaded!, accounts: [] }, accountPath, {
      accounts: true,
    })
    const state = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(state.accounts).toEqual({
      'fb-1': {
        access: 'access-trimmed',
        refresh: 'refresh-trimmed',
        expires: expect.any(Number),
      },
    })
    expect((await loadAccounts(accountPath))?.accounts).toHaveLength(1)
  })

  test('persists rotated credentials under the key the padded loader accepts', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        ...baseStorage(),
        accounts: [{ id: ' fb-1 ', type: 'oauth' }],
      }),
    )
    await writeFile(
      getAccountStatePath(accountPath),
      JSON.stringify({
        version: 1,
        accounts: {
          ' fb-1 ': {
            access: 'access-old',
            refresh: 'refresh-old',
            expires: Date.now() + 3_600_000,
            lastRefreshedAt: 100,
          },
        },
      }),
    )

    const loaded = await loadAccounts(accountPath)
    expect((loaded!.accounts[0] as OAuthAccount).access).toBe('access-old')
    const rotated = loaded!.accounts[0] as OAuthAccount
    rotated.access = 'access-new'
    rotated.refresh = 'refresh-new'
    rotated.expires = Date.now() + 7_200_000
    rotated.lastRefreshedAt = 200
    await saveAccountState(loaded!, accountPath, { accounts: ['fb-1'] })

    const state = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(Object.keys(state.accounts ?? {})).toEqual(['fb-1'])
    expect((await loadAccounts(accountPath))?.accounts[0]).toMatchObject({
      access: 'access-new',
      refresh: 'refresh-new',
    })
  })

  test('runtime state saves preserve all state when config has a whitespace-only account id', async () => {
    const seeded = baseStorage()
    seeded.accounts.push({
      id: 'fb-1',
      type: 'oauth',
      access: 'access-before',
      refresh: 'refresh-before',
      expires: 10_000,
    })
    await saveAccounts(seeded, accountPath)

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [{ id: '   ' }],
      }),
      'utf8',
    )
    const loaded = await loadAccounts(accountPath)
    expect(loaded?.accounts).toHaveLength(0)

    await saveAccountState(loaded!, accountPath, { accounts: true })

    const state = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    ) as { accounts?: Record<string, { refresh?: string }> }
    expect(state.accounts?.['fb-1']?.refresh).toBe('refresh-before')
  })

  test('runtime state saves preserve accounts when config omits accounts', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access-before',
      refresh: 'refresh-before',
      expires: 1_000,
      lastRefreshedAt: 100,
    })
    await saveAccounts(storage, accountPath)
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
      }),
      'utf8',
    )
    storage.accounts[0] = {
      ...storage.accounts[0],
      access: 'access-after',
      refresh: 'refresh-after',
      expires: 2_000,
      lastRefreshedAt: 200,
    } as OAuthAccount

    await saveAccountState(storage, accountPath)

    const rawState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(rawState.accounts['fallback-1']).toMatchObject({
      access: 'access-after',
      refresh: 'refresh-after',
      expires: 2_000,
      lastRefreshedAt: 200,
    })
  })

  test('treats a partially parseable populated config as unknown membership', async () => {
    const storage = baseStorage()
    storage.accounts.push(
      {
        id: 'account-a',
        type: 'oauth',
        access: 'access-a',
        refresh: 'refresh-a',
        expires: 1_000,
      },
      {
        id: 'account-b',
        type: 'oauth',
        access: 'access-b',
        refresh: 'refresh-b',
        expires: 1_000,
      },
    )
    await saveAccounts(storage)
    await writeFile(
      accountPath,
      JSON.stringify({ version: 1, accounts: [{ id: 'account-a' }, {}] }),
      'utf8',
    )

    await saveAccountState(storage, accountPath, { accounts: true })

    const state = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    ) as { accounts?: Record<string, { refresh?: string }> }
    expect(Object.keys(state.accounts ?? {}).sort()).toEqual([
      'account-a',
      'account-b',
    ])
    expect(state.accounts?.['account-a']?.refresh).toBe('refresh-a')
    expect(state.accounts?.['account-b']?.refresh).toBe('refresh-b')
  })

  test('scoped saves preserve accounts when populated config membership is unknown', async () => {
    const storage = baseStorage()
    storage.accounts.push(
      {
        id: 'account-a',
        type: 'oauth',
        access: 'access-a',
        refresh: 'refresh-a',
        expires: 1_000,
      },
      {
        id: 'account-b',
        type: 'oauth',
        access: 'access-b',
        refresh: 'refresh-b',
        expires: 1_000,
      },
    )
    await saveAccounts(storage)
    await writeFile(
      accountPath,
      JSON.stringify({ version: 1, accounts: [{ id: 'account-a' }, {}] }),
      'utf8',
    )

    storage.accounts[0] = {
      ...storage.accounts[0],
      access: 'access-a-updated',
      refresh: 'refresh-a-updated',
    } as OAuthAccount
    await saveAccountState(storage, accountPath, { accounts: ['account-a'] })

    const state = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    ) as { accounts?: Record<string, { access?: string; refresh?: string }> }
    expect(state.accounts?.['account-a']).toMatchObject({
      access: 'access-a-updated',
      refresh: 'refresh-a-updated',
    })
    expect(state.accounts?.['account-b']).toMatchObject({
      access: 'access-b',
      refresh: 'refresh-b',
    })
  })

  test('a wholly unparseable populated config prunes nothing when storage is loaded from it', async () => {
    const seeded = baseStorage()
    seeded.accounts.push({
      id: 'account-a',
      type: 'oauth',
      access: 'access-a',
      refresh: 'refresh-a',
      expires: 1_000,
    })
    await saveAccounts(seeded)

    // Load drops the unparseable entries too, so the writer's own snapshot is
    // empty for the same reason membership is unknown. Pruning against it would
    // delete every credential.
    await writeFile(
      accountPath,
      JSON.stringify({ version: 1, accounts: [{}] }),
      'utf8',
    )
    const loaded = await loadAccounts(accountPath)
    expect(loaded?.accounts).toHaveLength(0)

    await saveAccountState(loaded!, accountPath, { accounts: true })

    const state = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    ) as { accounts?: Record<string, { refresh?: string }> }
    expect(state.accounts?.['account-a']?.refresh).toBe('refresh-a')
  })

  test('generic saves preserve a newer persisted main profile', async () => {
    const staleStorage = baseStorage()
    await saveAccounts(staleStorage)

    const hydratedStorage = await loadAccounts()
    expect(hydratedStorage).not.toBeNull()
    ;(hydratedStorage as AccountStorage).main = {
      type: 'opencode',
      provider: 'anthropic',
      profile: {
        tier: 'default_claude_max_20x',
        orgType: 'claude_max',
        checkedAt: 500,
        tokenFingerprint: tokenFingerprint('main-access'),
      },
    }
    await saveAccountState(hydratedStorage as AccountStorage, accountPath, {
      mainProfile: true,
    })

    await saveAccounts(staleStorage)

    expect((await loadAccounts())?.main?.profile).toEqual(
      hydratedStorage?.main?.profile,
    )
  })

  test('runtime state saves do not overwrite newer quota snapshots', async () => {
    const storage = baseStorage()
    storage.quota = {
      ...storage.quota,
      mainQuota: {
        five_hour: {
          usedPercent: 11,
          remainingPercent: 89,
          checkedAt: 500,
        },
      },
      mainQuotaCheckedAt: 500,
      mainQuotaToken: 'token-newer',
    }
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access-newer',
      refresh: 'refresh-newer',
      expires: 999,
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 500,
        },
      },
    })
    await saveAccounts(storage)

    const staleRuntimeView = await loadAccounts()
    expect(staleRuntimeView).not.toBeNull()
    ;(staleRuntimeView as AccountStorage).quota = {
      ...(staleRuntimeView as AccountStorage).quota,
      mainQuota: {
        five_hour: {
          usedPercent: 99,
          remainingPercent: 1,
          checkedAt: 100,
        },
      },
      mainQuotaCheckedAt: 100,
      mainQuotaToken: 'token-older',
    }
    ;(staleRuntimeView as AccountStorage).accounts[0] = {
      ...((staleRuntimeView as AccountStorage).accounts[0] as OAuthAccount),
      access: 'access-older',
      refresh: 'refresh-older',
      quota: {
        five_hour: {
          usedPercent: 99,
          remainingPercent: 1,
          checkedAt: 100,
        },
      },
      lastQuotaRefreshError: {
        checkedAt: 100,
        nextRetryAt: 200,
        retryCount: 1,
        message: 'stale failure',
      },
    }

    await saveAccountState(staleRuntimeView as AccountStorage, accountPath, {
      mainQuota: true,
      accounts: true,
    })

    const loaded = await loadAccounts()
    expect(loaded?.quota?.mainQuotaToken).toBe('token-newer')
    expect(loaded?.quota?.mainQuota?.five_hour?.usedPercent).toBe(11)
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.access).toBe('access-newer')
    expect(account.refresh).toBe('refresh-newer')
    expect(account.quota?.five_hour?.usedPercent).toBe(20)
    expect(account.lastQuotaRefreshError).toBeUndefined()
  })

  test('equal-time stale saves do not overwrite a harvested header snapshot', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 999,
      quota: {
        five_hour: {
          usedPercent: 25,
          remainingPercent: 75,
          checkedAt: 500,
        },
      },
    })
    await saveAccounts(storage)
    const harvestedView = await loadAccounts()
    const staleMarkUsedView = await loadAccounts()
    expect(harvestedView).not.toBeNull()
    expect(staleMarkUsedView).not.toBeNull()
    const harvested = expectOAuthAccount(harvestedView?.accounts[0])
    harvested.quota = {
      five_hour: {
        usedPercent: 78,
        remainingPercent: 22,
        checkedAt: 500,
      },
      source: 'headers',
      checkedAt: 500,
    }
    expectOAuthAccount(staleMarkUsedView?.accounts[0]).lastUsed = 501

    await saveAccountState(harvestedView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })
    await saveAccountState(staleMarkUsedView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.quota?.source).toBe('headers')
    expect(account.quota?.five_hour?.usedPercent).toBe(78)
    expect(account.lastUsed).toBe(501)
  })

  test('equal-time poll replaces headers and keeps scoped quota', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 999,
      quota: {
        five_hour: {
          usedPercent: 78,
          remainingPercent: 22,
          checkedAt: 500,
        },
        source: 'headers',
        checkedAt: 500,
      },
    })
    await saveAccounts(storage)
    const pollView = await loadAccounts()
    const pollAccount = expectOAuthAccount(pollView?.accounts[0])
    pollAccount.quota = {
      five_hour: {
        usedPercent: 79,
        remainingPercent: 21,
        checkedAt: 500,
      },
      scoped: [
        {
          id: 'weekly-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 40,
          remainingPercent: 60,
          checkedAt: 500,
        },
      ],
      source: 'poll',
      checkedAt: 500,
    }

    await saveAccountState(pollView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.quota?.source).toBe('poll')
    expect(account.quota?.scoped?.[0]?.id).toBe('weekly-fable')
  })

  test('equal-time header snapshot can replace another header snapshot', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 999,
      quota: {
        five_hour: {
          usedPercent: 78,
          remainingPercent: 22,
          checkedAt: 500,
        },
        source: 'headers',
        checkedAt: 500,
      },
    })
    await saveAccounts(storage)
    const nextHeaderView = await loadAccounts()
    const nextHeader = expectOAuthAccount(nextHeaderView?.accounts[0])
    nextHeader.quota = {
      five_hour: {
        usedPercent: 80,
        remainingPercent: 20,
        checkedAt: 500,
      },
      source: 'headers',
      checkedAt: 500,
    }

    await saveAccountState(nextHeaderView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })

    const loaded = await loadAccounts()
    expect(
      expectOAuthAccount(loaded?.accounts[0]).quota?.five_hour?.usedPercent,
    ).toBe(80)
  })

  test('main quota ordering ignores the legacy standalone timestamp', async () => {
    const storage = baseStorage()
    storage.quota = {
      ...storage.quota,
      mainQuota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 500,
        },
        source: 'poll',
        checkedAt: 500,
      },
      mainQuotaCheckedAt: 1,
      mainQuotaToken: 'same-token',
    }
    await saveAccounts(storage)

    const stale = await loadAccounts()
    expect(stale).not.toBeNull()
    ;(stale as AccountStorage).quota!.mainQuota = {
      five_hour: {
        usedPercent: 90,
        remainingPercent: 10,
        checkedAt: 100,
      },
      source: 'poll',
      checkedAt: 100,
    }
    ;(stale as AccountStorage).quota!.mainQuotaCheckedAt = 10_000
    await saveAccountState(stale as AccountStorage, accountPath, {
      mainQuota: true,
    })
    expect(
      (await loadAccounts())?.quota?.mainQuota?.five_hour?.usedPercent,
    ).toBe(20)

    const fresh = await loadAccounts()
    expect(fresh).not.toBeNull()
    ;(fresh as AccountStorage).quota!.mainQuota = {
      five_hour: {
        usedPercent: 30,
        remainingPercent: 70,
        checkedAt: 600,
      },
      source: 'poll',
      checkedAt: 600,
    }
    ;(fresh as AccountStorage).quota!.mainQuotaCheckedAt = 0
    await saveAccountState(fresh as AccountStorage, accountPath, {
      mainQuota: true,
    })
    expect(
      (await loadAccounts())?.quota?.mainQuota?.five_hour?.usedPercent,
    ).toBe(30)
  })

  test('main equal-time poll beats headers and source-less saves', async () => {
    const storage = baseStorage()
    storage.quota = {
      ...storage.quota,
      mainQuota: {
        five_hour: {
          usedPercent: 78,
          remainingPercent: 22,
          checkedAt: 500,
        },
        source: 'headers',
        checkedAt: 500,
      },
      mainQuotaCheckedAt: 500,
      mainQuotaToken: 'token',
    }
    await saveAccounts(storage)
    const pollView = await loadAccounts()
    const sourceLessView = await loadAccounts()
    expect(pollView).not.toBeNull()
    expect(sourceLessView).not.toBeNull()
    ;(pollView as AccountStorage).quota!.mainQuota = {
      five_hour: {
        usedPercent: 79,
        remainingPercent: 21,
        checkedAt: 500,
      },
      scoped: [
        {
          id: 'weekly-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 40,
          remainingPercent: 60,
          checkedAt: 500,
        },
      ],
      source: 'poll',
      checkedAt: 500,
    }
    ;(sourceLessView as AccountStorage).quota!.mainQuota = {
      five_hour: {
        usedPercent: 1,
        remainingPercent: 99,
        checkedAt: 500,
      },
      checkedAt: 500,
    }

    await saveAccountState(pollView as AccountStorage, accountPath, {
      mainQuota: true,
    })
    await saveAccountState(sourceLessView as AccountStorage, accountPath, {
      mainQuota: true,
    })

    const loaded = await loadAccounts()
    expect(loaded?.quota?.mainQuota?.source).toBe('poll')
    expect(loaded?.quota?.mainQuota?.scoped?.[0]?.id).toBe('weekly-fable')
  })

  test('fallback header persistence preserves newer poll-owned fields from disk', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 999,
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 600,
        },
        scoped: [
          {
            id: 'weekly-fable',
            title: 'Fable only',
            modelName: 'Fable',
            usedPercent: 40,
            remainingPercent: 60,
            checkedAt: 900,
          },
        ],
        extraUsage: {
          used: { amountMinor: 500, currency: 'USD', exponent: 2 },
          limit: { amountMinor: 1000, currency: 'USD', exponent: 2 },
          exhausted: false,
        },
        bindingWindow: 'weekly-fable',
        bindingWindowSource: 'poll',
        source: 'poll',
        checkedAt: 600,
      },
    })
    await saveAccounts(storage)
    const staleHeaderView = await loadAccounts()
    const account = expectOAuthAccount(staleHeaderView?.accounts[0])
    account.quota = {
      five_hour: {
        usedPercent: 78,
        remainingPercent: 22,
        checkedAt: 700,
      },
      seven_day: {
        usedPercent: 40,
        remainingPercent: 60,
        checkedAt: 700,
      },
      scoped: [],
      fallbackAdvised: true,
      bindingWindow: 'five_hour',
      bindingWindowSource: 'headers',
      source: 'headers',
      checkedAt: 700,
    }

    await saveAccountState(staleHeaderView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })

    const loaded = await loadAccounts()
    const merged = expectOAuthAccount(loaded?.accounts[0]).quota
    expect(merged?.five_hour?.usedPercent).toBe(78)
    expect(merged?.seven_day?.usedPercent).toBe(40)
    expect(merged?.scoped?.[0]?.id).toBe('weekly-fable')
    expect(merged?.extraUsage?.used.amountMinor).toBe(500)
    expect(merged?.bindingWindow).toBe('weekly-fable')
    expect(merged?.bindingWindowSource).toBe('poll')
  })

  test('main header persistence preserves newer poll-owned fields from disk', async () => {
    const storage = baseStorage()
    storage.quota = {
      ...storage.quota,
      mainQuota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 600,
        },
        scoped: [
          {
            id: 'weekly-fable',
            title: 'Fable only',
            modelName: 'Fable',
            usedPercent: 40,
            remainingPercent: 60,
            checkedAt: 900,
          },
        ],
        extraUsage: {
          used: { amountMinor: 500, currency: 'USD', exponent: 2 },
          limit: { amountMinor: 1000, currency: 'USD', exponent: 2 },
          exhausted: false,
        },
        bindingWindow: 'weekly-fable',
        bindingWindowSource: 'poll',
        source: 'poll',
        checkedAt: 600,
      },
      mainQuotaToken: 'same-token',
    }
    await saveAccounts(storage)
    const staleHeaderView = await loadAccounts()
    ;(staleHeaderView as AccountStorage).quota!.mainQuota = {
      five_hour: {
        usedPercent: 78,
        remainingPercent: 22,
        checkedAt: 700,
      },
      seven_day: {
        usedPercent: 40,
        remainingPercent: 60,
        checkedAt: 700,
      },
      scoped: [],
      source: 'headers',
      checkedAt: 700,
    }
    ;(staleHeaderView as AccountStorage).quota!.mainQuotaCheckedAt = 700

    await saveAccountState(staleHeaderView as AccountStorage, accountPath, {
      mainQuota: true,
    })

    const loaded = await loadAccounts()
    expect(loaded?.quota?.mainQuota?.five_hour?.usedPercent).toBe(78)
    expect(loaded?.quota?.mainQuota?.scoped?.[0]?.id).toBe('weekly-fable')
    expect(loaded?.quota?.mainQuota?.extraUsage?.used.amountMinor).toBe(500)
    expect(loaded?.quota?.mainQuota?.bindingWindow).toBe('weekly-fable')
  })

  test('fallback token rotation never rebinds the previous token quota', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1_000,
      lastRefreshedAt: 100,
      quota: {
        five_hour: {
          usedPercent: 80,
          remainingPercent: 20,
          checkedAt: 500,
        },
        source: 'poll',
        checkedAt: 500,
      },
    })
    await saveAccounts(storage)
    const rotatedView = await loadAccounts()
    const rotated = expectOAuthAccount(rotatedView?.accounts[0])
    rotated.access = 'new-access'
    rotated.refresh = 'new-refresh'
    rotated.lastRefreshedAt = 600
    rotated.quota = {
      five_hour: {
        usedPercent: 5,
        remainingPercent: 95,
        checkedAt: 100,
      },
      source: 'headers',
      checkedAt: 100,
    }
    expect(rotated.access).not.toBe('old-access')

    await saveAccountState(rotatedView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.access).toBe('new-access')
    expect(account.quota?.five_hour?.usedPercent).toBe(5)
    expect(account.quota?.source).toBe('headers')
  })

  test('runtime token updates drop source-less quota passthrough', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1_000,
      lastRefreshedAt: 100,
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 500,
        },
      },
    })
    await saveAccounts(storage)

    const refreshedRuntimeView = await loadAccounts()
    expect(refreshedRuntimeView).not.toBeNull()
    ;(refreshedRuntimeView as AccountStorage).accounts[0] = {
      ...((refreshedRuntimeView as AccountStorage).accounts[0] as OAuthAccount),
      access: 'new-access',
      refresh: 'new-refresh',
      expires: 2_000,
      lastRefreshedAt: 600,
      quota: {
        five_hour: {
          usedPercent: 99,
          remainingPercent: 1,
          checkedAt: 100,
        },
      },
    }
    expect(
      expectOAuthAccount((refreshedRuntimeView as AccountStorage).accounts[0])
        .access,
    ).not.toBe('old-access')

    await saveAccountState(
      refreshedRuntimeView as AccountStorage,
      accountPath,
      {
        accounts: true,
      },
    )

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.access).toBe('new-access')
    expect(account.refresh).toBe('new-refresh')
    expect(account.lastRefreshedAt).toBe(600)
    expect(account.quota).toBeUndefined()
  })

  test('malformed config file throws a clear error', async () => {
    await writeFile(accountPath, '{nope', 'utf8')
    await expect(loadAccounts()).rejects.toThrow('corrupt or unreadable')
  })

  test('refresh file lock allows only one holder', async () => {
    let now = 1_000
    const first = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
      now: () => now,
    })
    expect(first).not.toBeNull()

    await expect(
      acquireRefreshFileLock({
        name: 'test-refresh',
        ttlMs: 60_000,
        path: accountPath,
        now: () => now,
      }),
    ).resolves.toBeNull()

    await first?.release()
    const second = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
      now: () => now,
    })
    expect(second).not.toBeNull()
    await second?.release()

    const stale = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
      now: () => now,
    })
    expect(stale).not.toBeNull()
    now += 60_001
    const afterStale = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
      now: () => now,
    })
    expect(afterStale).not.toBeNull()
    await afterStale?.release()
  })

  test('refresh file lock stale-marker steal has a single winner under forced recreate race', async () => {
    const name = 'test-refresh-forced-stale-steal'
    const now = 100_000
    const ttlMs = 1_000
    await seedStaleRefreshLock(name, now, ttlMs)

    const cSawStaleMarker = deferred()
    const releaseCFromStaleMarker = deferred()
    const cClaimedMarker = deferred()
    const releaseCFromClaim = deferred()
    const cConfirmedStaleLock = deferred()
    const releaseCFromStaleLock = deferred()
    const aAcquiredMarker = deferred()
    const releaseAFromMarker = deferred()

    const contenderC = acquireRefreshFileLock({
      name,
      ttlMs,
      path: accountPath,
      now: () => now,
      onStep: async (step) => {
        if (step === 'stale-marker-stat') {
          cSawStaleMarker.resolve()
          await releaseCFromStaleMarker.promise
        }
        if (step === 'stale-marker-claimed') {
          cClaimedMarker.resolve()
          await releaseCFromClaim.promise
        }
        if (step === 'stale-lock-confirmed') {
          cConfirmedStaleLock.resolve()
          await releaseCFromStaleLock.promise
        }
      },
    })

    await withTimeout(cSawStaleMarker.promise, 1_000)

    const contenderA = acquireRefreshFileLock({
      name,
      ttlMs,
      path: accountPath,
      now: () => now,
      onStep: (step) => {
        if (step === 'eviction-marker-acquired') {
          aAcquiredMarker.resolve()
          return releaseAFromMarker.promise
        }
      },
    })

    await withTimeout(aAcquiredMarker.promise, 1_000)
    releaseCFromStaleMarker.resolve()
    await withTimeout(cClaimedMarker.promise, 1_000)
    releaseCFromClaim.resolve()
    await withTimeout(cConfirmedStaleLock.promise, 1_000)

    releaseAFromMarker.resolve()
    const aLock = await withTimeout(contenderA, 1_000)
    releaseCFromStaleLock.resolve()
    const cLock = await withTimeout(contenderC, 1_000)
    const winners = [aLock, cLock].filter(Boolean)

    await Promise.all(winners.map((lock) => lock?.release()))

    expect(winners).toHaveLength(1)
    expect(await countRefreshLockLeaks(name)).toBe(0)
  })

  test('refresh file lock stale-marker steal has a single winner across high-volume contention', async () => {
    const name = 'test-refresh-high-volume-stale-steal'
    const ttlMs = 1_000
    const contenders = 16
    const rounds = 1_000

    for (let round = 0; round < rounds; round++) {
      const now = 1_000_000 + round * 20_000
      await seedStaleRefreshLock(name, now, ttlMs)

      const locks = await Promise.all(
        Array.from({ length: contenders }, () =>
          acquireRefreshFileLock({
            name,
            ttlMs,
            path: accountPath,
            now: () => now,
          }),
        ),
      )
      const winners = locks.filter(Boolean)

      await Promise.all(winners.map((lock) => lock?.release()))

      expect(winners, `round ${round}`).toHaveLength(1)
      expect(await countRefreshLockLeaks(name), `round ${round}`).toBe(0)
    }
  }, 30_000)

  test('refresh file lock renews while the holder is alive', async () => {
    const first = await acquireRefreshFileLock({
      name: 'test-refresh-renew',
      ttlMs: 500,
      path: accountPath,
      renew: true,
      renewIntervalMs: 100,
    })
    expect(first).not.toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 700))
    await expect(
      acquireRefreshFileLock({
        name: 'test-refresh-renew',
        ttlMs: 500,
        path: accountPath,
      }),
    ).resolves.toBeNull()

    await first?.release()
    const second = await acquireRefreshFileLock({
      name: 'test-refresh-renew',
      ttlMs: 500,
      path: accountPath,
    })
    expect(second).not.toBeNull()
    await second?.release()
  })

  test('refresh file lock does not steal an initializing lock', async () => {
    const lockDir = `${accountPath}.test-refresh.lock`
    await mkdir(lockDir, { recursive: true })

    const contender = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
    })

    expect(contender).toBeNull()
    await expect(
      readFile(join(lockDir, 'owner.json'), 'utf8'),
    ).rejects.toThrow()
  })

  describe('stale-lock eviction race', () => {
    const N = 16
    const ROUNDS = 50

    test('concurrent stale-evictPath crash-recovery yields exactly one winner', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const lockPath = `${accountPath}.stale-crash.lock`
        const evictPath = `${lockPath}.evicting`

        // Seed a STALE evictPath (simulating crashed evictor)
        await mkdir(evictPath, { recursive: true })
        const staleDate = new Date(Date.now() - 60_000)
        await utimes(evictPath, staleDate, staleDate)

        // Seed a stale lock
        await writeFile(
          lockPath,
          `${JSON.stringify({ ownerId: 'dead-owner', expiresAt: Date.now() - 60_000 })}\n`,
          { encoding: 'utf8', mode: 0o600 },
        )

        const results = await Promise.all(
          Array.from({ length: N }, () =>
            acquireRefreshFileLock({
              name: 'stale-crash',
              ttlMs: 60_000,
              path: accountPath,
            }),
          ),
        )

        const winners = results.filter((r) => r !== null)
        expect(
          winners.length,
          `Round ${round}: expected 1 winner, got ${winners.length}`,
        ).toBe(1)

        // .evicting marker must be cleaned up
        await expect(stat(evictPath)).rejects.toThrow()

        await winners[0]!.release()
      }
    })

    test('fresh lock is never stolen by contenders', async () => {
      const now = 1_000
      const lockPath = `${accountPath}.fresh-lock.lock`

      await writeFile(
        lockPath,
        `${JSON.stringify({ ownerId: 'alive-owner', expiresAt: now + 120_000 })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          acquireRefreshFileLock({
            name: 'fresh-lock',
            ttlMs: 60_000,
            path: accountPath,
            now: () => now,
          }),
        ),
      )

      expect(results.every((r) => r === null)).toBe(true)

      await expect(stat(`${lockPath}.evicting`)).rejects.toThrow()
    })
  })

  test('preserves relay config when saving storage loaded by older code', async () => {
    await writeFile(
      accountPath,
      JSON.stringify(
        {
          ...baseStorage(),
          relay: {
            enabled: true,
            url: 'https://relay.example.workers.dev',
            token: 'relay-token',
            fallbackToDirect: true,
            transport: 'websocket',
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    const staleStorage = baseStorage()
    staleStorage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 123,
    })

    await saveAccounts(staleStorage)

    const raw = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(raw.relay).toEqual({
      enabled: true,
      url: 'https://relay.example.workers.dev',
      token: 'relay-token',
      fallbackToDirect: true,
      transport: 'websocket',
    })
    expect(raw.accounts).toHaveLength(1)
  })

  test('uses default fallback statuses when not configured', () => {
    expect(shouldFallbackStatus(429, null)).toBe(true)
    expect(shouldFallbackStatus(500, null)).toBe(false)
  })

  test('persists claudeCache enabled state and mode', async () => {
    await setCache1hPersistentEnabled(true)
    let saved = await loadAccounts()

    expect(saved?.claudeCache).toEqual({ enabled: true, mode: 'explicit' })
    expect(getCache1hPersistentMode(saved)).toBe('explicit')

    await setCache1hPersistentMode('hybrid')
    saved = await loadAccounts()

    expect(saved?.claudeCache).toEqual({ enabled: true, mode: 'hybrid' })
    expect(getCache1hPersistentMode(saved)).toBe('hybrid')

    await setCache1hPersistentEnabled(false)
    saved = await loadAccounts()

    expect(saved?.claudeCache).toEqual({ enabled: false, mode: 'hybrid' })
  })

  test('persists cacheKeep window', async () => {
    const storage = await setCacheKeepPersistentWindow(9, 23)
    expect(storage.cacheKeep).toEqual({
      enabled: true,
      always: false,
      startHour: 9,
      endHour: 23,
    })
    const disabled = await setCacheKeepPersistentEnabled(false)
    expect(disabled.cacheKeep).toEqual({
      enabled: false,
      always: false,
      startHour: 9,
      endHour: 23,
    })
  })

  test('persists cacheKeep always mode, preserves subagents, and clears the old window', async () => {
    await setCacheKeepSubagentsEnabled(true)
    const windowed = await setCacheKeepPersistentWindow(9, 23)
    expect(windowed.cacheKeep?.subagents).toBe(true)
    const storage = await setCacheKeepPersistentAlways()
    expect(storage.cacheKeep).toEqual({
      enabled: true,
      always: true,
      subagents: true,
    })
    expect((await loadAccounts())?.cacheKeep).toEqual({
      enabled: true,
      always: true,
      subagents: true,
    })
  })

  test('persists and reads cacheKeep subagents toggle', async () => {
    const storage = await setCacheKeepSubagentsEnabled(true)
    expect(storage.cacheKeep?.subagents).toBe(true)
    expect(isCacheKeepSubagentsEnabled(storage)).toBe(true)

    const disabled = await setCacheKeepSubagentsEnabled(false)
    expect(disabled.cacheKeep?.subagents).toBe(false)
    expect(isCacheKeepSubagentsEnabled(disabled)).toBe(false)

    expect(isCacheKeepSubagentsEnabled(null)).toBe(false)
  })

  test('persists claudeFast enabled state', async () => {
    await setFastModePersistentEnabled(true)
    let saved = await loadAccounts()

    expect(saved?.claudeFast).toEqual({ enabled: true })
    expect(isFastModePersistentlyEnabled(saved)).toBe(true)

    await setFastModePersistentEnabled(false)
    saved = await loadAccounts()

    expect(saved?.claudeFast).toEqual({ enabled: false })
    expect(isFastModePersistentlyEnabled(saved)).toBe(false)
  })

  test('returns null when neither config nor state file exists', async () => {
    await expect(loadAccounts()).resolves.toBeNull()
  })

  test('reads runtime state when config file is absent (no fallback accounts)', async () => {
    const statePath = getAccountStatePath(accountPath)
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        main: {
          refreshLeaseId: 'lease-abc',
          refreshLeaseUntil: 9_999_999_999_999,
          refreshLeaseTokenHash: 'hash-xyz',
          quota: {
            five_hour: {
              usedPercent: 33,
              remainingPercent: 67,
              checkedAt: 777,
            },
          },
          quotaCheckedAt: 777,
          quotaToken: 'token-state-only',
        },
      }),
      'utf8',
    )

    // Config file must NOT exist for this scenario.
    await expect(stat(accountPath)).rejects.toThrow()

    const loaded = await loadAccounts()
    expect(loaded).not.toBeNull()
    expect(loaded?.accounts).toEqual([])
    expect(loaded?.refresh?.mainRefreshLeaseId).toBe('lease-abc')
    expect(loaded?.refresh?.mainRefreshLeaseUntil).toBe(9_999_999_999_999)
    expect(loaded?.refresh?.mainRefreshLeaseTokenHash).toBe('hash-xyz')
    expect(loaded?.quota?.mainQuotaToken).toBe('token-state-only')
    expect(loaded?.quota?.mainQuota?.five_hour?.usedPercent).toBe(33)
  })

  test('lease written via saveAccountState is visible to loadAccounts without a config file', async () => {
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [],
      refresh: {
        mainRefreshLeaseId: 'lease-from-save',
        mainRefreshLeaseUntil: 9_999_999_999_999,
        mainRefreshLeaseTokenHash: 'token-hash-from-save',
      },
    }
    await saveAccountState(storage, accountPath, { mainRefresh: true })

    // saveAccountState must not have created the config file.
    await expect(stat(accountPath)).rejects.toThrow()

    const loaded = await loadAccounts()
    expect(loaded?.refresh?.mainRefreshLeaseId).toBe('lease-from-save')
    expect(loaded?.refresh?.mainRefreshLeaseTokenHash).toBe(
      'token-hash-from-save',
    )
  })
})

describe('buildRefreshOperationError', () => {
  test('uses Retry-After when available on 429', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited', '120')
    const result = buildRefreshOperationError({
      error,
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(result.nextRetryAt).toBe(1000000 + 120_000)
  })

  test('falls back to exponential backoff when no Retry-After', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited')
    const result = buildRefreshOperationError({
      error,
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(result.nextRetryAt).toBe(1000000 + 5 * 60_000)
  })

  test('captures the error status on the operation error', () => {
    const error = new ClaudeOAuthRefreshError(400, 'invalid_grant')
    const result = buildRefreshOperationError({
      error,
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(result.status).toBe(400)
  })

  test('captures duck-typed status when no ClaudeOAuthRefreshError', () => {
    const result = buildRefreshOperationError({
      error: { status: 429 },
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(result.status).toBe(429)
  })

  test('sets permanent true only for 400 invalid_grant', () => {
    const dead = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(400, 'invalid_grant'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(dead.permanent).toBe(true)
  })

  test('sets permanent false for retry-exhausted transient (no status)', () => {
    const exhausted = buildRefreshOperationError({
      error: new Error('Token refresh exhausted all retries'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(exhausted.permanent).toBe(false)
  })

  test('sets permanent false for a 429', () => {
    const rateLimited = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(rateLimited.permanent).toBe(false)
  })

  test('sets permanent false for a 400 that is NOT invalid_grant', () => {
    // The OAuth spec allows 400 invalid_client / invalid_request /
    // unsupported_grant_type — none of which re-login fixes. Only invalid_grant
    // means the refresh token itself is dead.
    const invalidClient = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(400, '{"error":"invalid_client"}'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(invalidClient.status).toBe(400)
    expect(invalidClient.permanent).toBe(false)
    // Explicit false must short-circuit isPermanentRefreshError before the
    // legacy status===400 fallback can wrongly flag it.
    expect(isPermanentRefreshError(invalidClient)).toBe(false)
  })

  test('sets permanent true for a 400 invalid_grant from the body JSON', () => {
    const dead = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(
        400,
        '{"error":"invalid_grant","error_description":"Refresh token expired"}',
      ),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(dead.permanent).toBe(true)
    expect(isPermanentRefreshError(dead)).toBe(true)
  })
})

describe('getFallbackReauthLabels', () => {
  test('reports enabled OAuth fallbacks with permanent refresh failures only', () => {
    const storage = baseStorage()
    storage.accounts.push(
      {
        id: 'expired',
        type: 'oauth',
        label: 'ufuk2',
        enabled: true,
        access: 'expired-access',
        refresh: 'expired-refresh',
        expires: 1,
        lastRefreshError: {
          message: 'invalid_grant: Refresh token expired',
          checkedAt: 1,
          nextRetryAt: 86_400_001,
          status: 400,
          permanent: true,
        },
      },
      {
        id: 'transient',
        type: 'oauth',
        label: 'temporary',
        enabled: true,
        access: 'transient-access',
        refresh: 'transient-refresh',
        expires: 1,
        lastRefreshError: {
          message: 'service unavailable',
          checkedAt: 1,
          nextRetryAt: 60_001,
          status: 503,
          permanent: false,
        },
      },
    )

    expect(getFallbackReauthLabels(storage)).toEqual(['ufuk2'])
  })
})

describe('isPermanentRefreshError', () => {
  test('400 (invalid_grant) → permanent (dead token, needs re-login)', () => {
    const error = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(400, 'invalid_grant'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(isPermanentRefreshError(error)).toBe(true)
  })

  test('429 (rate limited) → NOT permanent (transient, recovers)', () => {
    const error = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(isPermanentRefreshError(error)).toBe(false)
  })

  test('500 (server error) → NOT permanent (transient)', () => {
    const error = buildRefreshOperationError({
      error: { status: 500 },
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(isPermanentRefreshError(error)).toBe(false)
  })

  test('legacy error without status but 24h delay → permanent (heuristic)', () => {
    // Mirrors a dead token persisted before the status field existed: a
    // non-transient error gets NON_TRANSIENT_REFRESH_RETRY_DELAY_MS (24h).
    const checkedAt = 1000000
    const error = {
      message: 'invalid_grant',
      checkedAt,
      nextRetryAt: checkedAt + 24 * 60 * 60_000,
    }
    expect(isPermanentRefreshError(error)).toBe(true)
  })

  test('legacy error without status, short delay → NOT permanent', () => {
    const checkedAt = 1000000
    const error = {
      message: 'rate limited',
      checkedAt,
      nextRetryAt: checkedAt + 5 * 60_000,
    }
    expect(isPermanentRefreshError(error)).toBe(false)
  })

  test('retry-exhausted transient error → NOT permanent (no false re-login nag)', () => {
    // A network glitch that exhausts all retries throws a plain Error with NO
    // status. isTransientRefreshError classifies it non-transient (no status,
    // message is not "fetch failed"), so it gets the 24h backoff delay — but it
    // is NOT a dead token. Built through buildRefreshOperationError, the explicit
    // `permanent` flag must be false so it is not nagged for re-login.
    const error = buildRefreshOperationError({
      error: new Error('Token refresh exhausted all retries'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    // Sanity: it really did get the 24h non-transient delay (so the legacy
    // heuristic alone would have wrongly flagged it permanent).
    expect(error.nextRetryAt).toBe(1000000 + 24 * 60 * 60_000)
    expect(isPermanentRefreshError(error)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Duck-typed retryAfter propagation in buildRefreshOperationError
// ---------------------------------------------------------------------------
describe('buildRefreshOperationError retryAfter duck-typed propagation', () => {
  const now = 1_000_000

  test('reads .retryAfter from duck-typed error (no instanceof)', () => {
    const error: Error & { retryAfter?: number } = Object.assign(
      new Error('fail'),
      { retryAfter: 60 },
    )
    const result = buildRefreshOperationError({
      error,
      now,
      accountIdentity: 'test-account',
    })
    expect(result.nextRetryAt).toBe(now + 60_000)
  })

  test('ClaudeOAuthRefreshError retryAfter still works (regression)', () => {
    const result = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited', '120'),
      now,
      accountIdentity: 'test-account',
    })
    expect(result.nextRetryAt).toBe(now + 120_000)
  })
})

// ---------------------------------------------------------------------------
// fetchOAuthQuotaSnapshot attaches .status + .retryAfter (producer)
// ---------------------------------------------------------------------------
describe('fetchOAuthQuotaSnapshot duck-typed error producer', () => {
  test('parses weekly scoped model quota limits from OAuth usage payload', async () => {
    const fetchImpl = (async () => {
      return new Response(
        JSON.stringify({
          five_hour: {
            utilization: 12,
            resets_at: '2026-07-04T12:00:00Z',
          },
          seven_day: {
            utilization: 34,
            resets_at: '2026-07-08T09:00:00Z',
          },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 5,
              resets_at: '2026-07-08T09:00:00Z',
              scope: {
                model: { id: null, display_name: 'Fable' },
                surface: null,
              },
              is_active: false,
            },
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 7,
              resets_at: '2026-07-08T09:00:00Z',
              scope: {
                model: { id: 'claude/fable.5:promo', display_name: 'Fable' },
              },
            },
            { kind: 'daily', group: 'daily', percent: 10 },
          ],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const quota = await fetchOAuthQuotaSnapshot({
      accessToken: 't',
      fetchImpl,
      now: () => 1_000_000,
    })

    expect(quota.five_hour?.usedPercent).toBe(12)
    expect(quota.seven_day?.remainingPercent).toBe(66)
    expect(quota.scoped).toEqual([
      {
        id: 'claude-weekly-scoped-fable',
        title: 'Fable only',
        modelName: 'Fable',
        usedPercent: 5,
        remainingPercent: 95,
        resetsAt: '2026-07-08T09:00:00Z',
        checkedAt: 1_000_000,
      },
      {
        id: 'claude-weekly-scoped-claude-fable-5-promo',
        title: 'Fable only',
        modelId: 'claude/fable.5:promo',
        modelName: 'Fable',
        usedPercent: 7,
        remainingPercent: 93,
        resetsAt: '2026-07-08T09:00:00Z',
        checkedAt: 1_000_000,
      },
    ])
  })

  test('matches scoped model quota only for the matching model family', () => {
    const quota: OAuthQuotaSnapshot = {
      five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt: 1 },
      seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt: 1 },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100,
          remainingPercent: 0,
          checkedAt: 1,
        },
      ],
    }

    expect(getScopedQuotaWindowForModel(quota, 'claude-fable-5')?.title).toBe(
      'Fable only',
    )
    expect(getScopedQuotaWindowForModel(quota, 'claude-fable-5-1')?.title).toBe(
      'Fable only',
    )
    expect(quotaSnapshotModelScopeIsExhausted(quota, 'claude-fable-5')).toBe(
      true,
    )
    expect(quotaSnapshotModelScopeIsExhausted(quota, 'claude-fable-5-1')).toBe(
      true,
    )
    expect(quotaSnapshotPassesModelScope(quota, 'claude-opus-4-8')).toBe(true)
  })

  test('429 response → thrown error carries .status=429 + .retryAfter', async () => {
    let thrown: unknown = null
    const fetchImpl = (async () => {
      return new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '60' },
      })
    }) as unknown as typeof fetch
    try {
      await fetchOAuthQuotaSnapshot({
        accessToken: 't',
        fetchImpl,
        now: () => 1_000_000,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { status?: number }).status).toBe(429)
    expect((thrown as { retryAfter?: number }).retryAfter).toBe(60)
    // Verify isTransientQuotaError classifies it as transient
    const result = buildQuotaOperationError({ error: thrown, now: 1_000_000 })
    expect(result.nextRetryAt!).toBeLessThan(1_000_000 + 5 * 60_000)
  })

  test('500 response → thrown error carries .status=500', async () => {
    let thrown: unknown = null
    const fetchImpl = (async () => {
      return new Response('server error', { status: 500 })
    }) as unknown as typeof fetch
    try {
      await fetchOAuthQuotaSnapshot({
        accessToken: 't',
        fetchImpl,
        now: () => 1_000_000,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { status?: number }).status).toBe(500)
    // Verify isTransientQuotaError classifies it as transient
    const result = buildQuotaOperationError({ error: thrown, now: 1_000_000 })
    expect(result.nextRetryAt!).toBeLessThan(1_000_000 + 5 * 60_000)
  })

  test('401 response → thrown error carries .status=401 (NOT transient for quota)', async () => {
    let thrown: unknown = null
    const fetchImpl = (async () => {
      return new Response('unauthorized', { status: 401 })
    }) as unknown as typeof fetch
    try {
      await fetchOAuthQuotaSnapshot({
        accessToken: 't',
        fetchImpl,
        now: () => 1_000_000,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { status?: number }).status).toBe(401)
    const result = buildQuotaOperationError({ error: thrown, now: 1_000_000 })
    expect(result.nextRetryAt).toBe(1_000_000 + 5 * 60_000)
  })
})

// Non-finite utilization must fail closed rather than bypass quota policy.
describe('NaN quota utilization guards', () => {
  test('NaN remainingPercent blocks killswitch (fail-closed)', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    const quota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: Number.NaN,
        remainingPercent: Number.NaN,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: Date.now(),
      },
    }
    // A non-finite remaining quota is unknown evidence, not proof that the
    // account meets an enabled user floor.
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)
  })

  test('NaN remainingPercent blocks quota policy (fail-closed)', () => {
    const storage = baseStorage()
    const quota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: Number.NaN,
        remainingPercent: Number.NaN,
        checkedAt: Date.now(),
      },
    }
    expect(quotaSnapshotPassesPolicy(quota, storage)).toBe(false)
  })

  test('NaN threshold falls back to default', async () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: Number.NaN } as unknown as KillswitchThresholds,
    }
    // Save and reload so the threshold flows through normalizeKillswitchThresholds
    await saveAccounts(storage, accountPath)
    const loaded = await loadAccounts(accountPath)
    // The NaN should be normalized away — loadAccounts normalizes, so the
    // loaded storage should have the default thresholds
    // Test that killswitch works with default thresholds (not NaN)
    const quota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 96,
        remainingPercent: 4,
        checkedAt: Date.now(),
      },
    }
    // remainingPercent 4 < DEFAULT_KILLSWITCH_THRESHOLDS.five_hour (5) → blocked
    expect(killswitchPassesPolicy(quota, loaded)).toBe(false)
  })

  test('finite threshold is respected', async () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 3, seven_day: 5 },
    }
    await saveAccounts(storage, accountPath)
    const loaded = await loadAccounts(accountPath)
    const quotaBoth: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 96,
        remainingPercent: 4,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 80,
        remainingPercent: 20,
        checkedAt: Date.now(),
      },
    }
    // remainingPercent 4 >= threshold 3 (pass), remainingPercent 20 >= 5 (pass)
    expect(killswitchPassesPolicy(quotaBoth, loaded)).toBe(true)
  })

  test('missing decoded windows cannot satisfy enabled account floors', () => {
    // Invalid usage data can leave both decoded windows absent. This checks
    // admission of that missing reading, not the wire decoder itself.
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    // Neither standard window provides evidence for its configured floor.
    const quota: OAuthQuotaSnapshot = {
      five_hour: undefined,
      seven_day: undefined,
    }
    // Enabled floors require readings even when soft quota policy fails open.
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)

    storage.quota = { ...storage.quota, failClosedOnUnknownQuota: false }
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)
    storage.killswitch.main = { five_hour: 0, seven_day: 0 }
    expect(killswitchPassesPolicy(quota, storage)).toBe(true)
  })
})

// Provider UUIDs must not cross credential replacements.

describe('fallback UUID lineage fences', () => {
  test('does not use a persisted UUID from a replaced credential lineage', () => {
    const account: OAuthAccount = {
      id: 'fallback-1',
      type: 'oauth',
      refresh: 'refresh-a',
      authLineageId: 'lineage-a',
      anthropicAccountUuid: providerUuid('uuid-from-lineage-a'),
    }

    expect(fallbackAccountUuidForLineage(account, 'lineage-b')).toBeNull()
    expect(fallbackAccountUuidForLineage(account, 'lineage-a')).toBe(
      'uuid-from-lineage-a',
    )
  })

  test('does not persist a harvested UUID after the stored lineage was replaced', async () => {
    await saveAccounts(
      {
        ...baseStorage(),
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            refresh: 'refresh-b',
            authLineageId: 'lineage-b',
          },
        ],
      },
      accountPath,
    )

    expect(
      await persistFallbackQuotaHeaderPersistent(
        {
          accountId: 'fallback-1',
          authLineageId: 'lineage-a',
          anthropicAccountUuid: providerUuid('uuid-from-lineage-a'),
          quota: {
            source: 'headers',
            checkedAt: 1_000,
            five_hour: {
              usedPercent: 25,
              remainingPercent: 75,
              checkedAt: 1_000,
            },
          },
        },
        accountPath,
      ),
    ).toBe(false)

    expect(
      expectOAuthAccount((await loadAccounts(accountPath))?.accounts[0])
        .anthropicAccountUuid,
    ).toBeUndefined()
  })
})

// -- Persistent round-trip tests -----------------------------------------------

describe('global Claustrum mode', () => {
  test('defaults to local without config and does not infer custody from a tombstone', async () => {
    expect(await loadAccounts(accountPath)).toBeNull()
    expect(getClaustrumMode(await loadAccounts(accountPath))).toBe('local')
    expect(
      getClaustrumMode({
        ...baseStorage(),
        accounts: [
          {
            id: 'anthropic',
            type: 'oauth',
            access: '',
            refresh: 'claustrum-tombstone:v1:anthropic',
            expires: 0,
          },
        ],
      }),
    ).toBe('local')
  })

  test('drops legacy custody gates rather than using them as authority', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        ...baseStorage(),
        claustrum: { accounts: { old: { enabled: true } } },
      }),
    )
    const loaded = await loadAccounts(accountPath)
    expect(getClaustrumMode(loaded)).toBe('local')
    expect(loaded?.claustrum).toBeUndefined()
  })
  test('defaults invalid persisted global modes to local', async () => {
    for (const mode of ['vault', 42, null]) {
      await writeFile(
        accountPath,
        JSON.stringify({ ...baseStorage(), claustrum: { mode } }),
        'utf8',
      )
      const loaded = await loadAccounts(accountPath)
      expect(getClaustrumMode(loaded)).toBe('local')
      await saveAccounts(loaded!, accountPath)
      expect(
        JSON.parse(await readFile(accountPath, 'utf8')).claustrum?.mode,
      ).toBeUndefined()
    }
  })

  test('persists global mode in config and retains it through a state save', async () => {
    const storage = baseStorage()
    storage.claustrum = { mode: 'local' }
    storage.accounts.push({
      id: 'rotation',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1_000,
    })
    await saveAccounts(storage, accountPath)

    const staleStorage = (await loadAccounts(accountPath))!

    expect(await setClaustrumModePersistent('claustrum', accountPath)).toBe(
      'changed',
    )
    expect(await setClaustrumModePersistent('claustrum', accountPath)).toBe(
      'unchanged',
    )
    expect(getClaustrumMode(await loadAccounts(accountPath))).toBe('claustrum')

    const account = expectOAuthAccount(staleStorage.accounts[0])
    account.access = 'rotated-access'
    account.refresh = 'rotated-refresh'
    account.expires = 2_000
    await saveAccounts(staleStorage, accountPath)

    const config = JSON.parse(await readFile(accountPath, 'utf8'))
    const state = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(config.claustrum.mode).toBe('claustrum')
    expect(state.claustrum?.mode).toBeUndefined()
  })

  test('serializes a mode write with another config write without losing either field', async () => {
    const originalLevel = getLogLevel()
    try {
      await saveAccounts(baseStorage(), accountPath)

      await Promise.all([
        setClaustrumModePersistent('claustrum', accountPath),
        setLogLevelPersistent('debug', accountPath),
      ])

      const config = JSON.parse(await readFile(accountPath, 'utf8'))
      expect(config.claustrum.mode).toBe('claustrum')
      expect(config.logging.level).toBe('debug')
    } finally {
      setLogLevel(originalLevel)
    }
  })
})

// -- setLogLevelPersistent -----------------------------------------------------

// -- prime opt-in flag + scoped counters ------------------------------------

describe('isPrimePersistentlyEnabled', () => {
  test('defaults to false when prime is absent', () => {
    expect(isPrimePersistentlyEnabled(baseStorage())).toBe(false)
  })

  test('returns false when prime.enabled is not true', () => {
    expect(
      isPrimePersistentlyEnabled({
        ...baseStorage(),
        prime: { enabled: false },
      }),
    ).toBe(false)
  })

  test('returns true when prime.enabled is true', () => {
    expect(
      isPrimePersistentlyEnabled({
        ...baseStorage(),
        prime: { enabled: true },
      }),
    ).toBe(true)
  })

  test('survives save/load round-trip', async () => {
    const _storage = baseStorage()
    await setPrimePersistentEnabled(true, accountPath)
    const loaded = await loadAccounts()
    expect(isPrimePersistentlyEnabled(loaded)).toBe(true)
  })
})
