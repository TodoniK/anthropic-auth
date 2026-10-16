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

async function renderSidebar(state: unknown, wanted: string[]) {
  fixture = await mkdtemp(join(tmpdir(), 'anthropic-quota-render-'))
  const stateFile = join(fixture, 'sidebar.json')
  await writeFile(stateFile, JSON.stringify(state))
  // Render the compiled sidebar with installed OpenTUI libraries, without a package install.
  const probe = `
import { createTestRenderer } from '@opentui/core/testing';
import { render } from '@opentui/solid';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
ensureRuntimePluginSupport();
const { default: plugin } = await import(${JSON.stringify(new URL('../tui-compiled/tui.tsx', import.meta.url).href)});
const registered = [];
await plugin.tui({
  event: { on() { return () => {}; } },
  theme: { current: {
    accent: '#3366ff', background: '#000000', borderActive: '#ffffff',
    error: '#ff0000', success: '#00ff00', text: '#ffffff',
    textMuted: '#888888', warning: '#ffff00',
  } },
  slots: { register(value) { registered.push(value); } },
  state: { path: { directory: process.cwd() } },
  route: { current: () => ({ type: 'home' }) },
});
const sidebar = registered.find((value) => value.slots?.sidebar_content)?.slots.sidebar_content;
if (!sidebar) throw new Error('sidebar slot was not registered');
let destroyed;
const teardown = new Promise((resolve) => { destroyed = resolve; });
const setup = await createTestRenderer({ width: 42, height: 32, onDestroy() { destroyed(); } });
let settle;
const frame = new Promise((resolve) => { settle = resolve; });
const observe = () => {
  const text = setup.captureCharFrame();
  if (${JSON.stringify(wanted)}.every((part) => text.includes(part))) settle(text);
};
setup.renderer.on('frame', observe);
try {
  await render(() => sidebar({}, { session_id: 'quota-render-test' }), setup.renderer);
  setup.renderer.requestRender();
  const text = await frame;
  console.log(text);
} finally {
  setup.renderer.off('frame', observe);
  setup.renderer.destroy();
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
        OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: stateFile,
        OPENCODE_TUI_PREFERENCES_FILE: join(fixture, 'preferences.jsonc'),
        OPENCODE_ANTHROPIC_AUTH_RPC_DIR: join(fixture, 'rpc'),
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
  return stdout
}

test('compiled sidebar renders the shared quota figure reset and stale reading age offline', async () => {
  const now = Date.now()
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: {
            usedPercent: 60,
            remainingPercent: 40,
            checkedAt: now - 2 * 86400000,
            resetsAt: new Date(now + 4 * 86400000).toISOString(),
          },
          scoped: [],
        },
      },
      fallbacks: [],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    ['40% left', 'checked 2d ago'],
  )
  expect(stdout).toContain('40% left')
  expect(stdout).toContain('3d23h')
  expect(stdout).toContain('checked 2d ago')
  expect(stdout).not.toContain('Fable')
})

test('42-column sidebar renders full scoped names credits and stale fallback rows in aligned columns', async () => {
  const now = Date.now()
  const window = (used: number, checkedAt = now, resetMinutes?: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt,
    ...(resetMinutes === undefined
      ? {}
      : {
          resetsAt: new Date(now + resetMinutes * 60_000).toISOString(),
        }),
  })
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: window(62, now, 149),
          seven_day: window(41, now, 3 * 1440 + 23 * 60),
          scoped: [
            {
              id: 'fable',
              title: 'Fable only',
              modelName: 'Fable',
              ...window(78),
            },
          ],
          extraUsage: {
            used: { amountMinor: 1250, currency: 'USD', exponent: 2 },
            limit: { amountMinor: 5000, currency: 'USD', exponent: 2 },
            exhausted: false,
          },
        },
      },
      fallbacks: [
        {
          id: 'work',
          label: 'work',
          enabled: true,
          needsReauth: false,
          quota: {
            five_hour: window(8, now - 30 * 3_600_000),
            seven_day: window(93, now - 30 * 3_600_000),
          },
        },
      ],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    ['Fable only', 'credits 75% left', 'work', 'checked 1d6h ago'],
  )
  expect(stdout).toContain('38% left')
  expect(stdout).toContain('59% left')
  expect(stdout).toContain('Fable only ████████░░ 22% left')
  expect(stdout).toContain('credits 75% left')
  expect(stdout).toContain('92% left')
  expect(stdout).toContain('7% left')
  expect(stdout).toContain('checked 1d6h ago')
  const rows = stdout
    .split('\n')
    .filter((line) => /38% left|59% left|22% left|92% left|7% left/.test(line))
  expect(rows).toHaveLength(5)
  expect(new Set(rows.map((line) => line.search(/[█░▓▒]/)))).toEqual(
    new Set([12]),
  )
})
