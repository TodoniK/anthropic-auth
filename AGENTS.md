# Agent Notes

## Captured system prompts

The `captures/` directory is for local system-prompt captures from Claude Code and OpenCode via mitmproxy HTTPS interception. Capture artifacts are ignored by git; use them locally to verify proxy transform accuracy and understand what each tool sends to the Anthropic API.

- **Capture traffic**: `./scripts/capture-with-mitmproxy.sh -o <name>.flow -- <command>`
- **Extract prompt**: `bun run extract <name>.flow -o captures/<tool>-v<version>.txt`

Captures and `.flow` files are git-ignored and can contain personal data. Before sharing any part of one, replace usernames in paths, OAuth tokens, session IDs and org or account UUIDs with obviously fake placeholders such as `/Users/REDACTED`, `sk-ant-REDACTED`, `ses_REDACTED` and `00000000-0000-0000-0000-000000000000`.
