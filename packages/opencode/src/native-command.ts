import {
  type CommandApplyRequest,
  type CommandApplyResult,
  type CommandDialogPayload,
  type CommandMenu,
  createNativeUi,
  disconnectNativeVaultForHost,
  type NativeUiOptions,
  readNativeEnrollmentMode,
} from '@cortexkit/anthropic-auth-core'

export interface NativeCommand {
  readonly menu: CommandMenu
  readonly open: (sessionId: string) => Promise<CommandDialogPayload>
  readonly apply: (request: CommandApplyRequest) => Promise<CommandApplyResult>
}

/**
 * Menu callbacks from the OpenCode host. The custody reader and the vault
 * disconnect may be injected; when left out, OpenCode's own enrollment record
 * is read for every menu open and apply (there is no local fallback), and
 * disconnect ends OpenCode's enrollment through the shared Core helper, which
 * never changes OpenCode's own stored sign-in.
 */
export type NativeCommandOptions = Omit<
  NativeUiOptions,
  'readMode' | 'disconnectVault'
> & {
  readonly readMode?: NativeUiOptions['readMode']
  readonly disconnectVault?: NativeUiOptions['disconnectVault']
}

function session(sessionId: string | undefined): string {
  if (!sessionId?.trim()) throw new TypeError('sessionId is required')
  return sessionId
}

/** Build and execute the Claude menu using account, status and session callbacks supplied by the host. */
export function createNativeCommand(
  options: NativeCommandOptions,
): NativeCommand {
  if (options.host !== 'opencode')
    throw new TypeError('OpenCode host is required')
  const menu = createNativeUi({
    ...options,
    readMode:
      options.readMode ??
      (() => readNativeEnrollmentMode('opencode', process.env)),
    disconnectVault:
      options.disconnectVault ??
      (() =>
        disconnectNativeVaultForHost({ host: 'opencode', env: process.env })),
  })
  return {
    menu,
    open(sessionId) {
      return menu.open({ sessionId: session(sessionId), notify() {} })
    },
    apply(request) {
      return menu.apply(request, {
        sessionId: session(request.sessionId),
        notify() {},
      })
    },
  }
}
