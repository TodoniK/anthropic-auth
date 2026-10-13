import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeLegacyAccountFiles } from './legacy-account-fixture.ts'

const cases = await Bun.file(
  new URL('./fixtures/legacy-1x/inputs.json', import.meta.url),
).json()
for (const fixture of cases) {
  test(`legacy fixture writer matches published 1.23.0 bytes: ${fixture.name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-golden-'))
    const config = join(root, 'config.json')
    const state = join(root, 'state.json')
    try {
      await writeLegacyAccountFiles(
        config,
        fixture.config,
        state,
        fixture.state,
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
      await rm(root, { recursive: true, force: true })
    }
  })
}
