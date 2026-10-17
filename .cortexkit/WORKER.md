# Worker notes for anthropic-auth

## Running tests

- Use Bun 1.3.14. CI and releases pin it; the remote Linux runner's default Bun is newer.
- Run builds and suites on the remote Linux runner (`runon: linux,4c`). It already has Bun 1.3.14 at `/usr/local/bin/bun-1.3.14`. Do not download a runtime. In each remote job, put it first on PATH so nested scripts use it too:

  ```sh
  D=$(mktemp -d); ln -s /usr/local/bin/bun-1.3.14 "$D/bun"; export PATH="$D:$PATH"; bun --version
  ```

- Remote jobs receive your checkout's source files, but not ignored files and not your local build output. Build Core in the same job before any test that imports it: `bun run --cwd packages/core build`.
- Files under the ignored `.cortexkit/` folder never reach a remote job. Keep probes and fixtures that a remote job must run outside it, or pass them inline.
- The remote runner has no network. The packed-host check (`smoke:tui`, packed OpenCode installs) needs the npm registry; it refuses offline, and GitHub CI runs it.
- The runner is shared. When it is busy, unrelated tests can time out. Report each first failure as you saw it and say whether it touches your change; do not rerun until green and do not raise deadlines.
- A worker's local shell is sandboxed and cannot read the parent worktrees folder, so local package builds can fail with `CouldntReadCurrentDirectory`. Prefer the remote runner.
