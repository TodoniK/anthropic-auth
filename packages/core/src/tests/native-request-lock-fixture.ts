import type { NativeLockEvent } from '../native-lock-observer.ts'

/** Collect acquisition attempts and acquired events, grouped as foreground, background-origin or post-dispatch. */
export function requestLockProbe() {
  let active = false
  let dispatched = false
  const foreground: NativeLockEvent[] = []
  const detached: NativeLockEvent[] = []
  const afterDispatch: NativeLockEvent[] = []
  return {
    foreground,
    detached,
    afterDispatch,
    onLockEvent(event: NativeLockEvent) {
      if (!active) return
      if (
        event.type !== 'acquired' &&
        event.type !== 'acquiring' &&
        event.type !== 'contended'
      )
        return
      if (event.detached) detached.push(event)
      else if (dispatched) afterDispatch.push(event)
      else foreground.push(event)
    },
    begin() {
      active = true
      dispatched = false
      foreground.length = detached.length = afterDispatch.length = 0
    },
    dispatch() {
      dispatched = true
    },
  }
}
