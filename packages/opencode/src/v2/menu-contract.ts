import type {
  NativeMenuCommandId,
  NativeMenuDispatch,
} from '@cortexkit/anthropic-auth-core'

/** Account, setting and session actions exposed through the server's menu RPC. */
export interface NativeMenuCapabilities {
  readonly dispatch: NativeMenuDispatch
  readonly readStatus: (
    command: Exclude<NativeMenuCommandId, 'start'>,
  ) => Promise<string>
  readonly forgetSession: (sessionID: string) => void
  readonly close: () => void
}
