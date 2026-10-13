import { expect, test } from 'bun:test'
import * as core from '../index.ts'
import { PUBLIC_CORE_VALUES } from './export-manifest.ts'

// Inspect the actual barrel, not a list of implementation modules that could bypass it.
for (const name of PUBLIC_CORE_VALUES) {
  test(`stable public Core export: ${name}`, () => {
    expect(Object.hasOwn(core, name)).toBe(true)
    // biome-ignore lint/performance/noDynamicNamespaceImportAccess: Audit the actual module namespace, not a proxy.
    expect(core[name]).toBeDefined()
    // biome-ignore lint/performance/noDynamicNamespaceImportAccess: Every declared public value must be inspected.
    expect(typeof core[name]).toBe(
      name.startsWith('CLAUDE_CODE_') ? 'string' : 'function',
    )
  })
}
