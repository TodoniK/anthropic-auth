# Development

This is a Bun workspace: Core contains shared auth/account/routing logic, OpenCode contains the plugin and standalone CLI, Pi contains the provider extension, and `packages/e2e-tests` contains disposable process fixtures. See [architecture](../ARCHITECTURE.md) and [structure](../STRUCTURE.md) for ownership.

Use Bun 1.3.14, matching the repository pin. Install dependencies in the checkout:

```sh
bun install
```

Host packages resolve Core through the workspace link. Rebuild Core dist before checking or testing consumers of changed Core source; otherwise an old declaration or bundle can conceal the current behavior. common-auth is a Core devDependency bundled into Core, not a new runtime import for the OpenCode CLI. The CLI must not acquire runtime Pi SDK imports.

## Verification

Run the repository gates from its root:

```sh
npm run test
npm run build
npm run typecheck
npm run lint
```

The scripts use the installed Bun/TypeScript/Biome tools. `test` builds packages, checks emitted Pi/CLI import boundaries, runs the Core/OpenCode/Pi owning suites and executes an isolated real Pi host round-trip with mocked provider responses. `typecheck` rebuilds Core, checks all package projects and the repository scripts; Bun tests alone do not typecheck.

Additional focused gates are:

```sh
bun run test:e2e
bun run check:claustrum-golden
bun run check:workspace-lock
bun run format:check
bun run pack:core:dry
bun run pack:opencode:dry
bun run pack:pi:dry
bun run --cwd packages/opencode smoke:tui
```

`check:claustrum-golden` compares pinned custody-marker fixtures with the authoritative Claustrum credential-vault repository over HTTPS. The lock check verifies manifests against `bun.lock`; it does not install dependencies. Packed TUI smoke checks both standalone CLI startup and host renderer resolution. Keep package builds sequential when tests share rebuilt Core dist.

Tests must use disposable home/config/data/state directories, fixture tokens and stubbed upstreams, not a live host, vault or database. Retain the first failure and original deadlines; do not retry an unchanged failure until it disappears. [Mutation proofs](testing/mutations.md#setup-authority-and-local-login-omission-controls) record which assertions fail when authority, import and admission safeguards are deliberately removed, and what those focused runs do not prove.

## Local OpenCode workflow

```sh
bun run dev
```

This builds the plugin, symlinks its output into `.opencode/plugins/` and starts TypeScript watch mode. Restart OpenCode after starting the script and after rebuilds. Remove the development symlink with `bun run dev:clean` when finished. Do not aim development artifacts at a live user's installation when verifying setup or migration.

Internal design and evidence belong under ignored `.cortexkit/internal-docs/`, not in public guides. Review authored comments and prose, and check each relative Markdown file/anchor link. Release operations are separate from development checks; see [release workflow](releases.md#maintainer-release-workflow).
