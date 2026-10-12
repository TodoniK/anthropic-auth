/**
 * Setup and CLI failures can contain credential echoes from child processes
 * or remote responses. Only fixed remedies and verified lists of running
 * OpenCode or Pi processes appear directly on screen. Other failures show a
 * fixed step label, failure code and private diagnostic file path. Details
 * are bounded and scrubbed by the shared authentication library using known
 * credentials and Bearer, JWT and `sk-` token patterns.
 *
 * Thrown values, credential lists and environments are read only through own
 * data properties: getters, iterators, `toJSON`, `toString` and proxy traps are
 * never run. A message is trusted only when it equals one of the fixed texts
 * below; the error's class, prototype or `name` never decides it.
 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { types as utilTypes } from 'node:util'
import {
  createProviderErrorRedactor,
  formatLogLine,
  isSecretKey,
  type NativeCustodyErrorCode,
  NativeMigrationError,
  NativePiAuthSlotError,
  type ProviderErrorRedactor,
} from '@cortexkit/anthropic-auth-core'
import { NativeVaultActivationError } from './setup/native-activation.ts'
import { NativeVaultEnrollmentError } from './setup/native-enrollment.ts'
import {
  ProcessFenceViolationError,
  ProcessInspectionError,
} from './setup/process-fence.ts'

const STAGE_LABELS = {
  'setup-activation': 'Vault custody setup',
  'setup-opencode-config': 'OpenCode configuration',
  'setup-pi-install': 'Pi extension installation',
  'setup-pi': 'Pi setup',
  'setup-process-check': 'Host process check',
  'cli-setup': 'Setup',
  'cli-login': 'Login',
  'cli-api-add': 'API route setup',
  'cli-list': 'Account listing',
  'cli-relay-setup': 'Relay setup',
  'cli-relay-workers-dev': 'Workers.dev enablement',
  'cli-command': 'Command',
} as const

export type CliFailureStage = keyof typeof STAGE_LABELS

/**
 * Returns its argument unchanged, but fails to type-check unless the list
 * names every member of `Code`, so a code added to an error class cannot be
 * missed here.
 */
function everyCode<Code extends string>() {
  return <const List extends readonly Code[]>(
    list: List &
      ([Exclude<Code, List[number]>] extends [never]
        ? unknown
        : { missingCodes: Exclude<Code, List[number]> }),
  ): List => list
}

const ACTIVATION_CODES = everyCode<NativeVaultActivationError['code']>()([
  'auth-content-refused',
  'host-auth-invalid',
  'primary-conflict',
  'consent-required',
  'primary-unverified',
])
const ENROLLMENT_CODES = everyCode<NativeVaultEnrollmentError['code']>()([
  'enrollment-refused',
  'enrollment-reset',
  'approval-refused',
  'permission-refused',
])
const MIGRATION_CODES = everyCode<NativeMigrationError['code']>()([
  'invalid-source',
  'unsafe-source',
  'consent-required',
  'primary-unverified',
  'migration-busy',
  'ownership-lost',
  'retirement-refused',
])
const PI_SLOT_CODES = everyCode<NativePiAuthSlotError['code']>()([
  'invalid-options',
  'invalid-auth',
  'invalid-stash',
  'unsafe-path',
  'missing-stash',
  'conflict',
  'lock-timeout',
  'lock-compromised',
  'io',
])
const CUSTODY_CODES = everyCode<NativeCustodyErrorCode>()([
  'closed',
  'not-enrolled',
  'invalid-token',
  'unavailable',
  'identity-changed',
  'identity-unasserted',
  'insufficient-validity',
  'invalid-material',
  'not-active',
  'route-unavailable',
  'route-declined',
  'no-receipt',
  'unsafe-file',
  'invalid-state',
  'wrong-consumer',
  'roster-busy',
  'host-slot-login',
  'host-slot-placeholder',
  'placeholder-refresh',
])

/**
 * Every fixed message a known failure can carry. Messages of error classes
 * this package can import are produced by constructing that class with each
 * of its codes. NativeCustodyError is exported only as a type, so its fixed
 * message is derived from the closed code list. Plain Error messages and
 * unexported authority, runtime and metadata errors need literal entries.
 * If those messages change, the generic diagnostic path handles them instead
 * of displaying unchecked text.
 */
const CLOSED_MESSAGES: ReadonlySet<string> = new Set([
  new ProcessInspectionError().message,
  ...ACTIVATION_CODES.map(
    (code) => new NativeVaultActivationError(code).message,
  ),
  ...ENROLLMENT_CODES.map(
    (code) => new NativeVaultEnrollmentError(code).message,
  ),
  ...MIGRATION_CODES.map((code) => new NativeMigrationError(code).message),
  ...PI_SLOT_CODES.map((code) => new NativePiAuthSlotError(code).message),
  ...CUSTODY_CODES.map((code) => `Native custody refused: ${code}`),
  // Local sign-in is forbidden while vault custody remains connected.
  'Disconnect from the vault first.',
  // CLI input validation uses fixed messages rather than error codes.
  'Native account changes require offline setup without OPENCODE_AUTH_CONTENT',
  'Local login cannot be verified while OPENCODE_AUTH_CONTENT is set',
  'Authentication failed',
  'API fallback base URL must be an http(s) URL without embedded credentials',
  'API key is required',
  'Vault routes cannot be replaced with a local API key',
  'Cloudflare API token is required',
  'Cloudflare account ID is required',
  'Relay Worker URL is required',
  // Offline local setup refuses an unverified account identity.
  'Claude sign-in did not establish an account UUID',
  // Each selected host needs separate storage.
  'Native setup storage paths overlap between selected hosts',
  // Migration requires distinct credential and runtime storage paths.
  'Anthropic account storage paths overlap; migration requires separate files',
  'Anthropic account migration is required. Stop OpenCode, LiteCode and Pi, then run bunx @cortexkit/opencode-anthropic-auth@2.0.0 setup',
  'Anthropic account migration is incomplete; resume setup',
  'Anthropic account migration journal is invalid',
  'Anthropic account migration journal changed',
  // Runtime safety checks use these fixed refusal messages.
  'Anthropic runtime state is invalid',
  'Anthropic runtime file is not owner-only regular storage',
  'Anthropic runtime storage is unavailable',
  'Anthropic runtime observation is older than persisted state',
  'Anthropic runtime publication was refused',
  // Metadata-read failures without an HTTP status have one fixed message.
  // knownFailureMessage also accepts an appended, validated HTTP status code.
  'OAuth metadata read failed',
])

/**
 * Executable names ProcessFenceViolationError prints, compared case-
 * insensitively; it prints any other process as "host".
 */
const FENCE_HOST_NAMES: ReadonlySet<string> = new Set([
  'opencode',
  'litecode',
  'opencode2',
  'pi',
  'host',
])
/** Maximum host entries accepted when rebuilding a process-fence message. */
const MAX_FENCE_HOSTS = 64
/** Maximum entries read from a command's submitted-credentials array. */
const MAX_SUBMITTED_SECRETS = 256
/** Maximum environment keys inspected; more makes collection fail closed. */
const MAX_ENV_KEYS = 4096

/** Characters of raw text inspected before redaction. */
const RAW_WINDOW_CHARS = 64 * 1024
/** UTF-8 bytes of redacted detail kept per diagnostics file. */
export const CLI_FAILURE_DETAIL_MAX_BYTES = 4 * 1024
/** Nested `cause` errors described in a failure's detail before stopping. */
const MAX_CAUSE_DEPTH = 3

export const CLI_FAILURE_OMITTED =
  '[output beyond the diagnostic limit omitted]'
export const CLI_FAILURE_WITHHELD =
  '[output withheld: no line break within the inspected window]'
export const CLI_FAILURE_SECRETS_UNREADABLE =
  '[detail withheld: the known credentials could not be read safely]'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** An own data property's value; accessors and missing keys give undefined. */
function ownData(value: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key)
  return field !== undefined && 'value' in field ? field.value : undefined
}

function isInspectable(value: unknown): value is object {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    !utilTypes.isProxy(value)
  )
}

/**
 * Own data elements of a real array, or undefined when it is a proxy, has a
 * hole or accessor, or is longer than `max`.
 */
function ownDataElements(value: unknown, max: number): unknown[] | undefined {
  if (!isInspectable(value) || !Array.isArray(value)) return undefined
  const length = ownData(value, 'length')
  if (typeof length !== 'number' || length > max) return undefined
  const elements: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (field === undefined || !('value' in field)) return undefined
    elements.push(field.value)
  }
  return elements
}

/**
 * The `activeHosts` list of a ProcessFenceViolationError, when it is a real
 * array whose every entry has a non-negative integer `pid` and a `command`
 * from FENCE_HOST_NAMES, all as own data properties; otherwise undefined.
 */
function closedFenceHosts(
  value: unknown,
): Array<{ pid: number; command: string }> | undefined {
  const entries = ownDataElements(value, MAX_FENCE_HOSTS)
  if (entries === undefined || entries.length === 0) return undefined
  const hosts: Array<{ pid: number; command: string }> = []
  for (const entry of entries) {
    if (!isInspectable(entry)) return undefined
    const pid = ownData(entry, 'pid')
    const command = ownData(entry, 'command')
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 0)
      return undefined
    if (
      typeof command !== 'string' ||
      !FENCE_HOST_NAMES.has(command.toLowerCase())
    )
      return undefined
    hosts.push({ pid, command })
  }
  return hosts
}

/**
 * The text to show for a known failure, or undefined when the thrown value is
 * not one. A message counts only when it equals a text in CLOSED_MESSAGES,
 * equals "OAuth metadata read failed: <status>" for its own integer HTTP
 * `status`, or equals what `new ProcessFenceViolationError(activeHosts)`
 * produces from its own validated `activeHosts`.
 */
export function knownFailureMessage(error: unknown): string | undefined {
  try {
    if (!isInspectable(error)) return undefined
    const message = ownData(error, 'message')
    if (typeof message !== 'string') return undefined
    if (CLOSED_MESSAGES.has(message)) return message
    const status = ownData(error, 'status')
    if (
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599 &&
      message === `OAuth metadata read failed: ${status}`
    )
      return message
    const hosts = closedFenceHosts(ownData(error, 'activeHosts'))
    if (hosts && message === new ProcessFenceViolationError(hosts).message)
      return message
  } catch {
    // Unreadable values are treated as unknown.
  }
  return undefined
}

/**
 * Exact credentials a failing command may echo: the strings in `submitted`
 * (the API key, OAuth code and tokens, or Cloudflare and relay tokens the CLI
 * command handled) plus every environment value whose name Core's
 * `isSecretKey` treats as secret (for example `*_TOKEN`, `*_API_KEY`,
 * `*_SECRET`), since child processes receive that environment. Empty values are
 * skipped; every other value counts, however short. Returns undefined when
 * either input is a proxy, has accessors or non-string credentials, or is too
 * large to inspect, so the caller can withhold detail instead of logging it
 * with a credential left out.
 */
export function collectKnownSecrets(
  env: unknown,
  submitted: unknown = [],
): string[] | undefined {
  try {
    const secrets = new Set<string>()
    const values = ownDataElements(submitted, MAX_SUBMITTED_SECRETS)
    if (values === undefined) return undefined
    for (const value of values) {
      if (typeof value !== 'string') return undefined
      if (value !== '') secrets.add(value)
    }
    if (!isInspectable(env)) return undefined
    const keys = Reflect.ownKeys(env)
    if (keys.length > MAX_ENV_KEYS) return undefined
    for (const key of keys) {
      if (typeof key !== 'string' || !isSecretKey(key)) continue
      const field = Object.getOwnPropertyDescriptor(env, key)
      if (field === undefined) continue
      if (!('value' in field)) return undefined
      if (field.value === undefined || field.value === '') continue
      if (typeof field.value !== 'string') return undefined
      secrets.add(field.value)
    }
    return [...secrets]
  } catch {
    return undefined
  }
}

function utf8Head(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  // Step back off continuation bytes so a code point is never split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return decoder.decode(bytes.subarray(0, end))
}

function utf8Tail(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  let start = bytes.length - Math.max(0, maxBytes)
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80)
    start += 1
  return decoder.decode(bytes.subarray(start))
}

/**
 * Redact first, bound second. Raw text is only ever cut at a line break and
 * the partial line is dropped, so a credential is never split before the
 * redactor sees it whole. The redacted lines are then kept up to the byte
 * limit; cutting already-redacted text cannot reveal anything new.
 */
export function boundRedactedDetail(
  text: string,
  redactor: Pick<ProviderErrorRedactor, 'redactText'>,
  keep: 'head' | 'tail',
): string[] {
  let window = text
  let omitted = false
  if (text.length > RAW_WINDOW_CHARS) {
    omitted = true
    if (keep === 'tail') {
      const lineBreak = text.indexOf('\n', text.length - RAW_WINDOW_CHARS)
      window = lineBreak === -1 ? '' : text.slice(lineBreak + 1)
    } else {
      const lineBreak = text.lastIndexOf('\n', RAW_WINDOW_CHARS)
      window = lineBreak === -1 ? '' : text.slice(0, lineBreak)
    }
    if (window === '') return [CLI_FAILURE_WITHHELD]
  }
  const lines = redactor.redactText(window).split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  if (keep === 'tail') lines.reverse()
  const kept: string[] = []
  let budget = CLI_FAILURE_DETAIL_MAX_BYTES
  for (const line of lines) {
    const size = encoder.encode(line).length + 1
    if (size <= budget) {
      kept.push(line)
      budget -= size
      continue
    }
    if (kept.length === 0)
      kept.push(
        keep === 'tail'
          ? utf8Tail(line, budget - 1)
          : utf8Head(line, budget - 1),
      )
    omitted = true
    break
  }
  if (keep === 'tail') kept.reverse()
  if (omitted) {
    if (keep === 'tail') kept.unshift(CLI_FAILURE_OMITTED)
    else kept.push(CLI_FAILURE_OMITTED)
  }
  return kept
}

function errorKind(value: object): string {
  let current: object | null = value
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    if (utilTypes.isProxy(current)) break
    const name = ownData(current, 'name')
    if (typeof name === 'string') return name
    current = Object.getPrototypeOf(current) as object | null
  }
  return 'object'
}

/** Own data fields of a thrown value as text, without running its code. */
function describeThrown(value: unknown, depth: number): string[] {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  )
    return [`thrown ${typeof value}: ${String(value)}`]
  if (utilTypes.isProxy(value)) return ['thrown proxy (not inspected)']
  const lines: string[] = []
  const kind = errorKind(value)
  const message = ownData(value, 'message')
  lines.push(
    typeof message === 'string'
      ? `${kind}: ${message}`
      : `${kind} (no message)`,
  )
  const code = ownData(value, 'code')
  if (typeof code === 'string' || typeof code === 'number')
    lines.push(`code: ${code}`)
  const stack = ownData(value, 'stack')
  if (typeof stack === 'string') lines.push(stack)
  const cause = ownData(value, 'cause')
  if (cause !== undefined) {
    if (depth >= MAX_CAUSE_DEPTH) lines.push('caused by: [not described]')
    else lines.push('caused by:', ...describeThrown(cause, depth + 1))
  }
  return lines
}

/** A string environment entry, read without running accessors. */
function envText(env: object, key: string): string | undefined {
  const value = ownData(env, key)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Private per-user directory for failure details:
 * `$XDG_STATE_HOME/cortexkit/anthropic-auth/diagnostics`, falling back to
 * `~/.local/state`, which also holds host enrollment files. Undefined when
 * reading the environment would invoke caller code.
 */
export function cliDiagnosticsDirectory(env: unknown): string | undefined {
  if (!isInspectable(env)) return undefined
  const configured = envText(env, 'XDG_STATE_HOME')
  const home = envText(env, 'HOME')
  const stateHome =
    configured && isAbsolute(configured)
      ? configured
      : join(home && isAbsolute(home) ? home : homedir(), '.local', 'state')
  return join(stateHome, 'cortexkit', 'anthropic-auth', 'diagnostics')
}

/**
 * Write one failure detail to a new owner-only file and return its path, or
 * undefined if that cannot be done safely. An existing directory that is not
 * a real directory owned by this user with no group or other access is
 * refused, never repaired; the file is created exclusively with mode 0600 and
 * without following a symlink.
 */
async function writeDiagnosticFile(
  env: unknown,
  stage: CliFailureStage,
  contents: string,
): Promise<string | undefined> {
  try {
    const directory = cliDiagnosticsDirectory(env)
    if (directory === undefined) return undefined
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const metadata = await lstat(directory)
    if (!metadata.isDirectory()) return undefined
    if (process.platform !== 'win32') {
      if ((metadata.mode & 0o077) !== 0) return undefined
      if (metadata.uid !== process.getuid?.()) return undefined
    }
    const path = join(
      directory,
      `${stage}-${Date.now()}-${process.pid}-${randomUUID()}.log`,
    )
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      await handle.writeFile(contents, 'utf8')
    } finally {
      await handle.close()
    }
    return path
  } catch {
    return undefined
  }
}

async function recordFailure(
  stage: CliFailureStage,
  code: string,
  env: unknown,
  submitted: unknown,
  fields: Record<string, unknown>,
  detail: () => { text: string; keep: 'head' | 'tail' },
): Promise<string> {
  let lines: string[]
  const secrets = collectKnownSecrets(env, submitted)
  if (secrets === undefined) lines = [CLI_FAILURE_SECRETS_UNREADABLE]
  else {
    try {
      const redactor = createProviderErrorRedactor(secrets)
      try {
        const { text, keep } = detail()
        lines = boundRedactedDetail(text, redactor, keep)
      } finally {
        redactor.dispose()
      }
    } catch {
      lines = ['[failure detail could not be recorded]']
    }
  }
  const label = STAGE_LABELS[stage]
  // The shared formatLogLine formatter receives only fixed header fields. The
  // detail lines are already redacted and bounded and are appended as they
  // are: formatLogLine's payload redaction replaces any whole string value
  // matching "Bearer <text>", so "Bearer [REDACTED]" would lose the text
  // around the placeholder.
  const header = formatLogLine('error', 'cli', `${label} failed`, {
    stage,
    code,
    ...fields,
  })
  const path = await writeDiagnosticFile(
    env,
    stage,
    `${[header, ...lines].join('\n')}\n`,
  )
  return path === undefined
    ? `${label} failed (${code}). Details could not be saved to a private diagnostics file.`
    : `${label} failed (${code}). Details were written to ${path}`
}

/**
 * Screen text for a thrown failure. A known failure is returned word for word
 * and not recorded; anything else is recorded in a private diagnostics file
 * and replaced by a fixed line naming that file. `env` supplies both the
 * secret-named values to scrub and the diagnostics location; `submitted`
 * holds the credentials the failing command handled.
 */
export async function reportThrownFailure(
  stage: CliFailureStage,
  error: unknown,
  env: unknown,
  submitted: unknown = [],
): Promise<string> {
  const known = knownFailureMessage(error)
  if (known !== undefined) return known
  return recordFailure(
    stage,
    `${stage}/unexpected-error`,
    env,
    submitted,
    {},
    () => ({ text: describeThrown(error, 0).join('\n'), keep: 'head' }),
  )
}

/** Screen text for a child process that exited unsuccessfully; its stderr tail goes to the diagnostics file. */
export async function reportInstallerFailure(
  stage: CliFailureStage,
  result: { exitCode: number; stderr: string },
  env: unknown,
): Promise<string> {
  return recordFailure(
    stage,
    `${stage}/installer-exit`,
    env,
    [],
    { exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null },
    () => ({
      text: typeof result.stderr === 'string' ? result.stderr : '',
      keep: 'tail',
    }),
  )
}
