import { readdir, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'

export const SETUP_TAIL_BYTES = 4096
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Redact before bounding so truncation cannot expose the end of a secret or path. */
export function fixtureRedactor({ fixtureRoots = [], secrets = [] } = {}) {
  const roots = [
    ...new Set(
      fixtureRoots
        .filter(Boolean)
        .flatMap((root) => [
          root,
          root.replaceAll('\\', '/'),
          encodeURI(root.replaceAll('\\', '/')),
          JSON.stringify(root).slice(1, -1),
        ]),
    ),
  ].sort((left, right) => right.length - left.length)
  return (value) => {
    let text = String(value ?? '')
    for (const root of roots) {
      const path = new RegExp(
        `${escapeRegex(root)}(?=$|[\\\\/\\s"'<>|():])(?:[\\\\/][^\\r\\n"'<>|()]*)?`,
        'gi',
      )
      text = text.replace(path, '<redacted-fixture-path>')
    }
    for (const secret of secrets.filter(Boolean))
      text = text.replaceAll(secret, '<redacted-secret>')
    return text
  }
}

export function boundedTail(value, redact, limit = SETUP_TAIL_BYTES) {
  const bytes = Buffer.from(redact(value))
  let start = Math.max(0, bytes.length - limit)
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}

export async function diagnosticInventory(directory) {
  if (!directory) return { state: 'unconfigured', names: [] }
  try {
    return {
      state: 'present',
      names: (await readdir(directory))
        .filter((name) => name.endsWith('.log'))
        .sort(),
    }
  } catch (error) {
    return {
      state: error.code === 'ENOENT' ? 'absent' : 'unreadable',
      names: [],
      errorCode: error.code ?? 'unknown',
    }
  }
}

/** A missing signature cannot establish that an opaque setup failure was not a timeout. */
export function classifyPublication({
  exitCode,
  stdout = '',
  stderr = '',
  diagnostics = [],
}) {
  const details = [stdout, stderr, ...diagnostics].join('\n')
  for (const line of details.split(/\r?\n/)) {
    const prefix = 'CLI failure metadata: '
    if (!line.startsWith(prefix)) continue
    try {
      const metadata = JSON.parse(line.slice(prefix.length))
      const error =
        metadata !== null &&
        typeof metadata === 'object' &&
        !Array.isArray(metadata) &&
        Object.hasOwn(metadata, 'error')
          ? metadata.error
          : undefined
      if (
        error !== null &&
        typeof error === 'object' &&
        !Array.isArray(error) &&
        ['name', 'code', 'stage'].every((key) => Object.hasOwn(error, key)) &&
        error.name === 'PrivateFileError' &&
        error.code === 'ETIMEDOUT' &&
        error.stage === 'rename'
      )
        return {
          kind: 'publication-timeout',
          basis: 'private-file-rename-metadata',
        }
    } catch {
      // Partial or malformed metadata does not identify the setup failure.
    }
  }
  if (/publication\s+deadline\s+expired/i.test(details))
    return {
      kind: 'publication-timeout',
      basis: 'publication-deadline-message',
    }
  if (
    /PrivateFileError[^\r\n]*Private file refused at rename:[^\r\n]*\bETIMEDOUT\b/i.test(
      details,
    )
  )
    return {
      kind: 'publication-timeout',
      basis: 'private-file-rename-etimedout',
    }
  return { kind: exitCode === 0 ? 'succeeded' : 'unclassified-setup-failure' }
}

export async function setupEvidence(value, passed, options, before) {
  const redact = fixtureRedactor(options)
  const inventory = await diagnosticInventory(options.diagnosticsDirectory)
  const names = inventory.names.filter((name) => !before.names.includes(name))
  const files = []
  const rawDiagnostics = []
  for (const name of names.slice(-4)) {
    try {
      const contents = await readFile(
        join(options.diagnosticsDirectory, name),
        'utf8',
      )
      rawDiagnostics.push(contents)
      const entry = {
        file: redact(name),
        contentsTail: boundedTail(contents, redact),
      }
      try {
        const header = JSON.parse(
          contents.split(/\r?\n/, 1)[0].match(/\{.*\}\s*$/)?.[0] ?? '{}',
        )
        for (const key of ['stage', 'code'])
          if (typeof header[key] === 'string')
            entry[key] = boundedTail(header[key], redact, 128)
      } catch {
        /* Preserve the redacted contents even if a header cannot be decoded. */
      }
      files.push(entry)
    } catch (error) {
      files.push({
        file: redact(name),
        readErrorCode: redact(error.code ?? 'unknown'),
      })
    }
  }
  const exitCode =
    typeof value?.exitCode === 'number'
      ? value.exitCode
      : typeof value?.code === 'number'
        ? value.code
        : passed
          ? 0
          : null
  return {
    exitCode,
    errorCode:
      typeof value?.code === 'string'
        ? boundedTail(value.code, redact, 128)
        : null,
    signal:
      typeof value?.signal === 'string'
        ? boundedTail(value.signal, redact, 128)
        : null,
    stdoutTail: boundedTail(value?.stdout, redact),
    stderrTail: boundedTail(value?.stderr, redact),
    failureMessage: passed ? null : boundedTail(value?.message, redact),
    diagnostics: {
      state: inventory.state,
      errorCode: inventory.errorCode ?? null,
      files,
      truncated: names.length > 4,
    },
    publication: classifyPublication({
      exitCode,
      stdout: value?.stdout,
      stderr: value?.stderr,
      diagnostics: rawDiagnostics,
    }),
  }
}

/** Windows may retain a loaded addon until process exit; cleanup is not a product gate. */
export async function cleanupFixture(root, { remove = rm, secrets = [] } = {}) {
  try {
    await remove(root, { recursive: true, force: true })
    return { removed: true, leftoverFiles: [] }
  } catch (error) {
    const redact = fixtureRedactor({ fixtureRoots: [root], secrets })
    const evidence = {
      removed: false,
      errorCode: redact(error.code ?? 'unknown'),
      leftoverFiles: [],
      truncated: false,
    }
    async function walk(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (evidence.leftoverFiles.length >= 25) {
          evidence.truncated = true
          return
        }
        const path = join(directory, entry.name)
        evidence.leftoverFiles.push(
          redact(relative(root, path).replaceAll('\\', '/')),
        )
        if (entry.isDirectory()) await walk(path)
        if (evidence.truncated) return
      }
    }
    try {
      await walk(root)
    } catch (failure) {
      evidence.inventoryErrorCode = redact(failure.code ?? 'unknown')
    }
    return evidence
  }
}
