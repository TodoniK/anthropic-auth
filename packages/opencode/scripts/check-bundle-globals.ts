import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export async function checkBundleGlobals(bundlePath: string): Promise<void> {
  const root = await realpath(dirname(bundlePath))
  const pending = [bundlePath]
  const seen = new Set<string>()
  const sources: string[] = []
  const scanner = new Bun.Transpiler({ loader: 'js' })
  let size = 0
  while (pending.length) {
    const next = pending.pop()
    if (!next) continue
    let path: string
    let source: string
    try {
      path = await realpath(next)
      const within = relative(root, path)
      if (
        isAbsolute(within) ||
        within === '..' ||
        within.startsWith(`..${sep}`)
      )
        throw new Error('Bundle import leaves dist')
      if (seen.has(path)) continue
      source = await readFile(path, 'utf8')
    } catch {
      throw new Error(
        `Bundle artifact check failed: ${next} is missing or outside dist`,
      )
    }
    seen.add(path)
    sources.push(source)
    size += Buffer.byteLength(source)
    for (const dependency of scanner.scanImports(source)) {
      if (dependency.path.startsWith('.'))
        pending.push(resolve(dirname(path), dependency.path))
    }
  }
  if (size <= 1024)
    throw new Error(
      `Bundle artifact check failed: ${bundlePath} is not substantial (${size} bytes)`,
    )
  // Shared entry points can move implementation into chunks. Inspect only
  // files imported by this entry, not unrelated files that happen to be in dist.
  const bundle = sources.join('\n')
  if (!bundle.includes('__anthropicAuthRpcServers'))
    throw new Error(
      'Bundle positive-control check failed: __anthropicAuthRpcServers is absent',
    )
  // This is a check for one obsolete identifier, not a complete global audit.
  const singularMatches =
    bundle.match(/__anthropicAuthRpcServer(?!s)/g)?.length ?? 0
  if (singularMatches)
    throw new Error(
      `Bundle stale-global check failed: __anthropicAuthRpcServer appears ${singularMatches} time(s)`,
    )
}

if (import.meta.main)
  await checkBundleGlobals(join(import.meta.dir, '..', 'dist', 'index.js'))
