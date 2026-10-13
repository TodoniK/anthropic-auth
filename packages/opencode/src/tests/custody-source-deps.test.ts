import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const productionFiles = [
  '../custody-mode.ts',
  '../custody-dimensions.ts',
  '../../../core/src/native-custody.ts',
  '../../../core/src/native-vault-runtime.ts',
  '../../../core/src/claustrum.ts',
  '../../../core/src/claustrum-enrollment.ts',
  '../../../core/src/commands/account.ts',
  '../index.ts',
]

const forbidden = [
  /child_process/u,
  /Bun\.spawn/u,
  /Bun\.\$/u,
  /execa/u,
  /ck auth/u,
  /credential\.get(?!_scoped)\b/u,
  /CLAUSTRUM_OPENCODE_HANDLES/u,
]

describe('custody production dependencies', () => {
  test('does not invoke vault CLIs or spawn processes', async () => {
    for (const relativePath of productionFiles) {
      const source = await readFile(join(import.meta.dir, relativePath), 'utf8')
      for (const pattern of forbidden)
        expect(
          source,
          `${relativePath} must not contain ${pattern}`,
        ).not.toMatch(pattern)
    }
  })
})
