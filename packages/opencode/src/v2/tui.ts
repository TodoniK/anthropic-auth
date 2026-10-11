import type {
  CommandApplyRequest,
  CommandDialogPayload,
  KnobValues,
  MenuAction,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin as Tui } from '@opencode/plugin/tui'
import type { KeyEvent, PasteEvent } from '@opentui/core'
import { NATIVE_MENU_RPC } from './rpc'

/**
 * Shows the `claude` account menu in OpenCode 2 dialogs. The menu's sections,
 * items and actions come from the plugin server over NATIVE_MENU_RPC, built by
 * the same Core menu code that OpenCode 1 and Pi render, so every host shows
 * the same menu.
 */
export async function setupAnthropicTui(ctx: Tui.Context) {
  const rpc = ctx.client.rpc(NATIVE_MENU_RPC)
  let active = true
  let rendering = false
  const abort = new AbortController()
  const currentSession = () => {
    const route = ctx.ui.router.current()
    return route.type === 'session' ? route.sessionID : undefined
  }
  function hiddenEntry(title: string): Promise<string | undefined> {
    // OC2's built-in prompt has no masked-input option. Collect protected
    // values over an alert (no text field), swallowing input before it can
    // reach the conversation prompt or keyboard commands. Never render it.
    return new Promise((resolve) => {
      let value = ''
      let finished = false
      const release = ctx.keymap.mode.push('cortexkit-protected-entry')
      const finish = (accept: boolean, clear = true) => {
        if (finished) return
        finished = true
        ctx.renderer.keyInput.off('keypress', key)
        ctx.renderer.keyInput.off('paste', paste)
        abort.signal.removeEventListener('abort', cancel)
        release()
        const result = accept ? value : undefined
        value = ''
        if (clear) ctx.ui.dialog.clear()
        resolve(result)
      }
      const cancel = () => finish(false)
      const key = (event: KeyEvent) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.name === 'escape' || (event.ctrl && event.name === 'c'))
          return finish(false)
        if (event.name === 'return' || event.name === 'enter')
          return finish(true)
        if (event.name === 'backspace') {
          value = Array.from(value).slice(0, -1).join('')
          return
        }
        if (
          !event.ctrl &&
          !event.meta &&
          !event.option &&
          Array.from(event.sequence).every(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          )
        )
          value = (value + event.sequence).slice(0, 4096)
      }
      const paste = (event: PasteEvent) => {
        event.preventDefault()
        event.stopPropagation()
        value = (
          value +
          Array.from(new TextDecoder().decode(event.bytes))
            .filter(
              (character) =>
                character.charCodeAt(0) >= 32 &&
                character.charCodeAt(0) !== 127,
            )
            .join('')
        ).slice(0, 4096)
      }
      ctx.renderer.keyInput.prependListener('keypress', key)
      ctx.renderer.keyInput.prependListener('paste', paste)
      abort.signal.addEventListener('abort', cancel, { once: true })
      void ctx.ui.dialog
        .alert({
          title,
          message:
            'Type or paste the value. Input is hidden. Enter accepts; Escape cancels.',
        })
        .then(
          () => finish(false, false),
          () => finish(false, false),
        )
      if (abort.signal.aborted) cancel()
    })
  }
  async function valuesFor(
    action: MenuAction,
  ): Promise<KnobValues | undefined> {
    const values: Record<string, string | number | boolean | null> = {}
    for (const knob of action.knobs) {
      if (!active) return undefined
      if (knob.kind === 'choice') {
        const value = await ctx.ui.dialog.select({
          title: knob.label,
          options: knob.choices.map((choice) => ({
            title: choice.label,
            value: choice.value,
          })),
          current: knob.value,
        })
        if (value === undefined) return undefined
        values[knob.id] = value
      } else if (knob.kind === 'toggle') {
        const value = await ctx.ui.dialog.select({
          title: knob.label,
          options: [
            { title: 'On', value: true },
            { title: 'Off', value: false },
          ],
          current: knob.value,
        })
        if (value === undefined) return undefined
        values[knob.id] = value
      } else {
        const value =
          knob.kind === 'text' && knob.masked
            ? await hiddenEntry(knob.label)
            : await ctx.ui.dialog.prompt({
                title: knob.label,
                value:
                  knob.value === undefined ? undefined : String(knob.value),
                placeholder:
                  knob.kind === 'text' ? knob.placeholder : undefined,
              })
        if (value === undefined) return undefined
        values[knob.id] =
          value === '' && !knob.required
            ? null
            : knob.kind === 'number'
              ? Number(value)
              : value
      }
    }
    return values
  }
  async function render(sessionId: string, initial: CommandDialogPayload) {
    if (!active || rendering || currentSession() !== sessionId) return
    rendering = true
    let payload = initial
    try {
      while (active && currentSession() === sessionId) {
        const section = await ctx.ui.dialog.select({
          title: payload.menu.title,
          options: payload.menu.sections.map((entry) => ({
            title: entry.title,
            description: entry.lines.join('\n'),
            value: entry,
          })),
        })
        if (!section || !active || currentSession() !== sessionId) return
        const actions = [
          ...section.actions.map((action) => ({ action, itemId: undefined })),
          ...section.items.flatMap((item) =>
            item.actions.map((action) => ({ action, itemId: item.id })),
          ),
        ]
        const selected = await ctx.ui.dialog.select({
          title: section.title,
          options: actions.map((entry) => ({
            title: entry.action.label,
            description: entry.action.description,
            value: entry,
          })),
        })
        if (!selected) continue
        const values = await valuesFor(selected.action)
        if (!values || !active || currentSession() !== sessionId) return
        const confirmed = selected.action.confirm
          ? await ctx.ui.dialog.confirm({
              title: selected.action.label,
              message: selected.action.confirm.message,
            })
          : undefined
        if (selected.action.confirm && confirmed !== true) continue
        if (!active || currentSession() !== sessionId) return
        const request: CommandApplyRequest & { sessionId: string } = {
          command: 'claude',
          sectionId: section.id,
          itemId: selected.itemId,
          actionId: selected.action.id,
          sessionId,
          values,
          confirmed,
        }
        const result = await rpc.apply(request, {
          signal: abort.signal,
          location: ctx.location,
        })
        if (!active || currentSession() !== sessionId) return
        await ctx.ui.dialog.alert({
          title: result.ok ? 'Claude' : 'Claude action refused',
          message: result.text,
        })
        payload = { command: result.command, menu: result.menu }
      }
    } finally {
      rendering = false
    }
  }
  const remove = rpc.events.on(
    'opened',
    (event) => render(event.data.sessionId, event.data.payload),
    { signal: abort.signal },
  )
  const removeNotifications = rpc.events.on(
    'notification',
    (event) => {
      if (active && currentSession() === event.data.sessionId)
        ctx.ui.toast.show({
          title: 'Claude',
          sessionID: event.data.sessionId,
          message: event.data.message,
          variant: event.data.kind,
        })
    },
    { signal: abort.signal },
  )
  ctx.keymap.layer(() => ({
    commands: [
      {
        id: 'cortexkit.claude',
        title: 'Claude',
        group: 'Claude',
        palette: true,
        slash: { name: 'claude' },
        async run() {
          const sessionId = currentSession()
          if (!sessionId) {
            await ctx.ui.dialog.alert({
              title: 'Claude',
              message: 'Open a session before using the Claude menu.',
            })
            return
          }
          const payload = await rpc.open(
            { sessionId },
            { signal: abort.signal, location: ctx.location },
          )
          await render(sessionId, payload)
        },
      },
    ],
  }))
  return () => {
    active = false
    abort.abort()
    remove()
    removeNotifications()
  }
}

export default { id: 'cortexkit-anthropic-auth', setup: setupAnthropicTui }
