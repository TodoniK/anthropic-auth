import { isCancel, text } from '@clack/prompts'
import {
  authorize,
  exchange,
  resolveClaudeCodeIdentity,
} from '@cortexkit/anthropic-auth-core'
import type { NativeOfflineLogin } from './native-local'
import type { HarnessKind } from './types'

interface NativeLoginDependencies {
  authorize: typeof authorize
  exchange: typeof exchange
  resolveClaudeCodeIdentity: typeof resolveClaudeCodeIdentity
  text: typeof text
  isCancel: typeof isCancel
  print: (line: string) => void
}

export async function loginNativeOffline(
  host: HarnessKind,
  dependencies: NativeLoginDependencies = {
    authorize,
    exchange,
    resolveClaudeCodeIdentity,
    text,
    isCancel,
    print: console.log,
  },
): Promise<NativeOfflineLogin> {
  const authorization = await dependencies.authorize('max')
  dependencies.print(`Claude sign-in for ${host === 'pi' ? 'Pi' : 'OpenCode'}`)
  dependencies.print(authorization.url)
  const code = await dependencies.text({
    message: 'Paste the Claude callback URL or authorization code:',
  })
  if (dependencies.isCancel(code)) throw new Error('Claude sign-in cancelled')
  const result = await dependencies.exchange(
    code,
    authorization.verifier,
    authorization.redirectUri,
    authorization.state,
  )
  if (result.type !== 'success') throw new Error('Claude sign-in failed')
  const identity = await dependencies.resolveClaudeCodeIdentity(
    result.access,
    undefined,
    undefined,
  )
  if (!identity.accountUuid)
    throw new Error('Claude sign-in did not establish an account UUID')
  return {
    accountIdentity: identity.accountUuid,
    credential: {
      type: 'oauth',
      access: result.access,
      refresh: result.refresh,
      expires: result.expires,
    },
  }
}
