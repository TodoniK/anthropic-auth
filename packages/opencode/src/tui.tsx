/** @jsxImportSource @opentui/solid */

import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from '@opencode-ai/plugin/tui'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { createRpcClient } from './rpc/rpc-client.js'
import { getRpcDir } from './rpc/rpc-dir.js'
import {
  DEFAULT_SIDEBAR_STATE,
  getSidebarState,
  type SidebarState,
} from './sidebar-state.js'
import {
  AccountBlock,
  ClaudeSidebar,
  createSidebarController,
  type SidebarController,
} from './tui/claude-sidebar.js'
import {
  openCommandDialog,
  openNativeMenuDialog,
} from './tui/command-dialogs.js'
import {
  computeEffectiveOrder,
  DEFAULT_SLOT_ORDER,
  PLUGIN_KEY,
  readTuiPreferencesFile,
  resolveAnthropicAuthPrefs,
} from './tui-preferences.js'

const RPC_POLL_MS = 500
let rpcPollStarted = false

const ID = 'cortexkit.anthropic-auth'

// --- Quota dialog content ---------------------------------------------------

// Renders the same rich visualization as the sidebar (account blocks with
// quota bars + pacing) so the modal matches the sidebar look.
function QuotaDialogContent(props: {
  api: TuiPluginApi
  controller: SidebarController
}) {
  const prefs = props.controller.prefs
  const [state, setState] = createSignal<SidebarState>(DEFAULT_SIDEBAR_STATE)
  let lastUpdated = 0
  async function refresh() {
    const next = await readStateFromFile()
    if (next.lastUpdated !== lastUpdated) {
      lastUpdated = next.lastUpdated
      setState(next)
    }
  }
  createEffect(() => {
    const timer = setInterval(refresh, prefs().pollMs)
    onCleanup(() => clearInterval(timer))
  })
  setTimeout(refresh, 0)
  const theme = () => props.api.theme.current
  const enabledFallbacks = () =>
    (state().fallbacks ?? []).filter(
      (f) => f.enabled || (f.custodyState && f.custodyState !== 'off'),
    )
  return (
    <box flexDirection='column' padding={2} width='100%' alignItems='center'>
      <box flexDirection='column' width={58}>
        <box width='100%' justifyContent='center' marginBottom={1}>
          <text fg={theme().text}>
            <b>Quota</b>
          </text>
        </box>
        <AccountBlock
          theme={theme()}
          appearance={prefs().appearance}
          name='main'
          quota={state().main?.quota}
          active={state().activeId === 'main'}
          pacingEnabled={prefs().sections.pacing}
          tierLabel={state().main?.tierLabel}
          stateLine={state().main?.stateLine}
          quotaDated={state().main?.quotaDated}
        />
        <Show when={prefs().sections.fallbackAccounts}>
          <For each={enabledFallbacks()}>
            {(fb) => (
              <AccountBlock
                theme={theme()}
                appearance={prefs().appearance}
                name={fb.label ?? fb.id}
                quota={fb.quota}
                active={state().activeId === fb.id}
                pacingEnabled={prefs().sections.pacing}
                tierLabel={fb.tierLabel}
                needsReauth={fb.needsReauth}
                vaultReauth={fb.vaultReauth}
                stateLine={fb.stateLine}
                quotaDated={fb.quotaDated}
                marginTop={1}
              />
            )}
          </For>
        </Show>
      </box>
    </box>
  )
}

// --- State plumbing ---------------------------------------------------------

async function readStateFromFile(): Promise<SidebarState> {
  return getSidebarState()
}

function QuotaSidebar(props: {
  api: TuiPluginApi
  controller: SidebarController
  sessionId: string
}) {
  const prefs = props.controller.prefs
  const [state, setState] = createSignal<SidebarState>(DEFAULT_SIDEBAR_STATE)
  let lastUpdated = 0
  let debounce: ReturnType<typeof setTimeout> | null = null

  async function refresh() {
    const next = await readStateFromFile()
    if (next.lastUpdated !== lastUpdated) {
      lastUpdated = next.lastUpdated
      setState(next)
    }
  }

  function scheduleRefresh() {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      void refresh()
    }, prefs().refreshDebounceMs)
  }

  // Background poller (server and TUI run as separate module instances, so we
  // sync through the state file) plus event-driven refreshes for low latency.
  // The interval rebuilds whenever pollMs changes.
  createEffect(() => {
    const timer = setInterval(refresh, prefs().pollMs)
    onCleanup(() => clearInterval(timer))
  })
  const unsubs = [
    props.api.event.on('session.updated', scheduleRefresh),
    props.api.event.on('message.updated', scheduleRefresh),
  ]
  setTimeout(refresh, 300)

  onCleanup(() => {
    if (debounce) clearTimeout(debounce)
    for (const u of unsubs) u()
  })
  return (
    <ClaudeSidebar
      state={state}
      theme={() => props.api.theme.current}
      controller={props.controller}
      sessionId={props.sessionId}
    />
  )
}

const tui: TuiPlugin = async (api) => {
  const root = await readTuiPreferencesFile()
  const controller = createSidebarController(resolveAnthropicAuthPrefs(root))
  api.slots.register({
    order: computeEffectiveOrder(root, PLUGIN_KEY, DEFAULT_SLOT_ORDER),
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return (
          <QuotaSidebar
            api={api}
            controller={controller}
            sessionId={props.session_id}
          />
        )
      },
    },
  })

  if (!rpcPollStarted) {
    rpcPollStarted = true
    const rpcClient = createRpcClient(
      getRpcDir(api.state.path.directory ?? ''),
      process.pid,
    )
    const lastNotificationIdBySession = new Map<string, number>()
    let rpcInFlight = false
    const currentSessionId = () => {
      const current = (api.route as { current?: unknown }).current
      const resolved =
        typeof current === 'function' ? (current as () => unknown)() : current
      return (resolved as { params?: { sessionID?: string } } | undefined)
        ?.params?.sessionID
    }
    setInterval(() => {
      if (rpcInFlight) return
      const sessionId = currentSessionId()
      if (!sessionId) return
      rpcInFlight = true
      void rpcClient
        .pending(lastNotificationIdBySession.get(sessionId) ?? 0, sessionId)
        .then((messages) => {
          // A route change while draining must not open a different session's
          // dialog or acknowledge notices that were never displayed.
          if (currentSessionId() !== sessionId) return
          for (const message of [...messages].sort((a, b) => a.id - b.id)) {
            if (message.sessionId !== sessionId) continue
            lastNotificationIdBySession.set(
              sessionId,
              Math.max(
                lastNotificationIdBySession.get(sessionId) ?? 0,
                message.id,
              ),
            )
            if (message.type === 'open-menu') {
              openNativeMenuDialog(
                api,
                message.payload,
                (request) => {
                  if (currentSessionId() !== sessionId)
                    return Promise.reject(new Error('Menu session changed'))
                  return rpcClient.applyMenu({ ...request, sessionId })
                },
                () => currentSessionId() === sessionId,
              )
              continue
            }
            if (message.payload.command === 'claude-quota') {
              api.ui.dialog.setSize('xlarge')
              api.ui.dialog.replace(() => (
                <QuotaDialogContent api={api} controller={controller} />
              ))
              continue
            }
            openCommandDialog(api, message.payload, (command, args) =>
              rpcClient.apply({ command, arguments: args, sessionId }),
            )
          }
        })
        .catch(() => {})
        .finally(() => {
          rpcInFlight = false
        })
    }, RPC_POLL_MS)
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
