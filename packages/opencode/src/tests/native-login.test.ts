import { expect, test } from 'bun:test'
import { isCancel } from '@clack/prompts'
import type { ProviderAccountUuid } from '@cortexkit/anthropic-auth-core'
import { loginNativeOffline } from '../setup/native-login.ts'

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} offline sign-in prints the complete URL on its own unboxed line`, async () => {
    const lines: string[] = []
    const url = `https://claude.ai/oauth/authorize?state=${'a'.repeat(200)}`
    const accountIdentity = '11111111-2222-4333-8444-555555555555'
    await loginNativeOffline(host, {
      authorize: async () => ({
        url,
        verifier: 'synthetic',
        redirectUri: 'https://localhost',
        state: 'synthetic',
      }),
      text: async () => 'synthetic-code',
      isCancel,
      exchange: async () => ({
        type: 'success',
        access: 'synthetic',
        refresh: 'synthetic',
        expires: 1,
      }),
      resolveClaudeCodeIdentity: async () => ({
        accountUuid: accountIdentity as ProviderAccountUuid,
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
      }),
      print: (line: string) => {
        lines.push(line)
      },
    })
    expect(lines).toEqual([
      `Claude sign-in for ${host === 'pi' ? 'Pi' : 'OpenCode'}`,
      url,
    ])
  })
}
