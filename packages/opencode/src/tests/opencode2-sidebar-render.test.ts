import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
let fixture: string | undefined
afterEach(async () => {
  child?.kill()
  await child?.exited
  child = undefined
  if (fixture) await rm(fixture, { recursive: true, force: true })
  fixture = undefined
})

interface Step {
  /** Text the frame must contain before the step completes. */
  wanted: string[]
  /** Sidebar calls the server must have answered first. */
  calls?: number
  /** Moves the probe's clock forward once the step completes. */
  advanceMs?: number
}

// Loads the package's `./tui` entry the way OpenCode 2 does (`setup(context)`),
// so the bundled v2 TUI, the RPC call and the precompiled sidebar all run.
// The server gives `answers` in order and repeats the last; `null` is a server
// without the `sidebar` method.
async function renderOpenCode2Sidebar(
  answers: unknown[],
  steps: Step[],
): Promise<{
  frames: string[]
  asked: string[]
  released: number
  colors: Record<string, string>
}> {
  fixture = await mkdtemp(join(tmpdir(), 'anthropic-oc2-sidebar-'))
  await writeFile(
    join(fixture, 'preferences.jsonc'),
    JSON.stringify({
      'anthropic-auth': { rememberCollapsed: false, pollMs: 500 },
    }),
  )
  const probe = `
import { createTestRenderer } from '@opentui/core/testing';
import { render } from '@opentui/solid';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
ensureRuntimePluginSupport();
const realNow = Date.now;
let clock = 0;
Date.now = () => realNow() + clock;
const { setup } = await import(${JSON.stringify(new URL('../tui/entry.mjs', import.meta.url).href)});
const answers = ${JSON.stringify(answers)};
const steps = ${JSON.stringify(steps)};
const asked = [];
const claims = [];
let released = 0;
const cleanup = await setup({
  location: { directory: process.cwd() },
  theme: {
    text: {
      base: '#ffffff', muted: '#888888',
      action: { primary: { base: '#3366ff' } },
      feedback: { success: { base: '#00ff00' }, warning: { base: '#ffff00' }, error: { base: '#ff0000' } },
    },
    background: { base: '#000000' },
    border: { base: '#ffffff' },
  },
  client: { rpc: () => ({
    events: { on: () => () => {} },
    open: async () => { throw new Error('unused'); },
    apply: async () => { throw new Error('unused'); },
    sidebar: async ({ sessionId }) => {
      const answer = answers[Math.min(asked.length, answers.length - 1)];
      asked.push(sessionId);
      if (answer === null) throw Object.assign(new Error('missing'), { code: 'rpc.method_not_found' });
      return answer;
    },
  }) },
  keymap: { layer() {} },
  ui: {
    router: { current: () => ({ type: 'session', sessionID: 'ses_oc2' }) },
    slot(claim) { claims.push(claim); return () => { released++; }; },
    toast: { show() {} },
    dialog: {},
  },
});
if (claims.length !== 1 || claims[0].append !== 'sidebar.content') throw new Error('sidebar slot was not claimed');
let destroyed;
const teardown = new Promise((resolve) => { destroyed = resolve; });
const setupRenderer = await createTestRenderer({ width: 42, height: 32, onDestroy() { destroyed(); } });
const frames = [];
try {
  await render(() => claims[0].render({ sessionID: 'ses_oc2' }), setupRenderer.renderer);
  for (const step of steps) {
    for (;;) {
      await setupRenderer.renderOnce();
      const text = setupRenderer.captureCharFrame();
      if (asked.length >= (step.calls ?? 0) && step.wanted.every((part) => text.includes(part))) {
        frames.push(text);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    clock += step.advanceMs ?? 0;
  }
  const colors = {};
  for (const line of setupRenderer.captureSpans().lines)
    for (const span of line.spans)
      if (span.text.trim()) colors[span.text.trim()] ??= String(span.fg);
  cleanup();
  console.log(JSON.stringify({ frames, asked, released, colors }));
} finally {
  setupRenderer.renderer.destroy();
  await teardown;
}
process.exit(0);
`
  child = Bun.spawn(
    [process.execPath, '--preload', '@opentui/solid/preload', '-e', probe],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        OPENCODE_TUI_PREFERENCES_FILE: join(fixture, 'preferences.jsonc'),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
}

// Each test starts Bun with OpenTUI; a loaded machine takes past the 5 s default.
const SUBPROCESS_TIMEOUT_MS = 20_000

// The test renderer prints colors as `RGBA.toString()`.
const rgba = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(
    (at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255,
  )
  return `rgba(${r?.toFixed(2)}, ${g?.toFixed(2)}, ${b?.toFixed(2)}, 1.00)`
}

// Main at 60 % (5h) and 20 % (7d) used, both resetting three hours from now.
function quotaState() {
  const now = Date.now()
  const window = (used: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt: now,
    resetsAt: new Date(now + 3 * 3_600_000).toISOString(),
  })
  return {
    main: {
      quota: { checkedAt: now, five_hour: window(60), seven_day: window(20) },
    },
    fallbacks: [],
    activeId: 'main',
    route: 'main-first',
    relay: null,
    fastMode: false,
    lastUpdated: now,
  }
}

test(
  'OpenCode 2 sidebar draws server quota with the host theme and releases its slot',
  async () => {
    const result = await renderOpenCode2Sidebar(
      [quotaState()],
      [{ wanted: ['40% left', '80% left'] }],
    )
    const [frame] = result.frames
    expect(frame).toContain('CLAUDE')
    expect(frame).toContain('main')
    expect(frame).toContain('active')
    expect(frame).toContain('main-first')
    expect(result.asked).toContain('ses_oc2')
    const colorOf = (text: string) =>
      Object.entries(result.colors).find(([span]) => span.includes(text))?.[1]
    // 60 % used is past the default warning threshold; 20 % is fine.
    expect(colorOf('40% left')).toBe(rgba('#ffff00'))
    expect(colorOf('80% left')).toBe(rgba('#00ff00'))
    expect(colorOf('active')).toBe(rgba('#00ff00'))
    expect(colorOf('main-first')).toBe(rgba('#3366ff'))
    expect(result.released).toBe(1)
  },
  SUBPROCESS_TIMEOUT_MS,
)

test(
  'OpenCode 2 sidebar waits instead of failing when the server has no sidebar method',
  async () => {
    const result = await renderOpenCode2Sidebar(
      [null],
      [{ wanted: ['Waiting for quota'] }],
    )
    expect(result.frames[0]).toContain('CLAUDE')
    expect(result.asked.length).toBeGreaterThan(0)
  },
  SUBPROCESS_TIMEOUT_MS,
)

test(
  'OpenCode 2 sidebar countdowns advance while the server answers the same state',
  async () => {
    const result = await renderOpenCode2Sidebar(
      [quotaState()],
      [
        { wanted: ['40% left', '2h59m'], calls: 2, advanceMs: 3_600_000 },
        { wanted: ['1h59m'] },
      ],
    )
    expect(result.frames[1]).toContain('40% left')
    expect(result.frames[1]).not.toContain('2h59m')
  },
  SUBPROCESS_TIMEOUT_MS,
)

test(
  'OpenCode 2 sidebar keeps the last quota when later polls fail',
  async () => {
    const result = await renderOpenCode2Sidebar(
      [quotaState(), null],
      [
        { wanted: ['40% left'], calls: 3, advanceMs: 1_800_000 },
        { wanted: ['40% left', '2h29m'], calls: 4 },
      ],
    )
    expect(result.frames[1]).not.toContain('Waiting for quota')
  },
  SUBPROCESS_TIMEOUT_MS,
)
