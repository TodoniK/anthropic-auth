import type {
  NativeMenuCommandId,
  NativeMenuDispatch,
} from '@cortexkit/anthropic-auth-core'
import type { SidebarState } from '../sidebar-state'

/** Account, setting and session actions exposed through the server's menu RPC. */
export interface NativeMenuCapabilities {
  readonly dispatch: NativeMenuDispatch
  readonly readStatus: (
    command: Exclude<NativeMenuCommandId, 'start'>,
  ) => Promise<string>
  /** The quota sidebar's state for one session; carries no secrets. */
  readonly readSidebar: (sessionID: string) => Promise<SidebarState>
  readonly forgetSession: (sessionID: string) => void
  readonly close: () => void
}
