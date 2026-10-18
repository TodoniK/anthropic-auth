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

// Loads the package's `./tui` entry the way OpenCode 2 does (`setup(context)`),
// so the bundled v2 TUI, the RPC call and the precompiled sidebar all run.
async function renderOpenCode2Sidebar(
  answer: unknown,
  wanted: string[],
): Promise<{
  frame: string
  asked: string[]
  released: number
  colors: Record<string, string>
}> {
  fixture = await mkdtemp(join(tmpdir(), 'anthropic-oc2-sidebar-'))
  await writeFile(
    join(fixture, 'preferences.jsonc'),
    JSON.stringify({ 'anthropic-auth': { rememberCollapsed: false } }),
  )
  const probe = `
import { createTestRenderer } from '@opentui/core/testing';
import { render } from '@opentui/solid';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
ensureRuntimePluginSupport();
const { setup } = await import(${JSON.stringify(new URL('../tui/entry.mjs', import.meta.url).href)});
const answer = ${JSON.stringify(answer)};
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
let settle;
const frame = new Promise((resolve) => { settle = resolve; });
const observe = () => {
  const text = setupRenderer.captureCharFrame();
  if (${JSON.stringify(wanted)}.every((part) => text.includes(part))) settle(text);
};
setupRenderer.renderer.on('frame', observe);
try {
  await render(() => claims[0].render({ sessionID: 'ses_oc2' }), setupRenderer.renderer);
  setupRenderer.renderer.requestRender();
  const text = await frame;
  const colors = {};
  for (const line of setupRenderer.captureSpans().lines)
    for (const span of line.spans)
      if (span.text.trim()) colors[span.text.trim()] ??= String(span.fg);
  cleanup();
  console.log(JSON.stringify({ frame: text, asked, released, colors }));
} finally {
  setupRenderer.renderer.off('frame', observe);
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

// The test renderer prints colors as `RGBA.toString()`.
const rgba = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(
    (at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255,
  )
  return `rgba(${r?.toFixed(2)}, ${g?.toFixed(2)}, ${b?.toFixed(2)}, 1.00)`
}

test('OpenCode 2 sidebar draws server quota with the host theme and releases its slot', async () => {
  const now = Date.now()
  const window = (used: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt: now,
    resetsAt: new Date(now + 3 * 3_600_000).toISOString(),
  })
  const result = await renderOpenCode2Sidebar(
    {
      main: {
        quota: { checkedAt: now, five_hour: window(60), seven_day: window(20) },
      },
      fallbacks: [],
      activeId: 'main',
      route: 'main-first',
      relay: null,
      fastMode: false,
      lastUpdated: now,
    },
    ['40% left', '80% left'],
  )
  expect(result.frame).toContain('CLAUDE')
  expect(result.frame).toContain('main')
  expect(result.frame).toContain('active')
  expect(result.frame).toContain('main-first')
  expect(result.asked).toContain('ses_oc2')
  const colorOf = (text: string) =>
    Object.entries(result.colors).find(([span]) => span.includes(text))?.[1]
  // 60 % used is past the default warning threshold; 20 % is fine.
  expect(colorOf('40% left')).toBe(rgba('#ffff00'))
  expect(colorOf('80% left')).toBe(rgba('#00ff00'))
  expect(colorOf('active')).toBe(rgba('#00ff00'))
  expect(colorOf('main-first')).toBe(rgba('#3366ff'))
  expect(result.released).toBe(1)
})

test('OpenCode 2 sidebar waits instead of failing when the server has no sidebar method', async () => {
  const result = await renderOpenCode2Sidebar(null, ['Waiting for quota'])
  expect(result.frame).toContain('CLAUDE')
  expect(result.asked.length).toBeGreaterThan(0)
})
