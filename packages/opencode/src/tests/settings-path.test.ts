import { expect, test } from 'bun:test'
import {
  buildCache1hStatusSummary,
  buildDumpStatusSummary,
  buildFastModeStatusSummary,
  buildLoggingStatusSummary,
} from '@cortexkit/anthropic-auth-core'

const selectedSettingsPaths = [
  '/tmp/anthropic-auth-pool.json',
  '/tmp/anthropic-auth-vault-settings.json',
  '/tmp/custom/native-settings.json',
]

test('each status builder shows the selected local, vault, or override settings path', () => {
  const builders = [
    (settingsPath: string) => buildCache1hStatusSummary({ settingsPath }),
    (settingsPath: string) => buildDumpStatusSummary({ settingsPath }),
    (settingsPath: string) => buildFastModeStatusSummary({ settingsPath }),
    (settingsPath: string) => buildLoggingStatusSummary({ settingsPath }),
  ]

  for (const build of builders) {
    for (const settingsPath of selectedSettingsPaths) {
      const summary = build(settingsPath)
      expect(summary).toContain(`- Persisted: ${settingsPath}`)
      expect(summary).not.toContain('~/.config/opencode/anthropic-auth.json')
    }
  }
})
