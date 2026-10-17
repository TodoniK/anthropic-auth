# Request rewriting and safety fallback

## Request rewriting

For Claude Pro/Max OAuth requests, the plugin changes outgoing HTTP headers and bodies after OpenCode constructs the request and before dispatch to Anthropic:

1. Rewrite the endpoint when `ANTHROPIC_BASE_URL` is configured.
2. Normalize Claude-compatible OAuth headers and beta flags.
3. Remove OpenCode-specific identity text from system blocks.
4. Prepend Claude Code identity and billing-header blocks.
5. Rewrite cache controls according to the configured cache mode.
6. Rename MCP tools into Claude-compatible PascalCase form, with response names mapped back to the host.
7. Apply eligible server-side safety fallback, restore stored fallback boundaries and, in OpenCode 1, use replay-safe client recovery if a response still refuses.
8. Compute final-body `cch`, the billing signature, from the fully shaped request using the signer's canonicalization: reset the billing placeholder and normalize the model/token-limit fields before hashing.

The sanitizer is anchor-based: it removes paragraphs containing known OpenCode documentation/source anchors, applies a small set of inline replacements and preserves the remaining prompt, including user/project instructions, tool policy, environment context and file paths.

Model-family normalization supplies [adaptive thinking and effort](models.md#adaptive-thinking-and-effort). Billing metadata uses the Claude Code identity string and version bundled with the plugin. `cc_prompt_id` identifies the user turn across tool-loop requests, and `cc_prev_req` records the previous request in that lineage. OpenCode 2 registers an Anthropic provider source with the host and uses the shared request transform, instead of OpenCode 1's auth-loader fetch wrapper.

Pi replaces the Anthropic provider implementation and converts its transcript, tools and system prompt to the same signed Claude-compatible request shape. When the converter recognizes Pi's standard documentation section, that paragraph is moved into a separate cached block before the first user's text. If the section layout is unrecognized, the prompt is moved as a whole rather than placing the documentation in top-level `system[]`, where Anthropic rejects it. Tool replay and origin-aware thinking-signature filtering preserve compatible Anthropic thinking and remove incompatible OpenAI reasoning signatures.

API-key/proxy sends have a separate policy: proxy header/model overrides apply there, while OAuth-only fallback fields and persona betas are removed. These controls do not turn an API-key route into subscription OAuth. See [environment overrides](environment.md#api-endpoint-and-proxy-routes).

## Safety fallback (OpenCode 1)

By default, Fable 5, Fable 5.1, Opus 5 and Opus 5.5 requests authenticated with OAuth opt into Anthropic's server-side safety fallback. The plugin sends `fallbacks: "default"` with `server-side-fallback-2026-07-01`, preserves fallback conversation boundaries in OpenCode history and reports handoffs/restoration in the sidebar or Desktop. Follow-up requests may remain on Anthropic's selected model for about one hour.

If a response from one of those models still ends in refusal, OpenCode 1 starts a deterministic recovery through `claude-opus-4-8`. After **10 successful Opus 4.8 responses** (not ten attempted requests), it prewarms the originally selected model without server-fallback opt-in and returns to that model. A refused response that already completed a tool call keeps the call/result rather than replaying the tool. Recovery state is separate per session and requested model family. Mythos and Sonnet are outside this refusal-recovery gate.

To bypass the server policy and use client recovery from the first refusal, start OpenCode 1 with:

```sh
OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy opencode
```

Unset the variable and restart to return to server-first policy with client recovery as its backstop. Recovery keeps the session's assigned OAuth account through the temporary model switch and the source-model prewarm. Custom API-key routes receive neither the OAuth fallback beta nor the body field.

### OpenCode 2 boundary

OpenCode 2 applies server-side fallback and response-boundary rewriting in its Anthropic provider integration. It does not run OpenCode 1's 10-response client recovery. `OPENCODE_ANTHROPIC_AUTH_CONTENT_FILTER_FALLBACK` controls the server opt-in: `legacy` disables it without adding client recovery. The OpenCode 1 variable `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE` is not an OpenCode 2 recovery switch.

## Implementation

- [OpenCode wire shaping and sanitizer](../packages/opencode/src/transform.ts)
- [OpenCode 1 dispatch, lineage and recovery](../packages/opencode/src/index.ts)
- [Server fallback boundaries](../packages/opencode/src/server-fallback.ts)
- [Deterministic recovery state](../packages/opencode/src/fable-fallback.ts)
- [OpenCode 2 wire options](../packages/opencode/src/v2/wire.ts) and [adapter](../packages/opencode/src/v2/adapter.ts)
- [Pi conversion](../packages/pi/src/convert.ts) and [transcript replay](../packages/pi/src/transcript.ts)
- [Final-body signing](../packages/core/src/cch.ts)
