import { afterEach, beforeEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, parse, relative, sep } from 'node:path'

let testDir: string | undefined
let originalXdgStateHome: string | undefined
const activeBodies = new Set<Promise<unknown>>()

function piTestTempRoot(): string {
  const systemTempDir = tmpdir()
  const relativeFromHome = relative(homedir(), systemTempDir)
  const tempIsInsideHome =
    relativeFromHome !== '..' &&
    !relativeFromHome.startsWith(`..${sep}`) &&
    !isAbsolute(relativeFromHome)

  // Some test runners place temporary files under HOME, where the real enrollment file lives.
  return tempIsInsideHome
    ? join(parse(systemTempDir).root, 'tmp')
    : systemTempDir
}

/** Bun deadlines do not cancel async bodies; keep their fixture alive until they settle. */
export function trackPiTestBody<T>(body: Promise<T>): Promise<T> {
  activeBodies.add(body)
  void body.then(
    () => activeBodies.delete(body),
    () => activeBodies.delete(body),
  )
  return body
}
const HOST_PATH_ENV_VARS = [
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'PI_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'PI_ANTHROPIC_AUTH_FILE',
  'PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
] as const

beforeEach(async () => {
  testDir = await mkdtemp(join(piTestTempRoot(), 'anthropic-auth-pi-test-'))
  originalXdgStateHome = process.env.XDG_STATE_HOME
  for (const key of HOST_PATH_ENV_VARS) delete process.env[key]
  process.env.OPENCODE_CONFIG_DIR = join(testDir, 'opencode')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    testDir,
    'anthropic-auth.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
    testDir,
    'anthropic-auth-state.json',
  )
  process.env.PI_AGENT_DIR = join(testDir, '.pi-agent')
  process.env.XDG_STATE_HOME = join(testDir, 'xdg-state')
})

afterEach(async () => {
  const retiredDir = testDir
  const retiredBodies = [...activeBodies]
  testDir = undefined
  await Promise.allSettled(retiredBodies)
  if (originalXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome
  }
  originalXdgStateHome = undefined
  if (retiredDir) await rm(retiredDir, { recursive: true, force: true })
})
