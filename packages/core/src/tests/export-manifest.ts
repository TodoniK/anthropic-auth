// Only these values are public and stable; other exports support OpenCode and Pi internally.
export const PUBLIC_CORE_VALUES = [
  'resolveClaudeCodeIdentity',
  'buildBillingHeaderValue',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_IDENTITY',
  'applyClaudeCodeMetadata',
  'applyClaudeCodeHeaders',
  'signRequestBody',
  'orderClaudeCodeBody',
] as const
