import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Generate only with the published writer, never the fixture implementation under test.
const installed = process.env.LEGACY_CORE_INSTALL
if (!installed)
  throw new Error(
    'Set LEGACY_CORE_INSTALL to the temporary npm install directory',
  )
const root = join(installed, 'node_modules/@cortexkit/anthropic-auth-core')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (manifest.version !== '1.23.0')
  throw new Error('Golden fixtures require published Core 1.23.0')
const writer = await import(pathToFileURL(join(root, 'dist/index.js')).href)
const cases = await Bun.file(new URL('./inputs.json', import.meta.url)).json()
for (const fixture of cases) {
  const config = new URL(`./${fixture.name}/config.json`, import.meta.url)
    .pathname
  const state = join(dirname(config), 'state.json')
  await mkdir(dirname(config), { recursive: true })
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = state
  await writer.saveAccounts(fixture.storage, config)
  if (fixture.scope)
    await writer.saveAccountState(fixture.storage, config, fixture.scope)
  console.log(
    `Generated ${fixture.name} with published Core ${manifest.version}`,
  )
}
await writeFile(
  new URL('./provenance.json', import.meta.url),
  `${JSON.stringify({ package: manifest.name, version: manifest.version, source: 'npm published package; synthetic migration/profile/Prime and empty Pi fixture inputs' }, null, 2)}\n`,
)
