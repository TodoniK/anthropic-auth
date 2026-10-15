import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pluginRoot, '../..')
const coreRoot = join(repoRoot, 'packages/core')
const packageName = '@cortexkit/opencode-anthropic-auth'
const corePackageName = '@cortexkit/anthropic-auth-core'
type HostRuntimeFixture = {
  id: string
  label: string
  core: string
  keymap: string
  solid: string
  solidJs: string
}

const hostRuntimeFixtures: [HostRuntimeFixture, HostRuntimeFixture] = [
  {
    id: 'opencode-1-18-18',
    label: 'OpenCode 1.18.18',
    core: '0.4.5',
    keymap: '0.4.5',
    solid: '0.4.5',
    solidJs: '1.9.10',
  },
  {
    id: 'opencode-2-0-22',
    label: 'OpenCode 2.0.22',
    core: '0.5.14',
    keymap: '0.5.14',
    solid: '0.5.14',
    solidJs: '1.9.15',
  },
]

let failures = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function fail(name: string, detail: string): never {
  check(name, false, detail)
  throw new Error(`${name}: ${detail}`)
}

function run(
  command: string,
  args: string[],
  cwd: string,
  quietStdout = false,
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  })

  if (result.stdout && !quietStdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')}`,
      `exited with ${result.status ?? 'unknown status'}`,
    )
  }
  return result.stdout
}

function runBounded(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  quietStdout = false,
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  })

  if (result.stdout && !quietStdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    fail(
      name,
      result.error?.message ??
        `exited with ${result.status ?? 'unknown status'}`,
    )
  }
  return result.stdout
}

function parsePackedFilename(stdout: string): string {
  try {
    const packed = JSON.parse(stdout.trim()) as Array<{ filename?: string }>
    const filename = packed[0]?.filename
    if (typeof filename === 'string' && filename.length > 0) return filename
  } catch {
    // npm may print warnings around JSON; fall back to its tarball line.
  }

  const fallback = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.tgz'))
    .at(-1)
  if (fallback) return fallback
  fail('npm pack reports a tarball', stdout.trim() || 'no stdout')
}

async function runPackedHostRuntimeProbe(
  tempRoot: string,
  tarball: string,
  coreTarball: string,
  host: HostRuntimeFixture,
  missingHelper?: string,
): Promise<void> {
  const fixtureRoot = join(tempRoot, host.id)
  const installRoot = join(fixtureRoot, 'install')
  const home = join(fixtureRoot, 'home')
  const tmp = join(fixtureRoot, 'tmp')
  const xdgCache = join(home, 'cache')
  const xdgConfig = join(home, 'config')
  const xdgData = join(home, 'data')
  const xdgState = join(home, 'state')
  const bunInstallCache = join(fixtureRoot, 'bun-install-cache')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    TMPDIR: tmp,
    BUN_INSTALL_CACHE_DIR: bunInstallCache,
    OPENCODE_TUI_PREFERENCES_FILE: join(fixtureRoot, 'tui-preferences.jsonc'),
    OPENCODE_ANTHROPIC_AUTH_RPC_DIR: join(fixtureRoot, 'rpc'),
  }

  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(tmp, { recursive: true }),
    mkdir(xdgCache, { recursive: true }),
    mkdir(xdgConfig, { recursive: true }),
    mkdir(xdgData, { recursive: true }),
    mkdir(xdgState, { recursive: true }),
    mkdir(bunInstallCache, { recursive: true }),
  ])
  await writeFile(
    join(installRoot, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          [corePackageName]: `file:${coreTarball}`,
          [packageName]: `file:${tarball}`,
          '@opentui/core': host.core,
          '@opentui/keymap': host.keymap,
          '@opentui/solid': host.solid,
          'solid-js': host.solidJs,
        },
        overrides: {
          [corePackageName]: `file:${coreTarball}`,
        },
      },
      null,
      2,
    ),
  )

  runBounded(
    `${host.label} host-library installation`,
    'bun',
    ['install', '--production'],
    installRoot,
    env,
    180_000,
    true,
  )

  const installedPackageRoot = join(
    installRoot,
    'node_modules',
    '@cortexkit',
    'opencode-anthropic-auth',
  )
  const probe = `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[1];
const missingHelper = process.argv[2] || "";
const loadedPaths = [];

// Observe the packed TUI path only; the host configure helper owns runtime registration.
Bun.plugin({
  name: "observe-packed-host-tui-load",
  setup(build) {
    build.onLoad({ filter: /tui[.]tsx$/ }, async (args) => {
      loadedPaths.push(args.path.split(String.fromCharCode(92)).join("/"));
      return { contents: await readFile(args.path, "utf8"), loader: "tsx" };
    });
  },
});

const { runtimeModules: keymapRuntimeModules } = await import("@opentui/keymap/runtime-modules");
const { ensureRuntimePluginSupport } = await import("@opentui/solid/runtime-plugin-support/configure");
const additional = { ...keymapRuntimeModules };
if (missingHelper) {
  const solidRuntime = await import("@opentui/solid");
  if (typeof solidRuntime[missingHelper] !== "function") {
    throw new Error("negative control helper is absent from the real host runtime: " + missingHelper);
  }
  // Remove one real renderer export to prove the compiled import needs it.
  additional["@opentui/solid"] = Object.fromEntries(
    Object.entries(solidRuntime).filter(([name]) => name !== missingHelper),
  );
}
ensureRuntimePluginSupport({ additional });

const probeIntervals = [];
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const interval = nativeSetInterval(...args);
  interval.unref?.();
  probeIntervals.push(interval);
  return interval;
};

try {
  const entry = await import(pathToFileURL(join(packageRoot, "src/tui/entry.mjs")).href);
  if (entry.default?.id !== "cortexkit.anthropic-auth" || typeof entry.default?.tui !== "function") {
    throw new Error("packed TUI entry export shape is invalid");
  }
  let registrations = 0;
  const registeredPlugins = [];
  let failure;
  try {
    await entry.default.tui({
      slots: {
        register(value) {
          if (typeof value.slots.sidebar_content !== "function") {
            throw new Error("missing sidebar slot");
          }
          registrations++;
          registeredPlugins.push(value);
        },
      },
      state: { path: { directory: packageRoot } },
      route: { current: () => ({ type: "home" }) },
    });
  } catch (error) {
    failure = error;
  }

  const compiledLoaded = loadedPaths.some((path) => path.includes("tui-compiled"));
  const rawLoaded = loadedPaths.some((path) => path.endsWith("/src/tui.tsx"));
  if (missingHelper) {
    if (!failure) {
      const sidebar = registeredPlugins[0]?.slots.sidebar_content;
      if (typeof sidebar !== "function") {
        throw new Error("negative control registered no sidebar to exercise the renderer");
      }
      try {
        sidebar({}, { session_id: "negative-control" });
      } catch (error) {
        failure = error;
      }
    }
    if (!failure) {
      throw new Error("compiled TUI loaded even though the host renderer omitted " + missingHelper);
    }
    if (!String(failure).includes(missingHelper)) {
      throw new Error("compiled TUI failed for the wrong reason after omitting " + missingHelper + ": " + failure);
    }
    if (!compiledLoaded || rawLoaded) {
      throw new Error("negative control did not fail on the compiled TUI path");
    }
    console.log("negative host-runtime control rejected the compiled TUI without " + missingHelper);
  } else {
    if (failure) throw failure;
    if (registrations !== 1 || !compiledLoaded || rawLoaded) {
      throw new Error("host runtime did not invoke the packed compiled TUI path");
    }
    console.log("actual host runtime invoked the packed compiled TUI path");
  }
} finally {
  for (const interval of probeIntervals) clearInterval(interval);
}
`

  runBounded(
    `${host.label} packed TUI host-runtime probe${missingHelper ? ` without ${missingHelper}` : ''}`,
    'bun',
    [
      '-e',
      probe,
      installedPackageRoot,
      ...(missingHelper ? [missingHelper] : []),
    ],
    installRoot,
    env,
    60_000,
  )
}

const tempRoot = await mkdtemp(join(tmpdir(), 'anthropic-auth-tui-pack-'))
const installRoot = join(tempRoot, 'install')

try {
  if (process.env.TUI_SMOKE_SKIP_BUILD !== '1') {
    run('bun', ['run', 'build'], repoRoot)
  }

  const packStdout = run(
    'npm',
    ['pack', '--json', '--pack-destination', tempRoot],
    pluginRoot,
    true,
  )
  const tarball = join(tempRoot, parsePackedFilename(packStdout))
  check('npm pack produced a tarball', existsSync(tarball), tarball)

  // Release CI validates the new version before that version of core exists on
  // npm. Pack core locally too so this remains a real isolated installation
  // without depending on an already-published workspace version.
  const corePackStdout = run(
    'npm',
    ['pack', '--json', '--pack-destination', tempRoot],
    coreRoot,
    true,
  )
  const coreTarball = join(tempRoot, parsePackedFilename(corePackStdout))
  check(
    'npm pack produced a core tarball',
    existsSync(coreTarball),
    coreTarball,
  )

  await mkdir(installRoot, { recursive: true })
  await writeFile(
    join(installRoot, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          [corePackageName]: `file:${coreTarball}`,
          [packageName]: `file:${tarball}`,
        },
        overrides: {
          [corePackageName]: `file:${coreTarball}`,
        },
      },
      null,
      2,
    ),
  )
  run('bun', ['install', '--production'], installRoot)

  const installedPackageRoot = join(
    installRoot,
    'node_modules',
    '@cortexkit',
    'opencode-anthropic-auth',
  )
  // Exercise the published CLI under Node, not just source imports under Bun.
  // A split bundle can strand a CommonJS relative require in dist even when
  // the TUI loads correctly (e.g. jsonc-parser's ./impl/format wrapper).
  const installedCli = join(installedPackageRoot, 'dist/cli.js')
  check('CLI ships in the packed package', existsSync(installedCli))
  const cliHelp = run(
    process.env.CLI_SMOKE_NODE_BIN || 'node',
    [installedCli, '--help'],
    installRoot,
  )
  check('packed CLI exposes setup', cliHelp.includes('setup'))

  const compiledTui = join(installedPackageRoot, 'src/tui-compiled/tui.tsx')
  check('compiled TUI ships in the packed package', existsSync(compiledTui))

  const compiledText = existsSync(compiledTui)
    ? await readFile(compiledTui, 'utf8')
    : ''
  check(
    'compiled TUI imports the host runtime virtual modules',
    compiledText.includes('opentui:runtime-module:'),
  )
  check(
    'compiled TUI imports the Solid renderer helper used by the negative control',
    compiledText.includes('createComponent as _$createComponent'),
  )
  check(
    'compiled TUI imports Solid primitives through the host runtime',
    compiledText.includes('opentui:runtime-module:solid-js'),
  )
  check(
    'compiled TUI contains reactive wrapper calls',
    compiledText.includes('_$effect(') || compiledText.includes('_$insert('),
  )

  for (const host of hostRuntimeFixtures) {
    await runPackedHostRuntimeProbe(tempRoot, tarball, coreTarball, host)
    check(`${host.label} runtime invokes the packed compiled TUI`, true)
  }
  const negativeHost = {
    ...hostRuntimeFixtures[1],
    id: 'opencode-2-0-22-missing-create-component',
    label: 'OpenCode 2.0.22 negative control',
  }
  await runPackedHostRuntimeProbe(
    tempRoot,
    tarball,
    coreTarball,
    negativeHost,
    'createComponent',
  )
  check(
    'negative control rejects the compiled TUI without createComponent',
    true,
  )

  const rawFallbackProbe = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const packageRoot = process.argv[1];
const loadedPaths = [];
Bun.plugin({
  name: "observe-raw-tui-load",
  setup(build) {
    build.onLoad({ filter: /tui[.]tsx$/ }, async (args) => {
      loadedPaths.push(args.path.split(String.fromCharCode(92)).join("/"));
      return { contents: await readFile(args.path, "utf8"), loader: "tsx" };
    });
  },
});
process.env.OPENCODE_TUI_PREFERENCES_FILE = join(packageRoot, "absent-smoke-preferences.jsonc");
process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = join(packageRoot, "absent-smoke-rpc");
const entry = await import(pathToFileURL(join(packageRoot, "src/tui/entry.mjs")).href);
if (entry.default?.id !== "cortexkit.anthropic-auth" || typeof entry.default?.tui !== "function") {
  throw new Error("raw TUI fallback export shape is invalid");
}
let registrations = 0;
await entry.default.tui({
  slots: { register(value) { if (typeof value.slots.sidebar_content !== "function") throw new Error("missing sidebar"); registrations++; } },
  state: { path: { directory: packageRoot } },
  route: { current: () => ({ type: "home" }) },
});
if (registrations !== 1 || !loadedPaths.some((path) => path.endsWith("/src/tui.tsx")) || loadedPaths.some((path) => path.includes("tui-compiled"))) {
  throw new Error("bare Bun TUI invocation did not use the raw TSX fallback");
}
console.log("bare Bun invoked the actual raw TSX fallback");
process.exit(0);
`
  run('bun', ['-e', rawFallbackProbe, installedPackageRoot], installRoot)
  check('bare Bun imports the raw-TSX fallback', true)
} finally {
  if (process.env.KEEP_TUI_PACK_SMOKE !== '1') {
    await rm(tempRoot, { recursive: true, force: true })
  } else {
    console.log(`kept smoke temp dir: ${tempRoot}`)
  }
}

if (failures > 0) {
  console.error(`\nsmoke-tui-pack-install: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nsmoke-tui-pack-install: all checks passed')
