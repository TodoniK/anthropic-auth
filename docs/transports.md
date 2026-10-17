# Transports and request diagnostics

Direct requests are the default. An optional user-owned Cloudflare Worker relay reduces upload bytes by sending a full body initially and session-affine patches afterwards; the Worker reconstructs the complete Anthropic request. CortexKit does not operate a shared relay, and relay compression does not reduce Anthropic input tokens by itself.

## Relay

Prepare OpenCode's local pool with [setup](installation.md#recommended-setup) before saving relay settings. Provision a Worker in your Cloudflare account with the CLI:

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  bunx @cortexkit/opencode-anthropic-auth relay setup
```

This creates a KV namespace, uploads/enables the Worker, generates a relay shared secret and saves the URL, secret and HTTP transport in OpenCode's local settings. The Cloudflare API token is used for provisioning, not stored by the plugin. Keep it and the relay secret out of reports. This command does not configure Pi: Pi's existing relay settings can be imported from its legacy `anthropic-auth.json` during Pi migration. `/claude` has no relay actions.

`relay.transport` is `http` by default. `websocket` is opt-in for OpenCode 1 and Pi, uses protocol v2 on `/ws` and requires the current Worker deployment. Redeploy an existing Worker with the same Worker name when upgrading its protocol. OpenCode 2 supports direct and HTTP only and refuses a selected WebSocket relay before dispatch.

`relay.fallbackToDirect` allows direct fallback on relay failures before streaming; set it to `false` if direct dispatch is not acceptable. Genuine upstream authorization failures and relay failures have different provenance; a relay's own 401 must not invalidate a Claude account. Vault mode still authorizes each physical send through the vault.

## Proxy routes

API-key routes can use a custom base URL and auth-header selection. The CLI's API-route inputs are listed in [commands](commands.md#opencode-cli). `ANTHROPIC_BASE_URL` can override the request endpoint. Pi additionally supports `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL` on API-key proxy routes; those custom-header/model overrides do not alter OAuth requests. Protected authentication and protocol headers cannot be replaced by custom headers.

Only use endpoints you trust: the route receives the request content and its configured authorization. Do not use insecure transport settings as a remedy for a credential or custody error.

## Diagnostics and dumps

Relay diagnostics are written to a temporary log:

```sh
tail -f "$(node -p 'require("node:os").tmpdir()')/opencode-anthropic-auth.log"
```

Successful entries identify transport/protocol and full-sync/patch use; `falling back direct` indicates direct fallback rather than relay success.

Enable or disable request dumps in `/claude` → **Diagnostics**. Artifacts live under the OS temp directory's `opencode-anthropic-auth-dumps` folder:

| Suffix | Contents |
| --- | --- |
| `.body.json` | Final rewritten request body |
| `.meta.json` | Hashes, byte counts, diff ranges and cache-relevant structure |
| `.relay.json` | Redacted relay payload/frame metadata |
| `.request.json` | Redacted direct URL, method and headers |

Dump bodies can contain prompts and tool content even when metadata is redacted. Treat them as private debugging artifacts, disable dumping when done, and sanitize anything shared. Lane-start dumps use `-start-`; CacheKeep uses `-prewarm-cachekeep-`. See [cache diagnostics](cache.md#diagnostics-and-history-analysis) and [safe troubleshooting](troubleshooting.md#requests-and-diagnostics).
