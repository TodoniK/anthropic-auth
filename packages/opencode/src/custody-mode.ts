export class CustodyStateMismatchError extends Error {
  readonly code = 'custody_state_mismatch'
  constructor(
    readonly verdict: string,
    readonly dimensions: {
      mode: 'L' | 'C'
      main: 'R' | 'T' | 'X'
      fallbacks: 'R' | 'T' | 'M'
      evidence: 'V' | 'N'
    },
  ) {
    super(`custody state mismatch: ${verdict}`)
  }
  toJSON() {
    return {
      code: this.code,
      verdict: this.verdict,
      dimensions: this.dimensions,
    }
  }
}

/**
 * Check custody independently from account availability. Modes L/C mean local
 * and Claustrum vault. Main R/T/X means a real login, inert tombstone, or no
 * recognized OAuth marker; fallback R/T/M means local rows, token-free vault
 * inventory, or missing roster. Evidence V/N means verified or unavailable.
 * Local mode still requires completed migration and local account rows. Vault
 * mode requires enrollment authority, the host marker and a readable roster,
 * not an active primary. Each request separately authorizes its chosen account;
 * the marker enables the provider but cannot authenticate it. Ordinary OpenCode
 * API-key authentication remains outside this OAuth custody check.
 */
export function reconcileCustodyStartup(input: {
  mode: 'L' | 'C'
  main: 'R' | 'T' | 'X'
  fallbacks: 'R' | 'T' | 'M'
  evidence: 'V' | 'N'
  authority?: 'committed' | 'retired'
}): { verdict: 'LOCAL_SERVE' | 'CLAUSTRUM_SERVE' } {
  if (input.authority !== 'committed' && input.authority !== 'retired') {
    throw new CustodyStateMismatchError('MIGRATION_REQUIRED', input)
  }
  if (
    input.mode === 'L' &&
    input.main === 'T' &&
    input.fallbacks === 'R' &&
    input.evidence === 'V'
  ) {
    return { verdict: 'LOCAL_SERVE' }
  }
  if (
    input.mode === 'C' &&
    input.main === 'T' &&
    input.fallbacks === 'T' &&
    input.evidence === 'V'
  ) {
    return { verdict: 'CLAUSTRUM_SERVE' }
  }
  throw new CustodyStateMismatchError('FAIL_CLOSED', input)
}
