import type {
  CommandApplyRequest,
  CommandApplyResult,
  CommandDialogPayload,
  CommandInvocation,
  CommandMenu,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { NativeMenuCapabilities } from './menu-contract'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const session = (
  value: unknown,
): value is Record<string, unknown> & { sessionId: string } =>
  record(value) &&
  typeof value.sessionId === 'string' &&
  value.sessionId.length > 0
const apply = (
  value: unknown,
): value is CommandApplyRequest & { sessionId: string } => {
  if (
    !session(value) ||
    !record(value) ||
    value.command !== 'claude' ||
    typeof value.sectionId !== 'string' ||
    typeof value.actionId !== 'string'
  )
    return false
  if (value.itemId !== undefined && typeof value.itemId !== 'string')
    return false
  if (value.confirmed !== undefined && typeof value.confirmed !== 'boolean')
    return false
  if (
    value.values !== undefined &&
    (!record(value.values) ||
      !Object.values(value.values).every(
        (entry) =>
          entry === null ||
          typeof entry === 'string' ||
          typeof entry === 'boolean' ||
          (typeof entry === 'number' && Number.isFinite(entry)),
      ))
  )
    return false
  return true
}
function schema<T>(
  valid: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'cortexkit-native',
      validate: (value: unknown) =>
        valid(value)
          ? { value }
          : { issues: [{ message: 'Invalid native menu payload' }] },
    },
  }
}
// Validate the `claude` menu payload the plugin server sends over RPC: it must
// name the `claude` command and carry a menu with a title and a sections
// array, which the OpenCode 2 TUI in ./tui.ts reads to draw the menu.
const dialog = (value: unknown): value is CommandDialogPayload =>
  record(value) &&
  value.command === 'claude' &&
  record(value.menu) &&
  value.menu.command === 'claude' &&
  typeof value.menu.title === 'string' &&
  Array.isArray(value.menu.sections)
const result = (value: unknown): value is CommandApplyResult =>
  record(value) &&
  value.command === 'claude' &&
  typeof value.ok === 'boolean' &&
  typeof value.text === 'string' &&
  record(value.menu) &&
  Array.isArray(value.menu.sections)

export const NATIVE_MENU_RPC = {
  id: 'cortexkit-anthropic-native',
  methods: {
    open: { input: schema(session), output: schema(dialog) },
    apply: { input: schema(apply), output: schema(result) },
  },
  events: {
    opened: {
      schema: schema(
        (
          value: unknown,
        ): value is { sessionId: string; payload: CommandDialogPayload } =>
          session(value) && dialog(value.payload),
      ),
    },
    notification: {
      schema: schema(
        (
          value: unknown,
        ): value is {
          sessionId: string
          message: string
          kind: 'info' | 'warning' | 'error'
        } =>
          session(value) &&
          typeof value.message === 'string' &&
          ['info', 'warning', 'error'].includes(String(value.kind)),
      ),
    },
  },
} as const

/** OpenCode routes these RPC calls to the current project. No separate loopback server is started. */
export async function registerNativeMenu(
  ctx: Pick<Plugin.Context, 'rpc' | 'command' | 'event'>,
  command: CommandMenu,
  capabilities: NativeMenuCapabilities,
): Promise<Registration> {
  const abort = new AbortController()
  const invocation = (sessionId: string): CommandInvocation => ({
    sessionId,
    notify(message, kind = 'info') {
      void rpc.events
        .emit('notification', { sessionId, message, kind })
        .catch(() => {})
    },
  })
  const rpc = await ctx.rpc.register(NATIVE_MENU_RPC, {
    open: (input) => command.open(invocation(input.sessionId)),
    apply: (input) => command.apply(input, invocation(input.sessionId)),
  })
  let registered: Registration
  try {
    registered = await ctx.command.transform((editor) =>
      editor.add({
        name: 'claude',
        description: 'Native Claude accounts and settings',
        async execute(input) {
          const payload = await command.open(invocation(input.sessionID))
          await rpc.events.emit('opened', {
            sessionId: input.sessionID,
            payload,
          })
        },
      }),
    )
  } catch (error) {
    await rpc.dispose()
    throw error
  }
  const listener = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (event.type === 'session.deleted')
          capabilities.forgetSession(event.data.sessionID)
      }
    } catch {
      /* The OpenCode event subscription (ctx.event.subscribe) ends when dispose()
         aborts it or OpenCode closes it while unloading the plugin. Log nothing
         here: host events can carry conversation and tool content. */
    }
  })()
  let disposed = false
  return {
    async dispose() {
      if (disposed) return
      disposed = true
      abort.abort()
      await Promise.all([rpc.dispose(), registered.dispose(), listener])
    },
  }
}
