import { expect } from 'bun:test'
import { NativeRuntimeRegistry } from '../native-runtime-registry.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, gate, deferCleanup, trackDetached } = createTestLifetimeSuite()

test('runtime leases fence repeated predecessor release while a successor serves', async () => {
  const registry = new NativeRuntimeRegistry<{
    close(): void
    read(): number
  }>()
  let created = 0
  let closes = 0
  const create = () => {
    const generation = ++created
    let closed = false
    return {
      close() {
        closed = true
        closes++
      },
      read() {
        if (closed) throw new Error('closed')
        return generation
      },
    }
  }
  const predecessor = registry.acquire('same', create)
  const drain = gate()
  const disposing = drain.wait.then(() => predecessor.close())
  trackDetached(disposing)
  const successor = registry.acquire('same', create)
  deferCleanup(() => successor.close())
  expect(created).toBe(1)
  drain.open()
  await disposing
  predecessor.close()
  expect(successor.use().read()).toBe(1)
  expect(closes).toBe(0)
  successor.close()
  expect(closes).toBe(1)
  const replacement = registry.acquire('same', create)
  deferCleanup(() => replacement.close())
  predecessor.close()
  successor.close()
  expect(replacement.use().read()).toBe(2)
  expect(() => predecessor.use()).toThrow('closed')
  expect(closes).toBe(1)
  replacement.close()
  expect(closes).toBe(2)
})

test('runtime registry removes a retired generation before a reentrant acquisition', () => {
  const registry = new NativeRuntimeRegistry<{ close(): void }>()
  let successor: ReturnType<typeof registry.acquire> | undefined
  let successorCloses = 0
  const old = registry.acquire('same', () => ({
    close() {
      successor = registry.acquire('same', () => ({
        close() {
          successorCloses++
        },
      }))
    },
  }))
  deferCleanup(() => successor?.close())
  old.close()
  old.close()
  expect(successor).toBeDefined()
  const otherLease = registry.acquire('same', () => {
    throw new Error('lost successor')
  })
  deferCleanup(() => otherLease.close())
  successor!.close()
  expect(successorCloses).toBe(0)
  otherLease.close()
  expect(successorCloses).toBe(1)
})
