import type {
  NativeCustodyClient,
  NativeScopedWatchEnd,
  NativeScopedWatchNotice,
} from '../native-custody.ts'
import type { TestGate } from './test-lifetime.ts'

/** One vault watch a fake client opened, driven by the test. */
export type FakeVaultWatch = {
  readonly onNotice: (notice: NativeScopedWatchNotice) => void
  readonly options: { enrollmentToken?: string } | undefined
  /** End the watch as claustrum-client would report it. */
  finish(end: NativeScopedWatchEnd): void
  stopped: boolean
  seq: number
  /** Send the next in-sequence notice carrying `view`. */
  notify(view: string): void
}

/**
 * Give a fake vault client a `watchScoped` (claustrum-client 0.12.0) whose
 * watches the test drives: it sends notices and decides how each watch ends.
 * `gate` is the test lifetime's, so a wait for a watch that never opens is
 * released at teardown and fails the test instead of hanging the suite.
 */
export function watchableVaultClient(
  client: NativeCustodyClient,
  gate: () => TestGate,
) {
  const opened: FakeVaultWatch[] = []
  const waiters: { index: number; open: () => void }[] = []
  client.watchScoped = (onNotice, options) => {
    let finish: (end: NativeScopedWatchEnd) => void = () => {}
    const closed = new Promise<NativeScopedWatchEnd>((resolve) => {
      finish = resolve
    })
    const watch: FakeVaultWatch = {
      onNotice,
      options,
      finish: (end) => finish(end),
      stopped: false,
      seq: 0,
      notify(view) {
        onNotice({ kind: 'changed', epoch: 'epoch-1', seq: ++watch.seq, view })
      },
    }
    opened.push(watch)
    for (const waiter of [...waiters])
      if (waiter.index < opened.length) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.open()
      }
    return {
      stop() {
        watch.stopped = true
        finish({ kind: 'stopped' })
      },
      closed,
    }
  }
  return {
    opened,
    /** The nth watch opened (0-based), once the host has opened it. */
    async nth(index: number): Promise<FakeVaultWatch> {
      if (!opened[index]) {
        const opening = gate()
        waiters.push({ index, open: opening.open })
        await opening.wait
      }
      const watch = opened[index]
      if (!watch) throw new Error(`Vault watch ${index} was never opened`)
      return watch
    },
  }
}

/**
 * Real timers that remember the period of every interval and timeout still
 * pending, and of every interval ever created, in order. Pass the test's
 * cleanup registration so teardown clears whatever is left.
 */
export function recordedTimers(deferCleanup: (cleanup: () => void) => void) {
  const intervals = new Map<ReturnType<typeof setInterval>, number>()
  const timeouts = new Map<ReturnType<typeof setTimeout>, number>()
  const created: { handle: ReturnType<typeof setInterval>; ms: number }[] = []
  deferCleanup(() => {
    for (const handle of intervals.keys()) clearInterval(handle)
    for (const handle of timeouts.keys()) clearTimeout(handle)
  })
  return {
    intervals,
    timeouts,
    created,
    /** Whether this interval is still scheduled. */
    live: (handle: ReturnType<typeof setInterval>) => intervals.has(handle),
    setInterval: ((handler: () => void, ms: number) => {
      const handle = setInterval(handler, ms)
      intervals.set(handle, ms)
      created.push({ handle, ms })
      return handle
    }) as unknown as typeof setInterval,
    clearInterval: ((handle: ReturnType<typeof setInterval>) => {
      intervals.delete(handle)
      clearInterval(handle)
    }) as typeof clearInterval,
    setTimeout: ((handler: () => void, ms: number) => {
      const handle = setTimeout(() => {
        timeouts.delete(handle)
        handler()
      }, ms)
      timeouts.set(handle, ms)
      return handle
    }) as unknown as typeof setTimeout,
    clearTimeout: ((handle: ReturnType<typeof setTimeout>) => {
      timeouts.delete(handle)
      clearTimeout(handle)
    }) as typeof clearTimeout,
  }
}
