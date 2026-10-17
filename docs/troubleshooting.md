# Troubleshooting

## Installation and startup

- **Setup says a host is running:** stop all OpenCode, LiteCode and Pi processes, not only the current terminal, then rerun setup. Do not bypass the process fence or start a host before setup finishes.
- **OpenCode still loads an old plugin:** restart after config changes. If it still loads stale package bytes, clear OpenCode's plugin cache at `~/.cache/opencode` and restart. Do not delete account files or the journal as a cache remedy.
- **Generation-2 `setup --login` refuses:** this is intentional. Run [empty initialization](opencode-2.md#empty-initialization), start OpenCode and choose **Claude Pro / Max (native account pool)**. If Pi is also found, `--yes` selects both; use interactive host deselection for a Pi-only login.
- **A dry run succeeds but the real run refuses:** previews execute no callbacks. Real-run authority, consent, path-alias and vault-inventory checks can still refuse; see [setup options](installation.md#recommended-setup).

## Local accounts and migration

`migration-required` means local authority has not been established. Stop the hosts and run setup for the selected generation. `migration-incomplete` means a pre-commit journal must be resumed with the matching inputs; do not delete it to force fresh setup. Version-5 journals have no rollback path.

For an `invalid_grant` account, re-login through Accounts. If legacy main-account identity cannot be proved during OpenCode 1 migration, use the explicit stopped-host recovery:

```sh
npx @cortexkit/opencode-anthropic-auth setup --login --no-claustrum
```

`setup --login` does not perform an OpenCode 2-only login. Use the registered OpenCode 2 login instead when generation 2 is selected.

`pool-populated` prevents direct legacy import over native account data. Shared OC1 setup can skip import instead; do not copy tokens from the separate host slot into the pool. If Accounts shows that OpenCode's separate Anthropic login is unused, add that account through Accounts if needed or remove the separate login with OpenCode's own tools. Orphan metadata or quota-only state does not make a usable OAuth account; requests still refuse. See [the admission table](custody-state-machine.md#opencode-1).

`settings-changed` on a version-5 import resume means the captured native preferences no longer match. Preserve the files for diagnosis rather than overwriting settings or editing the digest. For `journal-conflict`, invalid journals or unsafe paths, correct the underlying mismatch without fabricating authority. [Upgrade and recovery](releases.md#upgrade-and-recovery) explains the compatibility boundary.

## Vault custody

`Disconnect from the vault first.` means local sign-in cannot run under vault authority. Use Accounts to disconnect, or manage accounts in Claustrum. An unreadable enrollment is not local permission; repair its ownership/permissions or use **Disconnect from the vault**. Do not copy enrollment tokens between hosts.

If OpenCode holds a separate Anthropic login while enrolled, remove that login using OpenCode's tools and choose the vault method, or disconnect. If vault setup reports no verified default Claude account, sign in through the vault and rerun setup; a local token cannot satisfy that check.

Pi setup requires explicit stored-login consent. A missing stash or conflicting current Pi slot is a preservation refusal, not an invitation to delete either login. Keep the stash, slot and enrollment intact and resolve the conflict before retrying. [Vault disconnect](vault.md#disconnect-and-recovery) describes the restore order.

## Requests and diagnostics

Check `/claude` for custody, account, routing and quota status first. Unknown quota, positive remaining-quota floors and model-scoped exhaustion can block an account even when it has a token. Resetting a session pin is not a way to bypass limits.

For transport failures, inspect the [relay log](transports.md#diagnostics-and-dumps); direct fallback is not relay success. OpenCode 2 cannot use WebSocket relay. Enable dumps only for a bounded investigation, and redact prompts, tool content and credentials before sharing them. Silence in debug-only cache records does not prove no traffic. Never investigate by running tests or setup against a live user database or live credentials.
