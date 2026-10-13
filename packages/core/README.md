# @cortexkit/anthropic-auth-core

Internal implementation package for CortexKit's OpenCode and Pi integrations. Apart from the named public surface below, exports are internal host-support APIs with **no stability promise**.

## Public, stable surface

These root exports are public and stable for external callers, including Synapse's Anthropic request client:

- `resolveClaudeCodeIdentity`
- `buildBillingHeaderValue`
- `CLAUDE_CODE_ENTRYPOINT`
- `CLAUDE_CODE_IDENTITY`
- `applyClaudeCodeMetadata`
- `applyClaudeCodeHeaders`
- `signRequestBody`
- `orderClaudeCodeBody`

The export-manifest test pins these names to the actual root barrel. Legacy sidecar writers and pre-native scoped runtime APIs are removed; host credentials and settings use native storage. Upgrade migration and one-time vault seeding still read the old sidecar format.

User-facing packages:

- `@cortexkit/opencode-anthropic-auth` for OpenCode
- `@cortexkit/pi-anthropic-auth` for Pi

Claude Haiku 5.5 (`claude-haiku-5-5`) has a 1M-token context window and 128K max output. Standard input/output rates are $0.10/$0.50 per million tokens; all rates increase fivefold above 100K total input, including cached tokens. Optional quota priming continues to send a minimal Haiku 4.5 request to start a new quota window.
