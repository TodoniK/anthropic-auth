import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountStorage } from './legacy-account-fixture.ts'
import {
  type AccountStateSaveScope,
  saveAccountState,
  saveAccounts,
} from './legacy-account-fixture.ts'

const cases = await Bun.file(
  new URL('./fixtures/legacy-1x/inputs.json', import.meta.url),
).json()
for (const fixture of cases) {
  test(`legacy fixture writer matches published 1.23.0 bytes: ${fixture.name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-golden-'))
    const prior = process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
    const config = join(root, 'config.json')
    const state = join(root, 'state.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = state
    try {
      await saveAccounts(fixture.storage as AccountStorage, config)
      if (fixture.scope)
        await saveAccountState(
          fixture.storage as AccountStorage,
          config,
          fixture.scope as AccountStateSaveScope,
        )
      expect(await readFile(config, 'utf8')).toBe(
        await Bun.file(
          new URL(
            `./fixtures/legacy-1x/${fixture.name}/config.json`,
            import.meta.url,
          ),
        ).text(),
      )
      expect(await readFile(state, 'utf8')).toBe(
        await Bun.file(
          new URL(
            `./fixtures/legacy-1x/${fixture.name}/state.json`,
            import.meta.url,
          ),
        ).text(),
      )
    } finally {
      if (prior === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
      else process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = prior
      await rm(root, { recursive: true, force: true })
    }
  })
}
