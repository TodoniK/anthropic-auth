# Build modes

The OpenCode package has a bundled deployment build and an unbundled development build. Run package-specific commands from the repository root:

```sh
bun run --cwd packages/opencode build
bun run --cwd packages/opencode build:dev
```

`build` uses Bun to bundle Core and its bundled dependencies into split `dist/` output, emits declarations, compiles the TUI and checks bundle globals. The OpenCode 1/2 plugin peers and `jsonc-parser` remain external; this is not a promise that the package needs no runtime dependencies. Preserve normal package installation and host module resolution.

`build:dev` emits individual JavaScript/declaration files with TypeScript and requires workspace dependencies. Build Core first when its source changes. For the full ordered Core/OpenCode/Pi build, use root `bun run build`; the root does not define a `build:dev` script.

## Local OpenCode workflow

A disposable OpenCode configuration can point its main plugin entry at the local package:

```json
{
  "plugin": ["file:///path/to/anthropic-auth/packages/opencode"]
}
```

The path is an example: substitute your checkout, keep it separate from a live user's installation, and build before loading it. The root helper provides the local development loop:

```sh
bun run dev
bun run dev:clean
```

`dev` builds, symlinks output under `.opencode/plugins/` and starts TypeScript watch mode. Restart OpenCode after starting it and after rebuilds. `dev:clean` removes the development symlink.

## Package inspection

```sh
bun run pack:core:dry
bun run pack:opencode:dry
bun run pack:pi:dry
bun run --cwd packages/opencode smoke:tui
```

The dry pack commands inspect package contents without publishing. TUI smoke validates packed host renderer resolution and standalone CLI startup. See [development verification](development.md#verification) for test/typecheck/lint gates and fixture isolation, and [release workflow](releases.md#maintainer-release-workflow) for publication policy.

Implementation: [OpenCode scripts and externals](../packages/opencode/package.json), [workspace scripts](../package.json), [development helper](../scripts/dev.ts), and [TUI build](../packages/opencode/scripts/build-tui.ts).
