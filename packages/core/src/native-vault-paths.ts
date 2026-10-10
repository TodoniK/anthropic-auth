import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import type { NativePoolPaths } from './pool-paths.ts'

/** Vault files have no migration journal: enrollment alone authorizes their use. */
export interface NativeVaultPaths {
  config: string
  state: string
  runtime: string
  roster: string
  routing: string
  storageId: string
}

function sibling(path: string, expected: string, name: string, suffix: string) {
  return basename(path) === expected
    ? join(dirname(path), name)
    : path.replace(/(?:\.json)?$/, `.${suffix}.json`)
}

/** Keep vault settings, metadata and affinity outside every local recovery file. */
export function nativeVaultPaths(local: NativePoolPaths): NativeVaultPaths {
  const config = sibling(
    local.legacyConfig,
    'anthropic-auth.json',
    'anthropic-auth-vault-settings.json',
    'vault-settings',
  )
  const state = sibling(
    local.legacyState,
    'anthropic-auth-state.json',
    'anthropic-auth-vault-store-state.json',
    'vault-store',
  )
  const runtime = sibling(
    local.legacyState,
    'anthropic-auth-state.json',
    'anthropic-auth-vault-state.json',
    'vault-native',
  )
  const roster = sibling(
    local.legacyState,
    'anthropic-auth-state.json',
    'anthropic-auth-vault-roster.json',
    'vault-roster',
  )
  const routing = sibling(
    local.legacyState,
    'anthropic-auth-state.json',
    'anthropic-auth-vault-routing-state.json',
    'vault-routing',
  )
  const destinations = [config, state, runtime, roster, routing]
  const localFiles = [
    local.legacyConfig,
    local.legacyState,
    local.config,
    local.state,
    local.runtime,
    local.journal,
    local.roster,
  ]
  if (
    new Set([...localFiles, ...destinations]).size !==
    localFiles.length + destinations.length
  )
    throw new Error('Vault storage overlaps local account storage')
  return {
    config,
    state,
    runtime,
    roster,
    routing,
    storageId: createHash('sha256')
      .update(JSON.stringify(['anthropic-vault', config, state]))
      .digest('hex'),
  }
}
